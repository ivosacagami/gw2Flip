"""
Ordens que você colocou no jogo (dados/ordens.json) e histórico de flips finalizados
(dados/historico.jsonl — uma linha por flip, só acrescentada, nunca reescrita).
"""
import json
import os
import secrets
import threading
from datetime import datetime, timezone

import flip

DADOS = flip.BASE / "dados"
ARQ_ORDENS = DADOS / "ordens.json"
ARQ_HIST = DADOS / "historico.jsonl"
_trava = threading.Lock()


def _agora():
    return datetime.now(timezone.utc)


def _carregar():
    if not ARQ_ORDENS.exists():
        return []
    try:
        return json.loads(ARQ_ORDENS.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _salvar(ordens):
    DADOS.mkdir(exist_ok=True)
    tmp = ARQ_ORDENS.with_suffix(".tmp")
    tmp.write_text(json.dumps(ordens, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, ARQ_ORDENS)


def _registrar(linha):
    DADOS.mkdir(exist_ok=True)
    with open(ARQ_HIST, "a", encoding="utf-8") as f:
        f.write(json.dumps(linha, ensure_ascii=False, separators=(",", ":")) + "\n")


def _int_pos(v, nome):
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise ValueError(f"{nome} inválido")
    if n <= 0:
        raise ValueError(f"{nome} precisa ser maior que zero")
    return n


def adicionar(d):
    ordem = {
        "uid": secrets.token_hex(4),
        "id": _int_pos(d.get("id"), "item"),
        "nome": str(d.get("nome", ""))[:120],
        "img": str(d.get("img", ""))[:300],
        "chat_link": str(d.get("chat_link", ""))[:60],
        "qtd": _int_pos(d.get("qtd"), "quantidade"),
        "compra": _int_pos(d.get("compra"), "preço de compra"),
        "venda_sugerida": _int_pos(d.get("venda"), "preço de venda"),
        "lucro_previsto": int(d.get("lucro_total") or 0),
        "horas_compra_prev": round(float(d.get("horas_compra") or 0), 1),
        "horas_venda_prev": round(float(d.get("horas_venda") or 0), 1),
        "veredito": str(d.get("veredito", ""))[:20],
        "criada": _agora().isoformat(timespec="seconds"),
        "comprado_em": None,
        "status": "comprando",
    }
    with _trava:
        ordens = _carregar()
        ordens.append(ordem)
        _salvar(ordens)
    return ordem


def atualizar(uid, d):
    """acao: comprado | vendi (preco, qtd) | cancelei | desfazer."""
    acao = d.get("acao")
    with _trava:
        ordens = _carregar()
        o = next((x for x in ordens if x["uid"] == uid), None)
        if not o:
            raise KeyError("Ordem não encontrada.")
        agora = _agora().isoformat(timespec="seconds")

        if acao == "comprado":
            o["status"], o["comprado_em"] = "vendendo", agora
        elif acao == "vendi":
            preco = _int_pos(d.get("preco") or o["venda_sugerida"], "preço de venda")
            qtd = min(_int_pos(d.get("qtd") or o["qtd"], "quantidade"), o["qtd"])
            _registrar({
                "fim": "vendido", "id": o["id"], "nome": o["nome"], "qtd": qtd,
                "compra": o["compra"], "venda_sugerida": o["venda_sugerida"], "venda": preco,
                "lucro_previsto": round(o["lucro_previsto"] * qtd / o["qtd"]),
                "lucro": flip.lucro_unitario(o["compra"], preco) * qtd,
                "horas_compra_prev": o["horas_compra_prev"], "horas_venda_prev": o["horas_venda_prev"],
                "veredito": o["veredito"], "criada": o["criada"], "comprado_em": o["comprado_em"], "vendido_em": agora,
            })
            o["qtd"] -= qtd
            o["lucro_previsto"] -= round(o["lucro_previsto"] * qtd / (o["qtd"] + qtd))
            if o["status"] == "comprando":
                o["status"], o["comprado_em"] = "vendendo", agora
            if o["qtd"] <= 0:
                ordens.remove(o)
        elif acao == "cancelei":
            _registrar({
                "fim": "cancelado", "id": o["id"], "nome": o["nome"], "qtd": o["qtd"],
                "compra": o["compra"], "venda_sugerida": o["venda_sugerida"],
                "lucro_previsto": o["lucro_previsto"], "status_ao_cancelar": o["status"],
                "veredito": o["veredito"], "criada": o["criada"], "comprado_em": o["comprado_em"], "cancelado_em": agora,
            })
            ordens.remove(o)
        elif acao == "desfazer":  # marcou "já coloquei" por engano: some sem ir para o histórico
            ordens.remove(o)
        else:
            raise ValueError("Ação inválida.")
        _salvar(ordens)


def resumo_historico():
    lucro = flips = cancelados = 0
    desde = None
    if ARQ_HIST.exists():
        with open(ARQ_HIST, encoding="utf-8") as f:
            for linha in f:
                try:
                    h = json.loads(linha)
                except json.JSONDecodeError:
                    continue
                desde = desde or h.get("criada")
                if h.get("fim") == "vendido":
                    lucro += h.get("lucro", 0)
                    flips += 1
                else:
                    cancelados += 1
    return {"lucro": lucro, "vendas": flips, "cancelados": cancelados, "desde": desde}


def listar(cfg):
    """Ordens ativas com o preço de agora, o mínimo sem prejuízo e o dia mais caro da semana."""
    ordens = _carregar()
    agora = _agora()
    precos, erro = {}, None
    if ordens:
        try:
            precos = flip.precos_oficiais({o["id"] for o in ordens})
        except RuntimeError:
            erro ="Não consegui buscar os preços de agora. Mostrando só o que foi gravado."
    hoje = agora.date().weekday()

    for o in ordens:
        o["minimo"] = flip.preco_minimo(o["compra"])
        o["idade_horas"] = (agora - datetime.fromisoformat(o["criada"])).total_seconds() / 3600
        p = precos.get(o["id"])
        if p:
            maior_compra, menor_venda = p[0], p[1]
            o["maior_compra"] = maior_compra
            o["venda_agora"] = max(1, menor_venda - 1) if menor_venda else None
            o["superada"] = o["status"] == "comprando" and maior_compra > o["compra"]
            o["lucro_agora"] = flip.lucro_unitario(o["compra"], o["venda_agora"]) * o["qtd"] if o["venda_agora"] else None
        try:
            padrao = flip.padrao_semana(flip.historico_diario(o["id"], cfg, True), agora, cfg)
        except RuntimeError:
            padrao = None
        if padrao and padrao["caro_conf"] and o.get("venda_agora"):
            v = padrao["venda"]
            o["dia_caro"] = {
                "dia": padrao["caro"], "pct": v[padrao["caro"]], "hoje": hoje,
                "dias_ate": (padrao["caro"] - hoje) % 7,
                "preco": flip._arred(o["venda_agora"] * (1 + v[padrao["caro"]]) / (1 + v[hoje])),
            }
    return {"ordens": ordens, "resumo": resumo_historico(), "erro": erro}
