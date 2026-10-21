"use strict";
/*
 * Tudo que o app guarda ou baixa:
 *  - Rede: DataWars2 e API oficial do GW2 (as duas liberam acesso direto do navegador).
 *  - Cache: IndexedDB, só com os campos usados (cai para memória se o navegador bloquear).
 *  - Minhas ordens e histórico de flips: localStorage deste navegador (versão web de ordens.py).
 */
const Dados = (() => {
  const DW2 = "https://api.datawars2.ie/gw2";
  const OFICIAL = "https://api.guildwars2.com/v2";
  const CAMPOS_BULK = [
    "id", "name", "chat_link", "rarity", "item_type", "img_official",
    "buy_price", "sell_price", "buy_quantity", "sell_quantity",
    "1d_buy_sold", "1d_sell_sold", "7d_buy_sold", "7d_sell_sold",
    "7d_buy_price_avg", "7d_sell_price_avg",
  ];
  const CAMPOS_HORA = "date,sell_sold,buy_sold,buy_price_avg,sell_price_avg,sell_quantity_avg";
  const CAMPOS_DIA = "date,buy_price_avg,sell_price_avg,buy_sold,sell_sold";
  const DIA = 864e5;

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const dataUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

  async function baixarJson(url, tentativas = 3) {
    for (let i = 0; ; i++) {
      try {
        const resp = await fetch(url, { headers: { Accept: "application/json" } });
        if (!resp.ok) throw new Error(`resposta ${resp.status}`);
        return await resp.json();
      } catch (e) {
        if (i >= tentativas - 1) {
          const erro = new Error(`falha ao baixar de ${new URL(url).host}: ${e.message}`);
          erro.rede = true;
          throw erro;
        }
        await esperar(2000 * (i + 1));
      }
    }
  }

  // ---------- cache (IndexedDB) ----------

  const Cache = (() => {
    const mem = new Map();
    let dbP = null;

    function abrir() {
      if (!dbP) {
        dbP = new Promise((ok, falha) => {
          const req = indexedDB.open("flip-gw2", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("cache");
          req.onsuccess = () => ok(req.result);
          req.onerror = () => falha(req.error);
        }).catch(() => null);   // sem IndexedDB (modo privado etc.): fica só a memória
      }
      return dbP;
    }

    function pedido(db, modo, fazer) {
      return new Promise((ok) => {
        try {
          const req = fazer(db.transaction("cache", modo).objectStore("cache"));
          req.onsuccess = () => ok(req.result);
          req.onerror = () => ok(null);
        } catch { ok(null); }
      });
    }

    async function ler(nome) {
      if (mem.has(nome)) return mem.get(nome);
      const db = await abrir();
      const v = db ? await pedido(db, "readonly", (s) => s.get(nome)) : null;
      if (v) mem.set(nome, v);
      return v;
    }

    async function gravar(nome, dados) {
      const v = { ts: Date.now(), dados };
      mem.set(nome, v);
      const db = await abrir();
      if (db) await pedido(db, "readwrite", (s) => s.put(v, nome));
    }

    async function obter(nome, maxMin, buscar, usarCache) {
      if (usarCache) {
        const v = await ler(nome);
        if (v && Date.now() - v.ts < maxMin * 60e3) return v.dados;
      }
      const dados = await buscar();
      await gravar(nome, dados);
      return dados;
    }

    /** Apaga o que tem mais de 2 dias, para o cache não crescer para sempre. */
    async function limparVelhos() {
      const db = await abrir();
      if (!db) return;
      try {
        const cur = db.transaction("cache", "readwrite").objectStore("cache").openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          if (!c.value || Date.now() - c.value.ts > 2 * DIA) c.delete();
          c.continue();
        };
      } catch { /* sem cache, sem limpeza */ }
    }

    return { obter, limparVelhos };
  })();

  /** Fonte de dados para Motor.executar. */
  function fonte(cfg, usarCache = true) {
    return {
      async bulk() {
        return Cache.obter("bulk", cfg.cache_bulk_min, async () => {
          const itens = await baixarJson(`${DW2}/v1/items/json?fields=${CAMPOS_BULK.join(",")}`);
          // Guarda só o que pode virar flip: com preço dos dois lados e volume mínimo (Motor.avaliar exige isso)
          const v = cfg.volume_min_dia;
          const giro = (it, lado) => Math.min((it[`7d_${lado}_sold`] || 0) / 7, it[`1d_${lado}_sold`] || 0);
          return {
            total: itens.length,
            itens: itens.filter((it) => it.buy_price > 0 && it.sell_price > 0 && giro(it, "sell") >= v && giro(it, "buy") >= v),
          };
        }, usarCache);
      },

      async precosOficiais(ids) {
        const precos = new Map();
        for (let i = 0; i < ids.length; i += 200) {
          const lote = ids.slice(i, i + 200).join(",");
          for (const p of await baixarJson(`${OFICIAL}/commerce/prices?ids=${lote}`)) {
            precos.set(p.id, [p.buys.unit_price, p.sells.unit_price, p.buys.quantity, p.sells.quantity]);
          }
        }
        return precos;
      },

      historico(id) {
        const inicio = dataUTC(Date.now() - 8 * DIA);
        return Cache.obter(`hist_${id}`, cfg.cache_historico_min,
          () => baixarJson(`${DW2}/v2/history/hourly/json?itemID=${id}&start=${inicio}&fields=${CAMPOS_HORA}`), usarCache);
      },

      historicoDiario(id) {
        const inicio = dataUTC(Date.now() - (cfg.semanas_dia * 7 + 10) * DIA);
        return Cache.obter(`dia_${id}`, cfg.cache_diario_min,
          () => baixarJson(`${DW2}/v2/history/json?itemID=${id}&start=${inicio}&fields=${CAMPOS_DIA}`), usarCache);
      },
    };
  }

  // ---------- minhas ordens (localStorage) ----------

  const CH_ORDENS = "flipgw2:ordens";
  const CH_HIST = "flipgw2:historico";

  function lerLista(chave) {
    try {
      const v = JSON.parse(localStorage.getItem(chave) || "[]");
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  function gravarLista(chave, lista) {
    try {
      localStorage.setItem(chave, JSON.stringify(lista));
    } catch {
      throw new Error("O navegador não deixou salvar. Ele pode estar em modo privado ou com o armazenamento cheio.");
    }
  }

  const agoraISO = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

  function novoUid() {
    const b = new Uint8Array(4);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  function intPos(v, nome) {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) throw new Error(`${nome} inválido`);
    if (n <= 0) throw new Error(`${nome} precisa ser maior que zero`);
    return n;
  }

  function adicionar(d) {
    const ordem = {
      uid: novoUid(),
      id: intPos(d.id, "item"),
      nome: String(d.nome || "").slice(0, 120),
      img: String(d.img || "").slice(0, 300),
      chat_link: String(d.chat_link || "").slice(0, 60),
      qtd: intPos(d.qtd, "quantidade"),
      compra: intPos(d.compra, "preço de compra"),
      venda_sugerida: intPos(d.venda, "preço de venda"),
      lucro_previsto: Math.trunc(d.lucro_total || 0),
      horas_compra_prev: Math.round((Number(d.horas_compra) || 0) * 10) / 10,
      horas_venda_prev: Math.round((Number(d.horas_venda) || 0) * 10) / 10,
      veredito: String(d.veredito || "").slice(0, 20),
      criada: agoraISO(),
      comprado_em: null,
      status: "comprando",
    };
    const ordens = lerLista(CH_ORDENS);
    ordens.push(ordem);
    gravarLista(CH_ORDENS, ordens);
    return ordem;
  }

  /** acao: comprado | vendi (preco, qtd) | cancelei | desfazer. */
  function atualizar(uid, d) {
    const ordens = lerLista(CH_ORDENS);
    const o = ordens.find((x) => x.uid === uid);
    if (!o) throw new Error("Ordem não encontrada.");
    const agora = agoraISO();
    const tirar = () => ordens.splice(ordens.indexOf(o), 1);
    const registrar = (linha) => {
      const hist = lerLista(CH_HIST);
      hist.push(linha);
      gravarLista(CH_HIST, hist);
    };

    if (d.acao === "comprado") {
      o.status = "vendendo";
      o.comprado_em = agora;
    } else if (d.acao === "vendi") {
      const preco = intPos(d.preco || o.venda_sugerida, "preço de venda");
      const qtd = Math.min(intPos(d.qtd || o.qtd, "quantidade"), o.qtd);
      registrar({
        fim: "vendido", id: o.id, nome: o.nome, qtd,
        compra: o.compra, venda_sugerida: o.venda_sugerida, venda: preco,
        lucro_previsto: Math.round((o.lucro_previsto * qtd) / o.qtd),
        lucro: Motor.lucroUnitario(o.compra, preco) * qtd,
        horas_compra_prev: o.horas_compra_prev, horas_venda_prev: o.horas_venda_prev,
        veredito: o.veredito, criada: o.criada, comprado_em: o.comprado_em, vendido_em: agora,
      });
      o.qtd -= qtd;
      o.lucro_previsto -= Math.round((o.lucro_previsto * qtd) / (o.qtd + qtd));
      if (o.status === "comprando") {
        o.status = "vendendo";
        o.comprado_em = agora;
      }
      if (o.qtd <= 0) tirar();
    } else if (d.acao === "cancelei") {
      registrar({
        fim: "cancelado", id: o.id, nome: o.nome, qtd: o.qtd,
        compra: o.compra, venda_sugerida: o.venda_sugerida,
        lucro_previsto: o.lucro_previsto, status_ao_cancelar: o.status,
        veredito: o.veredito, criada: o.criada, comprado_em: o.comprado_em, cancelado_em: agora,
      });
      tirar();
    } else if (d.acao === "desfazer") {  // marcou "já coloquei" por engano: some sem ir para o histórico
      tirar();
    } else {
      throw new Error("Ação inválida.");
    }
    gravarLista(CH_ORDENS, ordens);
  }

  function resumoHistorico() {
    let lucro = 0, vendas = 0, cancelados = 0, desde = null;
    for (const h of lerLista(CH_HIST)) {
      desde = desde || h.criada;
      if (h.fim === "vendido") {
        lucro += h.lucro || 0;
        vendas++;
      } else {
        cancelados++;
      }
    }
    return { lucro, vendas, cancelados, desde };
  }

  const ordensSalvas = () => lerLista(CH_ORDENS);

  /** Ordens ativas com o preço de agora, o mínimo sem prejuízo e o dia mais caro da semana. */
  async function listar(cfg) {
    const ordens = lerLista(CH_ORDENS);
    const agora = Date.now();
    const f = fonte(cfg, true);
    let precos = new Map(), erro = null;
    if (ordens.length) {
      try {
        precos = await f.precosOficiais([...new Set(ordens.map((o) => o.id))]);
      } catch {
        erro = "Não consegui buscar os preços de agora. Mostrando só o que foi gravado.";
      }
    }
    const hoje = Motor.diaSemana(agora);
    const diarios = await Motor.emLotes(ordens, 4, (o) => f.historicoDiario(o.id).catch(() => null));

    ordens.forEach((o, i) => {
      o.minimo = Motor.precoMinimo(o.compra);
      o.idade_horas = (agora - Date.parse(o.criada)) / 3600e3;
      const p = precos.get(o.id);
      if (p) {
        const [maiorCompra, menorVenda] = p;
        o.maior_compra = maiorCompra;
        o.venda_agora = menorVenda ? Math.max(1, menorVenda - 1) : null;
        o.superada = o.status === "comprando" && maiorCompra > o.compra;
        o.lucro_agora = o.venda_agora ? Motor.lucroUnitario(o.compra, o.venda_agora) * o.qtd : null;
      }
      const padrao = diarios[i] ? Motor.padraoSemana(diarios[i], agora, cfg) : null;
      if (padrao && padrao.caro_conf && o.venda_agora) {
        const v = padrao.venda;
        o.dia_caro = {
          dia: padrao.caro, pct: v[padrao.caro], hoje,
          dias_ate: (padrao.caro - hoje + 7) % 7,
          preco: Motor.arred((o.venda_agora * (1 + v[padrao.caro])) / (1 + v[hoje])),
        };
      }
    });
    return { ordens, resumo: resumoHistorico(), erro };
  }

  // ---------- backup: exportar / importar ----------

  function exportar() {
    return {
      app: "flip-gw2",
      versao: 1,
      exportado_em: agoraISO(),
      ordens: lerLista(CH_ORDENS),
      historico: lerLista(CH_HIST),
    };
  }

  const ordemValida = (o) => o && typeof o.uid === "string" && Number.isInteger(o.id) &&
    Number.isInteger(o.qtd) && o.qtd > 0 && Number.isInteger(o.compra) && typeof o.criada === "string" &&
    (o.status === "comprando" || o.status === "vendendo");
  const linhaValida = (h) => h && (h.fim === "vendido" || h.fim === "cancelado") && Number.isInteger(h.id);

  /**
   * Junta o conteúdo de um arquivo com o que já está salvo, sem duplicar.
   * Aceita: o backup deste site, o dados/ordens.json da versão de PC e o dados/historico.jsonl.
   */
  function importar(texto) {
    let ordens = [], historico = [];
    let v = null;
    try { v = JSON.parse(texto); } catch { /* pode ser .jsonl */ }

    if (v && !Array.isArray(v) && typeof v === "object") {
      ordens = v.ordens || [];
      historico = v.historico || [];
    } else if (Array.isArray(v)) {
      ordens = v.filter((x) => x && x.status);
      historico = v.filter((x) => x && x.fim);
    } else {
      for (const linha of texto.split(/\r?\n/)) {
        if (!linha.trim()) continue;
        try { historico.push(JSON.parse(linha)); } catch { /* linha quebrada */ }
      }
    }
    ordens = (Array.isArray(ordens) ? ordens : []).filter(ordemValida);
    historico = (Array.isArray(historico) ? historico : []).filter(linhaValida);
    if (!ordens.length && !historico.length) throw new Error("Este arquivo não tem ordens nem histórico do Flip GW2.");

    const atuais = lerLista(CH_ORDENS);
    const uids = new Set(atuais.map((o) => o.uid));
    const novasOrdens = ordens.filter((o) => !uids.has(o.uid));

    const hist = lerLista(CH_HIST);
    const vistos = new Set(hist.map((h) => JSON.stringify(h)));
    const novasLinhas = historico.filter((h) => {
      const k = JSON.stringify(h);
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });
    // Histórico em ordem de criação, como no arquivo original
    const histFinal = hist.concat(novasLinhas).sort((a, b) => String(a.criada).localeCompare(String(b.criada)));

    gravarLista(CH_ORDENS, atuais.concat(novasOrdens));
    gravarLista(CH_HIST, histFinal);
    return { ordens: novasOrdens.length, historico: novasLinhas.length };
  }

  Cache.limparVelhos();

  return { fonte, adicionar, atualizar, listar, ordensSalvas, exportar, importar };
})();
