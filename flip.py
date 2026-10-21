#!/usr/bin/env python3
"""
Motor de análise de flips do Trading Post do Guild Wars 2.

Fontes de dados:
  - DataWars2 (api.datawars2.ie): preços, unidades vendidas/compradas (1d/7d)
    e histórico hora a hora de cada item.
  - API oficial (api.guildwars2.com): preço atual, em tempo real, dos candidatos.

A interface fica em servidor.py (rodar.bat). Este arquivo também roda sozinho no terminal:
  python flip.py --ouro 300
"""
import argparse
import csv
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

# No .exe (PyInstaller) os dados ficam ao lado do executável; rodando o .py, ao lado do script
BASE = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CACHE = BASE / "cache"
RELATORIOS = BASE / "relatorios"
CONFIG = BASE / "config.json"

DW2 = "https://api.datawars2.ie/gw2"
OFICIAL = "https://api.guildwars2.com/v2"
UA = "flip-gw2/1.0 (analise pessoal)"

CAMPOS_BULK = [
    "id", "name", "chat_link", "rarity", "item_type", "img_official",
    "buy_price", "sell_price", "buy_quantity", "sell_quantity",
    "1d_buy_sold", "1d_sell_sold", "7d_buy_sold", "7d_sell_sold",
    "7d_buy_price_avg", "7d_sell_price_avg",
]

PADRAO = {
    "ouro_disponivel": 100,          # capital total para flip, em ouro
    "reserva": 0.20,                 # parte do capital que o plano deixa livre
    "max_itens_plano": 0,            # máximo de itens no plano (0 = sem limite; cresce com o ouro)
    "fracao_max_por_item": 0.10,     # no máximo 10% do capital em um único item
    "roi_min": 0.08,                 # lucro líquido mínimo de 8% sobre o custo
    "roi_max": 2.50,                 # ROI acima disso costuma ser armadilha (item parado)
    "lucro_min_por_flip_cobre": 1000,  # ignora flips que rendem menos de 10s no total
    "volume_min_dia": 10,            # unidades/dia mínimas em cada lado (compra e venda)
    "fatia_max_do_volume": 0.10,     # não comprar mais que 10% do que o mercado gira por dia
    "captura_estimada": 0.25,        # fração do fluxo que você captura (há outros flippers)
    "ciclo_max_dias": 3,             # tempo máximo estimado para comprar + vender
    "max_horas_sem_venda": 6,        # descarta se ninguém comprou de listagens há mais que isso
    "max_horas_sem_compra": 12,      # descarta se nenhuma buy order foi preenchida há mais que isso
    "janela_regularidade_horas": 72,
    "regularidade_min": 0.40,        # % mínima de horas (na janela) com pelo menos uma venda
    "candidatos_historico": 80,      # quantos itens analisar a fundo (histórico por hora)
    "top": 25,
    "cache_bulk_min": 10,
    "cache_historico_min": 30,
    "semanas_dia": 26,               # semanas de histórico diário para o padrão por dia da semana
    "cache_diario_min": 720,
}

ORDEM_VEREDITO = {"recomendado": 0, "cautela": 1, "arriscado": 2}


# ----------------------------------------------------------------------------
# Rede e cache
# ----------------------------------------------------------------------------

def baixar_json(url, tentativas=3):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    for i in range(tentativas):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if i == tentativas - 1:
                raise RuntimeError(f"falha ao baixar {url}: {e}") from e
            time.sleep(2 * (i + 1))


def com_cache(nome, max_idade_min, buscar, usar_cache=True):
    CACHE.mkdir(exist_ok=True)
    arq = CACHE / nome
    if usar_cache and arq.exists() and time.time() - arq.stat().st_mtime < max_idade_min * 60:
        return json.loads(arq.read_text(encoding="utf-8"))
    dados = buscar()
    arq.write_text(json.dumps(dados), encoding="utf-8")
    return dados


