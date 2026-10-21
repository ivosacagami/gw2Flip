"use strict";
/*
 * Motor de análise de flips — mesma lógica do flip.py, rodando no navegador.
 * Não acessa rede nem armazenamento: recebe os dados por uma "fonte" (ver dados.js).
 * Datas em milissegundos UTC; dia da semana 0 = segunda (como o Python).
 */
const Motor = (() => {
  const PADRAO = {
    ouro_disponivel: 100,
    reserva: 0.20,                 // parte do capital que o plano deixa livre
    max_itens_plano: 0,            // 0 = sem limite
    fracao_max_por_item: 0.10,
    roi_min: 0.08,
    roi_max: 2.50,
    lucro_min_por_flip_cobre: 1000,
    volume_min_dia: 10,
    fatia_max_do_volume: 0.10,
    captura_estimada: 0.25,
    ciclo_max_dias: 3,
    max_horas_sem_venda: 6,
    max_horas_sem_compra: 12,
    janela_regularidade_horas: 72,
    regularidade_min: 0.40,
    candidatos_historico: 80,
    top: 25,
    cache_bulk_min: 10,
    cache_historico_min: 30,
    semanas_dia: 26,
    cache_diario_min: 720,
  };

  const ORDEM_VEREDITO = { recomendado: 0, cautela: 1, arriscado: 2 };
  const HORA = 3600e3;

  // ---------- utilidades ----------

  const soma = (v) => v.reduce((a, b) => a + b, 0);
  const media = (v) => soma(v) / v.length;
  function mediana(v) {
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const data = (s) => Date.parse(s);
  const diaSemana = (ms) => (new Date(ms).getUTCDay() + 6) % 7;
  const diaUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
  const arred = (x) => Math.trunc(x + 0.5);
  const pct0 = (x) => `${Math.round(x * 100)}%`;

  function moeda(c) {
    const neg = c < 0;
    c = Math.abs(Math.round(c));
    const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cc = c % 100;
    const d2 = (n) => String(n).padStart(2, "0");
    const txt = g ? `${g}g ${d2(s)}s ${d2(cc)}c` : s ? `${s}s ${d2(cc)}c` : `${cc}c`;
    return (neg ? "-" : "") + txt;
  }

  function fmtHoras(h) {
    if (h >= 999) return "mais de 7 dias";
    if (h < 1) return "menos de 1h";
    return h < 48 ? `${Math.round(h)}h` : `${(h / 24).toFixed(1).replace(".", ",")} dias`;
  }

  // ---------- regras do Trading Post ----------

  /** Taxa de listagem (5%, paga ao listar) e de câmbio (10%, na venda). Mínimo 1c cada. */
  const taxas = (venda) => [Math.max(1, arred(venda * 0.05)), Math.max(1, arred(venda * 0.10))];

  function lucroUnitario(compra, venda) {
    const [listagem, cambio] = taxas(venda);
    return venda - listagem - cambio - compra;
  }

  /** Menor preço de venda que não dá prejuízo, já com as taxas. */
  function precoMinimo(compra) {
    let p = Math.max(1, Math.trunc(compra / 0.85));
    while (lucroUnitario(compra, p) < 0) p++;
    return p;
  }

  // ---------- análise ----------

  /** Margem e giro a partir do preço atual + volumes de 1d/7d. null se não passa nos filtros. */
  function avaliar(item, cfg) {
    const bp = item.buy_price || 0, sp = item.sell_price || 0;
    if (bp <= 0 || sp <= 0) return null;
    const compra = bp + 1, venda = sp - 1;
    const lu = lucroUnitario(compra, venda);
    if (lu <= 0) return null;
    const roi = lu / compra;
    if (!(cfg.roi_min <= roi && roi <= cfg.roi_max)) return null;

    // Ritmo conservador: o menor entre a média de 7 dias e as últimas 24h
    const vendasDia = Math.min((item["7d_sell_sold"] || 0) / 7, item["1d_sell_sold"] || 0);
    const comprasDia = Math.min((item["7d_buy_sold"] || 0) / 7, item["1d_buy_sold"] || 0);
    if (Math.min(vendasDia, comprasDia) < cfg.volume_min_dia) return null;

    const [listagem] = taxas(venda);
    const custoUn = compra + listagem;
    const capital = cfg.ouro_disponivel * 10000;
    const qtdCapital = Math.floor((capital * cfg.fracao_max_por_item) / custoUn);
    const qtdVolume = Math.max(1, Math.trunc(cfg.fatia_max_do_volume * Math.min(vendasDia, comprasDia)));
    const qtd = Math.min(qtdCapital, qtdVolume);
    if (qtd < 1) return null;

    const cap = cfg.captura_estimada;
    const diasCompra = qtd / (comprasDia * cap);
    const diasVenda = qtd / (vendasDia * cap);
    const ciclo = diasCompra + diasVenda;
    const lucroTotal = lu * qtd;
    if (lucroTotal < cfg.lucro_min_por_flip_cobre || ciclo > cfg.ciclo_max_dias) return null;

    const vendas7dDia = (item["7d_sell_sold"] || 0) / 7;
    return {
      id: item.id,
      nome: item.name || `#${item.id}`,
      chat_link: item.chat_link || "",
      img: item.img_official || "",
      raridade: item.rarity || "",
      tipo: item.item_type || "",
      compra, venda,
      lucro_un: lu,
      roi, qtd,
      custo_compra: compra * qtd,
      taxa_listagem: listagem * qtd,
      investimento: custoUn * qtd,
      lucro_total: lucroTotal,
      vendas_dia: vendasDia,
      compras_dia: comprasDia,
      horas_compra: diasCompra * 24,
      horas_venda: diasVenda * 24,
      ciclo_dias: ciclo,
      ouro_dia: lucroTotal / ciclo,
      tendencia_volume: vendas7dDia ? (item["1d_sell_sold"] || 0) / vendas7dDia : 0,
      alertas: [],
    };
  }

  /** Recência e regularidade das vendas, margem típica e tendências (dados por hora). */
  function analisarHistorico(r, hist, agora, cfg) {
    const regs = [...hist].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const datas = regs.map((x) => data(x.date));

    const horasDesdeUltimo = (campo) => {
      const ds = datas.filter((d, i) => (regs[i][campo] || 0) > 0);
      if (!ds.length) return 999.0;
      return Math.max(0, (agora - (Math.max(...ds) + HORA)) / HORA);
    };
    r.horas_sem_venda = horasDesdeUltimo("sell_sold");
    r.horas_sem_compra = horasDesdeUltimo("buy_sold");

    const jan = cfg.janela_regularidade_horas;
    const inicio = agora - jan * HORA;
    const janela = regs.filter((x, i) => datas[i] >= inicio);
    r.reg_venda = Math.min(1, janela.filter((x) => (x.sell_sold || 0) > 0).length / jan);
    r.reg_compra = Math.min(1, janela.filter((x) => (x.buy_sold || 0) > 0).length / jan);
    r.regularidade = Math.min(r.reg_venda, r.reg_compra);

    // Margem típica: lucro que o flip daria com os preços médios de cada hora da janela
    const margens = janela
      .filter((x) => x.buy_price_avg && x.sell_price_avg)
      .map((x) => lucroUnitario(x.buy_price_avg + 1, x.sell_price_avg - 1));
    r.lucro_tipico = margens.length ? mediana(margens) : null;

    const mediaEntre = (campo, de, ate) => {
      const v = regs.filter((x, i) => de <= datas[i] && datas[i] < ate && x[campo]).map((x) => x[campo]);
      return v.length ? media(v) : null;
    };
    const ontem = agora - 24 * HORA;

    // Preço de venda: últimas 24h vs. os dias anteriores
    const pRec = mediaEntre("sell_price_avg", ontem, agora + HORA);
    const pAnt = mediaEntre("sell_price_avg", -Infinity, ontem);
    r.tendencia_preco = pRec && pAnt ? pRec / pAnt - 1 : 0;

    // Estoque à venda: últimas 24h vs. as primeiras 24h do histórico (~7 dias atrás)
    const primeiroDia = datas.length ? datas[0] + 24 * HORA : agora;
    const eRec = mediaEntre("sell_quantity_avg", ontem, agora + HORA);
    const eAnt = mediaEntre("sell_quantity_avg", -Infinity, primeiroDia);
    r.variacao_estoque = eRec && eAnt ? eRec / eAnt - 1 : 0;
    return r;
  }

  /** Desvio médio de cada dia da semana (0=segunda) em relação aos 7 dias em volta dele. */
  function indicesDia(regs, campo) {
    const vals = regs.map((x) => x[campo] || 0);
    const grupos = [[], [], [], [], [], [], []];
    regs.forEach((x, i) => {
      const v = vals[i];
      const viz = vals.slice(Math.max(0, i - 3), i + 4).filter((y) => y > 0);
      if (v > 0 && viz.length) grupos[diaSemana(data(x.date))].push(v / media(viz) - 1);
    });
    return grupos.map((g) => (g.length ? media(g) : 0));
  }

  /** Horas para negociar `qtd` unidades com uma taxa diária que muda conforme o dia da semana. */
  function simularHoras(qtd, taxaDia, fatores, inicio) {
    let t = inicio, restante = qtd, horas = 0;
    while (restante > 0 && horas < 24 * 60) {
      const porHora = (taxaDia * fatores[diaSemana(t)]) / 24;
      if (porHora <= 0) return 999.0;
      if (restante <= porHora) return horas + restante / porHora;
      restante -= porHora;
      horas += 1;
      t += HORA;
    }
    return horas;
  }

  const argMin = (v) => v.reduce((m, x, i) => (x < v[m] ? i : m), 0);
  const argMax = (v) => v.reduce((m, x, i) => (x > v[m] ? i : m), 0);

  /** Desvios de preço e de movimento por dia da semana (dia do jogo = UTC). null sem histórico suficiente. */
  function padraoSemana(diario, agora, cfg) {
    const hoje = diaUTC(agora);
    let regs = diario
      .filter((x) => diaUTC(data(x.date)) < hoje)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    regs = regs.slice(-cfg.semanas_dia * 7);
    if (regs.length < 56) return null;

    const meio = regs.length >> 1;
    const compra = indicesDia(regs, "buy_price_avg"), venda = indicesDia(regs, "sell_price_avg");
    const compraH = [indicesDia(regs.slice(0, meio), "buy_price_avg"), indicesDia(regs.slice(meio), "buy_price_avg")];
    const vendaH = [indicesDia(regs.slice(0, meio), "sell_price_avg"), indicesDia(regs.slice(meio), "sell_price_avg")];

    // Ritmo de negócios por dia (normalizado para média 1)
    const fatores = (campo) => {
      const f = indicesDia(regs, campo).map((v) => 1 + v);
      const m = media(f) || 1;
      return f.map((x) => Math.max(0.2, x / m));
    };

    const barato = argMin(compra), caro = argMax(venda);
    return {
      semanas: Math.floor(regs.length / 7),
      compra, venda,
      f_venda: fatores("sell_sold"), f_compra: fatores("buy_sold"),
      barato, caro,
      // "Costuma se repetir" só quando o efeito aparece nas duas metades do período
      barato_conf: compra[barato] <= -0.015 && compraH.every((h) => h[barato] <= -0.01),
      caro_conf: venda[caro] >= 0.015 && vendaH.every((h) => h[caro] >= 0.01),
    };
  }

  /** Dia mais barato para comprar, mais caro para vender e tempo ajustado pelo movimento de cada dia. */
  function analisarDias(r, diario, agora, cfg) {
    r.dias = null;
    const p = padraoSemana(diario, agora, cfg);
    if (!p) return r;
    const { compra, venda, f_venda: fVenda, f_compra: fCompra } = p;
    const cap = cfg.captura_estimada;
    r.horas_compra = simularHoras(r.qtd, r.compras_dia * cap, fCompra, agora);
    r.horas_venda = simularHoras(r.qtd, r.vendas_dia * cap, fVenda, agora + r.horas_compra * HORA);
    r.ciclo_dias = (r.horas_compra + r.horas_venda) / 24;
    r.ouro_dia = r.lucro_total / r.ciclo_dias;

    const dHoje = diaSemana(agora);
    const { barato, caro } = p;
    // Preço estimado naquele dia, partindo do preço de hoje
    const precoCompra = arred((r.compra * (1 + compra[barato])) / (1 + compra[dHoje]));
    const precoVenda = arred((r.venda * (1 + venda[caro])) / (1 + venda[dHoje]));
    r.dias = {
      hoje: dHoje,
      semanas: p.semanas,
      barato, barato_pct: compra[barato], barato_preco: precoCompra, barato_conf: p.barato_conf,
      dias_ate_barato: (barato - dHoje + 7) % 7,
      caro, caro_pct: venda[caro], caro_preco: precoVenda, caro_conf: p.caro_conf,
      dias_ate_caro: (caro - dHoje + 7) % 7,
      caro_lucro_extra: (lucroUnitario(r.compra, precoVenda) - r.lucro_un) * r.qtd,
      fds_vendas: (fVenda[5] + fVenda[6]) / 2 - 1,
      venda_por_dia: venda,
      compra_por_dia: compra,
      vendas_por_dia: fVenda.map((f) => f - 1),
    };
    return r;
  }

  /** Alertas em linguagem simples, motivos a favor e o veredito final. */
  function classificar(r) {
    const alertas = [], motivos = [];
    const lt = r.lucro_tipico;

    if (lt != null && lt <= 0) {
      alertas.push({ nivel: "risco", texto: "Normalmente este item não dá lucro no flip — o spread de agora é exceção." });
    } else if (lt != null && r.lucro_un > 2 * lt) {
      alertas.push({ nivel: "atencao", texto:
        `A margem hoje está ${(r.lucro_un / lt).toFixed(1).replace(".", ",")}x maior que o normal. ` +
        `Se voltar ao normal, o lucro cai para cerca de ${moeda(lt * r.qtd)}.` });
    }
    if (r.roi > 1) {
      alertas.push({ nivel: "risco", texto: `Margem alta demais (${pct0(r.roi)}). Confira as ofertas no jogo antes de comprar.` });
    }
    if (r.tendencia_preco < -0.08) {
      alertas.push({ nivel: "atencao", texto: `O preço de venda caiu ${pct0(-r.tendencia_preco)} nas últimas 24h.` });
    }
    if (r.tendencia_volume && r.tendencia_volume < 0.6) {
      alertas.push({ nivel: "atencao", texto: `Vendeu ${pct0(1 - r.tendencia_volume)} menos hoje que a média da semana.` });
    }
    if (r.variacao_estoque > 0.25) {
      alertas.push({ nivel: "atencao", texto: `Há ${pct0(r.variacao_estoque)} mais unidades à venda que há uma semana — mais concorrência.` });
    }

    const reg = r.regularidade;
    motivos.push(reg >= 0.8
      ? `Vende o tempo todo: teve negócio em ${pct0(reg)} das últimas horas.`
      : `Vende com frequência: teve negócio em ${pct0(reg)} das últimas horas.`);
    motivos.push(`Última venda há ${fmtHoras(r.horas_sem_venda)}.`);
    motivos.push(`O mercado gira ~${Math.round(r.vendas_dia).toLocaleString("pt-BR")} unidades/dia; você compra só ${pct0(r.qtd / r.vendas_dia)} disso.`);
    motivos.push(`Lucro de ${pct0(r.roi)} sobre o que você gasta, já descontadas as taxas.`);
    if (lt != null && lt > 0 && r.lucro_un <= 1.3 * lt) {
      motivos.push("Essa margem é a normal do item — não é um pico passageiro.");
    }

    const nRisco = alertas.filter((a) => a.nivel === "risco").length;
    const nAtencao = alertas.length - nRisco;
    const veredito = nRisco || nAtencao >= 3 ? "arriscado" : nAtencao ? "cautela" : "recomendado";

    r.alertas = alertas;
    r.motivos = motivos;
    r.veredito = veredito;
    r.score = r.ouro_dia * reg * (veredito === "arriscado" ? 0.5 : 1);
    return r;
  }

  /** Escolhe os itens para o capital: primeiro os recomendados, depois os de cautela. */
  function montarPlano(res, cfg) {
    const capital = cfg.ouro_disponivel * 10000;
    const orcamento = capital * (1 - cfg.reserva);
    const ordem = res
      .filter((r) => r.veredito !== "arriscado")
      .sort((a, b) => ORDEM_VEREDITO[a.veredito] - ORDEM_VEREDITO[b.veredito] || b.score - a.score);
    const escolhidos = [];
    let gasto = 0;
    for (const r of ordem) {
      if (cfg.max_itens_plano && escolhidos.length >= cfg.max_itens_plano) break;
      if (gasto + r.investimento <= orcamento) {
        escolhidos.push(r);
        gasto += r.investimento;
      }
    }
    return {
      ids: escolhidos.map((r) => r.id),
      capital,
      investimento: gasto,
      lucro: soma(escolhidos.map((r) => r.lucro_total)),
      livre: capital - gasto,
      ciclo_max_horas: escolhidos.length ? Math.max(...escolhidos.map((r) => r.ciclo_dias * 24)) : 0,
    };
  }

  /** Roda `fn` em cada item com no máximo `n` ao mesmo tempo; mantém a ordem. */
  async function emLotes(lista, n, fn) {
    const saida = new Array(lista.length);
    let prox = 0;
    const trabalhador = async () => {
      while (prox < lista.length) {
        const i = prox++;
        saida[i] = await fn(lista[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, lista.length) }, trabalhador));
    return saida;
  }

  /**
   * Análise completa. `fonte` fornece bulk(), precosOficiais(ids), historico(id), historicoDiario(id).
   * Retorna { res (ordenados), plano, stats }.
   */
  async function executar(cfg, fonte, log = () => {}, agoraFixo = null) {
    log("Baixando preços e volumes de todos os itens (DataWars2)...");
    const { total, itens } = await fonte.bulk();
    const porId = new Map(itens.map((it) => [it.id, it]));

    log("Calculando margens com as taxas do Trading Post...");
    const basicos = itens.map((it) => avaliar(it, cfg)).filter(Boolean);
    basicos.sort((a, b) => b.ouro_dia - a.ouro_dia);
    const candidatos = basicos.slice(0, cfg.candidatos_historico);
    const stats = { total, basico: basicos.length };

    log(`Confirmando preços atuais de ${candidatos.length} itens na API oficial...`);
    const precos = await fonte.precosOficiais(candidatos.map((r) => r.id));
    const atualizados = [];
    for (const r of candidatos) {
      const p = precos.get(r.id);
      if (!p) continue;
      const it = { ...porId.get(r.id) };
      [it.buy_price, it.sell_price, it.buy_quantity, it.sell_quantity] = p;
      const novo = avaliar(it, cfg);
      if (novo) atualizados.push(novo);
    }

    let feitos = 0;
    const passo = (txt, n) => () => log(`${txt} (${++feitos} de ${n})...`);
    const avisoH = passo("Analisando o histórico de vendas hora a hora", atualizados.length);
    const hists = await emLotes(atualizados, 4, async (r) => { const h = await fonte.historico(r.id); avisoH(); return h; });
    stats.fundo = atualizados.length;

    const agora = agoraFixo ?? Date.now();
    const res = [];
    atualizados.forEach((r, i) => {
      analisarHistorico(r, hists[i], agora, cfg);
      if (r.horas_sem_venda > cfg.max_horas_sem_venda) return;
      if (r.horas_sem_compra > cfg.max_horas_sem_compra) return;
      if (r.regularidade < cfg.regularidade_min) return;
      res.push(r);
    });

    feitos = 0;
    const avisoD = passo("Vendo o dia da semana mais barato e o mais caro", res.length);
    const diarios = await emLotes(res, 4, async (r) => { const d = await fonte.historicoDiario(r.id); avisoD(); return d; });
    res.forEach((r, i) => {
      analisarDias(r, diarios[i], agora, cfg);
      classificar(r);
    });

    log("Montando o seu plano...");
    const plano = montarPlano(res, cfg);
    const noPlano = new Map(plano.ids.map((id, n) => [id, n]));
    for (const r of res) r.no_plano = noPlano.has(r.id);
    // Itens do plano primeiro (na ordem do plano), depois o resto por veredito e score
    res.sort((a, b) => {
      if (a.no_plano !== b.no_plano) return a.no_plano ? -1 : 1;
      if (a.no_plano) return noPlano.get(a.id) - noPlano.get(b.id);
      return ORDEM_VEREDITO[a.veredito] - ORDEM_VEREDITO[b.veredito] || b.score - a.score;
    });
    stats.aprovados = res.length;
    return { res, plano, stats };
  }

  return {
    PADRAO, arred, taxas, lucroUnitario, precoMinimo, moeda, fmtHoras, diaSemana, emLotes,
    avaliar, analisarHistorico, padraoSemana, analisarDias, classificar, montarPlano, executar,
  };
})();

if (typeof module !== "undefined") module.exports = Motor;