# ----------------------------------------------------------------------------
# Regras do Trading Post
# ----------------------------------------------------------------------------

def _arred(x):
    return int(x + 0.5)


def taxas(venda):
    """Taxa de listagem (5%, paga ao listar) e de câmbio (10%, na venda). Mínimo 1c cada."""
    return max(1, _arred(venda * 0.05)), max(1, _arred(venda * 0.10))


def lucro_unitario(compra, venda):
    listagem, cambio = taxas(venda)
    return venda - listagem - cambio - compra


def preco_minimo(compra):
    """Menor preço de venda que não dá prejuízo, já com as taxas."""
    p = max(1, int(compra / 0.85))
    while lucro_unitario(compra, p) < 0:
        p += 1
    return p


# ----------------------------------------------------------------------------
# Análise
# ----------------------------------------------------------------------------

def avaliar(item, cfg):
    """Métricas de margem e giro a partir de preço atual + volumes de 1d/7d.
    Retorna None se o item não passa nos filtros básicos."""
    bp, sp = item.get("buy_price") or 0, item.get("sell_price") or 0
    if bp <= 0 or sp <= 0:
        return None
    compra, venda = bp + 1, sp - 1          # supera a maior oferta e a menor listagem em 1c
    lu = lucro_unitario(compra, venda)
    if lu <= 0:
        return None
    roi = lu / compra
    if not (cfg["roi_min"] <= roi <= cfg["roi_max"]):
        return None

    # Ritmo conservador: o menor entre a média de 7 dias e as últimas 24h
    vendas_dia = min((item.get("7d_sell_sold") or 0) / 7, item.get("1d_sell_sold") or 0)
    compras_dia = min((item.get("7d_buy_sold") or 0) / 7, item.get("1d_buy_sold") or 0)
    if min(vendas_dia, compras_dia) < cfg["volume_min_dia"]:
        return None

    listagem, _ = taxas(venda)
    custo_un = compra + listagem
    capital = cfg["ouro_disponivel"] * 10000
    qtd_capital = int(capital * cfg["fracao_max_por_item"] // custo_un)
    qtd_volume = max(1, int(cfg["fatia_max_do_volume"] * min(vendas_dia, compras_dia)))
    qtd = min(qtd_capital, qtd_volume)
    if qtd < 1:
        return None

    cap = cfg["captura_estimada"]
    dias_compra = qtd / (compras_dia * cap)
    dias_venda = qtd / (vendas_dia * cap)
    ciclo = dias_compra + dias_venda
    lucro_total = lu * qtd
    if lucro_total < cfg["lucro_min_por_flip_cobre"] or ciclo > cfg["ciclo_max_dias"]:
        return None

    vendas_7d_dia = (item.get("7d_sell_sold") or 0) / 7
    return {
        "id": item["id"],
        "nome": item.get("name") or f"#{item['id']}",
        "chat_link": item.get("chat_link") or "",
        "img": item.get("img_official") or "",
        "raridade": item.get("rarity") or "",
        "tipo": item.get("item_type") or "",
        "compra": compra,
        "venda": venda,
        "lucro_un": lu,
        "roi": roi,
        "qtd": qtd,
        "custo_compra": compra * qtd,
        "taxa_listagem": listagem * qtd,
        "investimento": custo_un * qtd,
        "lucro_total": lucro_total,
        "vendas_dia": vendas_dia,
        "compras_dia": compras_dia,
        "horas_compra": dias_compra * 24,
        "horas_venda": dias_venda * 24,
        "ciclo_dias": ciclo,
        "ouro_dia": lucro_total / ciclo,
        "tendencia_volume": (item.get("1d_sell_sold") or 0) / vendas_7d_dia if vendas_7d_dia else 0,
        "alertas": [],
    }


def _data(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def analisar_historico(r, hist, agora, cfg):
    """Recência e regularidade das vendas, margem típica e tendências (dados por hora)."""
    regs = sorted(hist, key=lambda x: x["date"])
    datas = [_data(x["date"]) for x in regs]

    def horas_desde_ultimo(campo):
        ds = [d for d, x in zip(datas, regs) if (x.get(campo) or 0) > 0]
        if not ds:
            return 999.0
        return max(0.0, (agora - (max(ds) + timedelta(hours=1))).total_seconds() / 3600)

    r["horas_sem_venda"] = horas_desde_ultimo("sell_sold")
    r["horas_sem_compra"] = horas_desde_ultimo("buy_sold")

    jan = cfg["janela_regularidade_horas"]
    inicio = agora - timedelta(hours=jan)
    janela = [x for d, x in zip(datas, regs) if d >= inicio]
    r["reg_venda"] = min(1.0, sum(1 for x in janela if (x.get("sell_sold") or 0) > 0) / jan)
    r["reg_compra"] = min(1.0, sum(1 for x in janela if (x.get("buy_sold") or 0) > 0) / jan)
    r["regularidade"] = min(r["reg_venda"], r["reg_compra"])

    # Margem típica: lucro que o flip daria com os preços médios de cada hora da janela
    margens = [
        lucro_unitario(x["buy_price_avg"] + 1, x["sell_price_avg"] - 1)
        for x in janela if x.get("buy_price_avg") and x.get("sell_price_avg")
    ]
    r["lucro_tipico"] = statistics.median(margens) if margens else None

    def media(campo, de, ate):
        v = [x[campo] for d, x in zip(datas, regs) if de <= d < ate and x.get(campo)]
        return statistics.mean(v) if v else None

    ontem = agora - timedelta(hours=24)
    longe = datetime.min.replace(tzinfo=timezone.utc)

    # Preço de venda: últimas 24h vs. os dias anteriores
    p_rec, p_ant = media("sell_price_avg", ontem, agora + timedelta(hours=1)), media("sell_price_avg", longe, ontem)
    r["tendencia_preco"] = p_rec / p_ant - 1 if p_rec and p_ant else 0.0

    # Estoque à venda: últimas 24h vs. as primeiras 24h do histórico (~7 dias atrás)
    primeiro_dia = datas[0] + timedelta(hours=24) if datas else agora
    e_rec, e_ant = media("sell_quantity_avg", ontem, agora + timedelta(hours=1)), media("sell_quantity_avg", longe, primeiro_dia)
    r["variacao_estoque"] = e_rec / e_ant - 1 if e_rec and e_ant else 0.0
    return r


def _indices_dia(regs, campo):
    """Desvio médio de cada dia da semana (0=segunda) em relação aos 7 dias em volta dele."""
    vals = [x.get(campo) or 0 for x in regs]
    grupos = [[] for _ in range(7)]
    for i, (x, v) in enumerate(zip(regs, vals)):
        viz = [y for y in vals[max(0, i - 3):i + 4] if y > 0]
        if v > 0 and viz:
            grupos[_data(x["date"]).weekday()].append(v / statistics.mean(viz) - 1)
    return [statistics.mean(g) if g else 0.0 for g in grupos]


def _simular_horas(qtd, taxa_dia, fatores, inicio):
    """Horas para negociar `qtd` unidades com uma taxa diária que muda conforme o dia da semana."""
    t, restante, horas = inicio, qtd, 0.0
    while restante > 0 and horas < 24 * 60:
        por_hora = taxa_dia * fatores[t.weekday()] / 24
        if por_hora <= 0:
            return 999.0
        if restante <= por_hora:
            return horas + restante / por_hora
        restante -= por_hora
        horas += 1
        t += timedelta(hours=1)
    return horas


def padrao_semana(diario, agora, cfg):
    """Desvios de preço e de movimento por dia da semana (dia do jogo = UTC).
    Retorna None se não houver histórico suficiente."""
    hoje = agora.date()
    regs = sorted((x for x in diario if _data(x["date"]).date() < hoje), key=lambda x: x["date"])
    regs = regs[-cfg["semanas_dia"] * 7:]
    if len(regs) < 56:
        return None

    meio = len(regs) // 2
    compra, venda = _indices_dia(regs, "buy_price_avg"), _indices_dia(regs, "sell_price_avg")
    compra_h = (_indices_dia(regs[:meio], "buy_price_avg"), _indices_dia(regs[meio:], "buy_price_avg"))
    venda_h = (_indices_dia(regs[:meio], "sell_price_avg"), _indices_dia(regs[meio:], "sell_price_avg"))

    # Ritmo de negócios por dia (normalizado para média 1)
    def fatores(campo):
        f = [1 + v for v in _indices_dia(regs, campo)]
        m = statistics.mean(f) or 1
        return [max(0.2, x / m) for x in f]

    barato = min(range(7), key=lambda d: compra[d])
    caro = max(range(7), key=lambda d: venda[d])
    return {
        "semanas": len(regs) // 7,
        "compra": compra, "venda": venda,
        "f_venda": fatores("sell_sold"), "f_compra": fatores("buy_sold"),
        "barato": barato, "caro": caro,
        # "Costuma se repetir" só quando o efeito aparece nas duas metades do período
        "barato_conf": compra[barato] <= -0.015 and all(h[barato] <= -0.01 for h in compra_h),
        "caro_conf": venda[caro] >= 0.015 and all(h[caro] >= 0.01 for h in venda_h),
    }


def analisar_dias(r, diario, agora, cfg):
    """Dia da semana mais barato para comprar e mais caro para vender,
    e tempo estimado ajustado pelo movimento de cada dia."""
    r["dias"] = None
    p = padrao_semana(diario, agora, cfg)
    if not p:
        return r
    compra, venda, f_venda, f_compra = p["compra"], p["venda"], p["f_venda"], p["f_compra"]
    cap = cfg["captura_estimada"]
    r["horas_compra"] = _simular_horas(r["qtd"], r["compras_dia"] * cap, f_compra, agora)
    r["horas_venda"] = _simular_horas(r["qtd"], r["vendas_dia"] * cap, f_venda,
                                      agora + timedelta(hours=r["horas_compra"]))
    r["ciclo_dias"] = (r["horas_compra"] + r["horas_venda"]) / 24
    r["ouro_dia"] = r["lucro_total"] / r["ciclo_dias"]

    d_hoje = agora.date().weekday()
    barato, caro = p["barato"], p["caro"]
    barato_conf, caro_conf = p["barato_conf"], p["caro_conf"]

    # Preço estimado naquele dia, partindo do preço de hoje
    preco_compra = _arred(r["compra"] * (1 + compra[barato]) / (1 + compra[d_hoje]))
    preco_venda = _arred(r["venda"] * (1 + venda[caro]) / (1 + venda[d_hoje]))
    r["dias"] = {
        "hoje": d_hoje,
        "semanas": p["semanas"],
        "barato": barato, "barato_pct": compra[barato], "barato_preco": preco_compra, "barato_conf": barato_conf,
        "dias_ate_barato": (barato - d_hoje) % 7,
        "caro": caro, "caro_pct": venda[caro], "caro_preco": preco_venda, "caro_conf": caro_conf,
        "dias_ate_caro": (caro - d_hoje) % 7,
        "caro_lucro_extra": (lucro_unitario(r["compra"], preco_venda) - r["lucro_un"]) * r["qtd"],
        "fds_vendas": (f_venda[5] + f_venda[6]) / 2 - 1,
        "venda_por_dia": venda,
        "compra_por_dia": compra,
        "vendas_por_dia": [f - 1 for f in f_venda],
    }
    return r


def classificar(r):
    """Alertas em linguagem simples, motivos a favor e o veredito final."""
    alertas, motivos = [], []
    lt = r.get("lucro_tipico")

    if lt is not None and lt <= 0:
        alertas.append({"nivel": "risco", "texto": "Normalmente este item não dá lucro no flip — o spread de agora é exceção."})
    elif lt is not None and r["lucro_un"] > 2 * lt:
        alertas.append({"nivel": "atencao", "texto":
                        f"A margem hoje está {r['lucro_un'] / lt:.1f}x maior que o normal. "
                        f"Se voltar ao normal, o lucro cai para cerca de {moeda(lt * r['qtd'])}."})
    if r["roi"] > 1:
        alertas.append({"nivel": "risco", "texto": f"Margem alta demais ({r['roi']:.0%}). Confira as ofertas no jogo antes de comprar."})
    if r["tendencia_preco"] < -0.08:
        alertas.append({"nivel": "atencao", "texto": f"O preço de venda caiu {-r['tendencia_preco']:.0%} nas últimas 24h."})
    if r["tendencia_volume"] and r["tendencia_volume"] < 0.6:
        alertas.append({"nivel": "atencao", "texto": f"Vendeu {1 - r['tendencia_volume']:.0%} menos hoje que a média da semana."})
    if r["variacao_estoque"] > 0.25:
        alertas.append({"nivel": "atencao", "texto": f"Há {r['variacao_estoque']:.0%} mais unidades à venda que há uma semana — mais concorrência."})

    reg = r["regularidade"]
    if reg >= 0.8:
        motivos.append(f"Vende o tempo todo: teve negócio em {reg:.0%} das últimas horas.")
    else:
        motivos.append(f"Vende com frequência: teve negócio em {reg:.0%} das últimas horas.")
    motivos.append(f"Última venda há {fmt_horas(r['horas_sem_venda'])}.")
    motivos.append(f"O mercado gira ~{r['vendas_dia']:,.0f} unidades/dia; você compra só {r['qtd'] / r['vendas_dia']:.0%} disso.".replace(",", "."))
    motivos.append(f"Lucro de {r['roi']:.0%} sobre o que você gasta, já descontadas as taxas.")
    if lt is not None and lt > 0 and r["lucro_un"] <= 1.3 * lt:
        motivos.append("Essa margem é a normal do item — não é um pico passageiro.")

    n_risco = sum(1 for a in alertas if a["nivel"] == "risco")
    n_atencao = len(alertas) - n_risco
    if n_risco or n_atencao >= 3:
        veredito = "arriscado"
    elif n_atencao:
        veredito = "cautela"
    else:
        veredito = "recomendado"

    r["alertas"], r["motivos"], r["veredito"] = alertas, motivos, veredito
    r["score"] = r["ouro_dia"] * reg * (0.5 if veredito == "arriscado" else 1)
    return r


def montar_plano(res, cfg):
    """Escolhe os itens para o capital: primeiro os recomendados, depois os de cautela."""
    capital = cfg["ouro_disponivel"] * 10000
    orcamento = capital * (1 - cfg["reserva"])
    ordem = sorted((r for r in res if r["veredito"] != "arriscado"),
                   key=lambda r: (ORDEM_VEREDITO[r["veredito"]], -r["score"]))
    escolhidos, gasto = [], 0
    for r in ordem:
        if cfg["max_itens_plano"] and len(escolhidos) >= cfg["max_itens_plano"]:
            break
        if gasto + r["investimento"] <= orcamento:
            escolhidos.append(r)
            gasto += r["investimento"]
    return {
        "ids": [r["id"] for r in escolhidos],
        "capital": capital,
        "investimento": gasto,
        "lucro": sum(r["lucro_total"] for r in escolhidos),
        "livre": capital - gasto,
        "ciclo_max_horas": max((r["ciclo_dias"] * 24 for r in escolhidos), default=0),
    }


# ----------------------------------------------------------------------------
# Coleta
# ----------------------------------------------------------------------------

def carregar_bulk(cfg, usar_cache):
    url = f"{DW2}/v1/items/json?fields={','.join(CAMPOS_BULK)}"
    return com_cache("bulk_v2.json", cfg["cache_bulk_min"], lambda: baixar_json(url), usar_cache)


def precos_oficiais(ids):
    precos = {}
    ids = list(ids)
    for i in range(0, len(ids), 200):
        lote = ",".join(map(str, ids[i:i + 200]))
        for p in baixar_json(f"{OFICIAL}/commerce/prices?ids={lote}"):
            precos[p["id"]] = (p["buys"]["unit_price"], p["sells"]["unit_price"],
                               p["buys"]["quantity"], p["sells"]["quantity"])
    return precos


def historico(item_id, cfg, usar_cache):
    inicio = (datetime.now(timezone.utc) - timedelta(days=8)).strftime("%Y-%m-%d")
    url = f"{DW2}/v2/history/hourly/json?itemID={item_id}&start={inicio}"
    return com_cache(f"hist_{item_id}.json", cfg["cache_historico_min"], lambda: baixar_json(url), usar_cache)


def historico_diario(item_id, cfg, usar_cache):
    inicio = (datetime.now(timezone.utc) - timedelta(days=cfg["semanas_dia"] * 7 + 10)).strftime("%Y-%m-%d")
    url = f"{DW2}/v2/history/json?itemID={item_id}&start={inicio}"
    return com_cache(f"dia_{item_id}.json", cfg["cache_diario_min"], lambda: baixar_json(url), usar_cache)


def executar(cfg, usar_cache=True, log=print):
    """Roda a análise completa. Retorna (resultados ordenados, plano, estatísticas)."""
    log("Baixando dados do Trading Post (DataWars2)...")
    itens = carregar_bulk(cfg, usar_cache)
    por_id = {it["id"]: it for it in itens}

    basicos = [r for r in (avaliar(it, cfg) for it in itens) if r]
    basicos.sort(key=lambda r: r["ouro_dia"], reverse=True)
    candidatos = basicos[:cfg["candidatos_historico"]]
    stats = {"total": len(itens), "basico": len(basicos)}

    log(f"Confirmando preços atuais de {len(candidatos)} candidatos na API oficial...")
    precos = precos_oficiais(r["id"] for r in candidatos)
    atualizados = []
    for r in candidatos:
        if r["id"] not in precos:
            continue
        it = dict(por_id[r["id"]])
        it["buy_price"], it["sell_price"], it["buy_quantity"], it["sell_quantity"] = precos[r["id"]]
        novo = avaliar(it, cfg)
        if novo:
            atualizados.append(novo)

    log(f"Analisando histórico hora a hora de {len(atualizados)} itens...")
    with ThreadPoolExecutor(max_workers=4) as ex:
        hists = list(ex.map(lambda r: historico(r["id"], cfg, usar_cache), atualizados))
    stats["fundo"] = len(atualizados)

    agora = datetime.now(timezone.utc)
    res = []
    for r, h in zip(atualizados, hists):
        analisar_historico(r, h, agora, cfg)
        if r["horas_sem_venda"] > cfg["max_horas_sem_venda"]:
            continue
        if r["horas_sem_compra"] > cfg["max_horas_sem_compra"]:
            continue
        if r["regularidade"] < cfg["regularidade_min"]:
            continue
        res.append(r)

    log(f"Analisando os dias da semana de {len(res)} itens ({cfg['semanas_dia']} semanas)...")
    with ThreadPoolExecutor(max_workers=4) as ex:
        diarios = list(ex.map(lambda r: historico_diario(r["id"], cfg, usar_cache), res))
    for r, d in zip(res, diarios):
        analisar_dias(r, d, agora, cfg)
        classificar(r)

    plano = montar_plano(res, cfg)
    no_plano = {i: n for n, i in enumerate(plano["ids"])}
    for r in res:
        r["no_plano"] = r["id"] in no_plano
    # Itens do plano primeiro (na ordem do plano), depois o resto por veredito e score
    res.sort(key=lambda r: (0, no_plano[r["id"]]) if r["no_plano"]
             else (1, ORDEM_VEREDITO[r["veredito"]], -r["score"]))
    stats["aprovados"] = len(res)
    return res, plano, stats


def carregar_config(**sobrescrever):
    cfg = dict(PADRAO)
    if CONFIG.exists():
        cfg.update(json.loads(CONFIG.read_text(encoding="utf-8")))
    else:
        CONFIG.write_text(json.dumps(PADRAO, indent=2, ensure_ascii=False), encoding="utf-8")
    cfg.update({k: v for k, v in sobrescrever.items() if v is not None})
    return cfg


# ----------------------------------------------------------------------------
# Terminal
# ----------------------------------------------------------------------------

def moeda(c):
    neg, c = c < 0, abs(int(round(c)))
    g, resto = divmod(c, 10000)
    s, cc = divmod(resto, 100)
    if g:
        txt = f"{g}g {s:02d}s {cc:02d}c"
    elif s:
        txt = f"{s}s {cc:02d}c"
    else:
        txt = f"{cc}c"
    return ("-" if neg else "") + txt


def fmt_horas(h):
    if h >= 999:
        return "mais de 7 dias"
    if h < 1:
        return "menos de 1h"
    return f"{h:.0f}h" if h < 48 else f"{h / 24:.1f} dias"


COLUNAS_CSV = ["id", "nome", "veredito", "no_plano", "chat_link", "compra", "venda", "lucro_un", "roi", "qtd",
               "investimento", "lucro_total", "ciclo_dias", "ouro_dia", "score", "vendas_dia", "compras_dia",
               "horas_sem_venda", "horas_sem_compra", "reg_venda", "reg_compra", "lucro_tipico",
               "tendencia_preco", "tendencia_volume", "variacao_estoque"]


def salvar_csv(res, caminho):
    with open(caminho, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(COLUNAS_CSV + ["alertas"])
        for r in res:
            w.writerow([r.get(c) for c in COLUNAS_CSV] + [" | ".join(a["texto"] for a in r["alertas"])])


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Analisador de flips do Trading Post do GW2")
    ap.add_argument("--ouro", type=float, help="capital disponível em ouro (sobrescreve config.json)")
    ap.add_argument("--top", type=int, help="quantos itens mostrar")
    ap.add_argument("--sem-cache", action="store_true", help="ignora o cache e baixa tudo de novo")
    args = ap.parse_args()
    cfg = carregar_config(ouro_disponivel=args.ouro, top=args.top)

    res, plano, stats = executar(cfg, usar_cache=not args.sem_cache)

    print(f"\n{stats['total']} itens no TP · {stats['aprovados']} aprovados · "
          f"plano: {len(plano['ids'])} itens, investe {moeda(plano['investimento'])}, lucro {moeda(plano['lucro'])}\n")
    for i, r in enumerate(res[:cfg["top"]], 1):
        marca = "*" if r["no_plano"] else " "
        print(f"{i:>2}{marca} [{r['veredito']:<11}] {r['nome'][:30]:<30} {r['qtd']:>5} x  compra {moeda(r['compra']):>11}"
              f"  venda {moeda(r['venda']):>11}  lucro {moeda(r['lucro_total']):>12}  em ~{fmt_horas(r['ciclo_dias'] * 24)}")

    RELATORIOS.mkdir(exist_ok=True)
    arq = RELATORIOS / f"flips_{datetime.now():%Y%m%d_%H%M}.csv"
    salvar_csv(res, arq)
    print(f"\nPlanilha: {arq}")


if __name__ == "__main__":
    main()
