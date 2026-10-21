"use strict";

const $ = (s, el = document) => el.querySelector(s);

const VEREDITO = {
  recomendado: "Recomendado",
  cautela: "Com cautela",
  arriscado: "Arriscado",
};

// Ajustes finos: os mesmos do config.json da versão de PC
const CFG = { ...Motor.PADRAO };

// ---------- formatação ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function moeda(cobre) {
  const neg = cobre < 0;
  let c = Math.round(Math.abs(cobre));
  const g = Math.floor(c / 10000);
  const s = Math.floor((c % 10000) / 100);
  c = c % 100;
  const partes = [];
  if (g) partes.push(`${g.toLocaleString("pt-BR")}<i class="coin g"></i>`);
  if (g || s) partes.push(`${s}<i class="coin s"></i>`);
  partes.push(`${c}<i class="coin c"></i>`);
  return `<span class="moeda">${neg ? "−" : ""}${partes.join(" ")}</span>`;
}

function horas(h) {
  if (h >= 999) return "mais de 7 dias";
  if (h < 1) return "menos de 1h";
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1).replace(".", ",")} dias`;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const num = (x) => Math.round(x).toLocaleString("pt-BR");
const pct1 = (x) => `${(Math.abs(x) * 100).toFixed(1).replace(".", ",")}%`;
const sinal = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${pct1(x)}`;

const DIAS = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];
const naDia = (d) => (d >= 5 ? "no " : "na ") + DIAS[d];
const emDias = (n) => (n === 1 ? "amanhã" : `em ${n} dias`);
const cap = (t) => t[0].toUpperCase() + t.slice(1);

// ---------- minhas ordens (gravadas no localStorage deste navegador, ver dados.js) ----------

let ordensAtivas = Dados.ordensSalvas();
const ordemDoItem = (id) => ordensAtivas.find((o) => o.id === id);

async function marcarColocado(it, sim) {
  if (sim) {
    Dados.adicionar({
      id: it.id, nome: it.nome, img: it.img, chat_link: it.chat_link, qtd: it.qtd,
      compra: it.compra, venda: it.venda, lucro_total: it.lucro_total,
      horas_compra: it.horas_compra, horas_venda: it.horas_venda, veredito: it.veredito,
    });
  } else {
    const o = ordemDoItem(it.id);
    if (o) Dados.atualizar(o.uid, { acao: "desfazer" });
  }
  await carregarOrdens();
}

function idade(h) {
  if (h < 1) return "há pouco";
  if (h < 24) return `há ${Math.round(h)}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "há 1 dia" : `há ${d} dias`;
}

function cartaoOrdem(o) {
  const avisos = [];
  if (o.superada) {
    avisos.push(`<li class="atencao">Sua buy order foi superada: a maior oferta agora é ${moeda(o.maior_compra)}.
      Buy order não paga taxa — dá para cancelar e recolocar a ${moeda(o.maior_compra + 1)}.</li>`);
  }
  if (o.venda_agora != null && o.venda_agora < o.minimo) {
    avisos.push(`<li class="risco">O preço de venda agora (${moeda(o.venda_agora)}) está abaixo do seu mínimo.
      Espere o preço subir, ou venda sabendo que terá prejuízo.</li>`);
  }
  if (o.dia_caro) {
    const dc = o.dia_caro;
    avisos.push(dc.dias_ate === 0
      ? `<li class="info">Hoje é o dia em que este item costuma estar mais caro (${sinal(dc.pct)}): bom momento para listar.</li>`
      : `<li class="info">Costuma ficar mais caro ${naDia(dc.dia)} (${sinal(dc.pct)}, ~${moeda(dc.preco)}). Se puder esperar, liste ${emDias(dc.dias_ate)}.</li>`);
  }

  const lucroAgora = o.lucro_agora == null ? "" :
    `<span class="${o.lucro_agora >= 0 ? "pos" : "neg"}">${moeda(o.lucro_agora)}</span>`;
  const status = o.status === "comprando"
    ? `<span class="status comprando">Esperando a compra</span>`
    : `<span class="status vendendo">Comprado · falta vender</span>`;

  return `
  <article class="item ordem" data-uid="${o.uid}">
    <div class="item-cab">
      <img class="icone" src="${esc(o.img)}" alt="" onerror="this.style.visibility='hidden'">
      <div class="item-nome">
        <h3 title="${esc(o.nome)}">${esc(o.nome)}</h3>
        ${status}<span class="sub ordem-idade">colocada ${idade(o.idade_horas)}</span>
      </div>
    </div>
    <div class="ordem-grid">
      <div><span class="rot">Você comprou</span><span class="val">${num(o.qtd)} × ${moeda(o.compra)}</span></div>
      <div><span class="rot">Venda sugerida na época</span><span class="val">${moeda(o.venda_sugerida)}</span></div>
      <div><span class="rot">Liste agora a</span><span class="val">${o.venda_agora == null ? "—" : moeda(o.venda_agora)}</span></div>
      <div><span class="rot">Mínimo sem prejuízo</span><span class="val">${moeda(o.minimo)}</span></div>
      <div><span class="rot">Lucro se vender agora</span><span class="val">${lucroAgora || "—"}</span></div>
    </div>
    ${avisos.length ? `<ul class="lista-alertas ordem-avisos">${avisos.join("")}</ul>` : ""}
    <div class="ordem-acoes">
      ${o.status === "comprando" ? `<button class="botao-sec" data-acao="comprado">Encheu, vou vender</button>` : ""}
      <button class="botao-sec ok" data-acao="abrir-vendi">Vendi</button>
      <button class="botao-sec" data-acao="cancelei">Cancelei</button>
      <button class="botao-sec" data-copiar="${esc(o.nome)}" data-msg="Nome copiado — cole na busca do Trading Post">Copiar nome</button>
    </div>
    <form class="vendi-form" hidden>
      <span class="rot">Vendi por unidade a</span>
      <label><input type="number" min="0" name="g" value="${Math.floor((o.venda_agora || o.venda_sugerida) / 10000)}"><i class="coin g"></i></label>
      <label><input type="number" min="0" max="99" name="s" value="${Math.floor(((o.venda_agora || o.venda_sugerida) % 10000) / 100)}"><i class="coin s"></i></label>
      <label><input type="number" min="0" max="99" name="c" value="${(o.venda_agora || o.venda_sugerida) % 100}"><i class="coin c"></i></label>
      <span class="rot">quantidade</span>
      <label><input type="number" min="1" max="${o.qtd}" name="qtd" value="${o.qtd}" class="qtd"></label>
      <button type="submit" class="botao-sec ok">Confirmar venda</button>
      <button type="button" class="botao-sec" data-acao="fechar-vendi">Voltar</button>
    </form>
  </article>`;
}

function renderOrdens(d) {
  const r = d.resumo;
  const sec = $("#ordens-sec");
  sec.hidden = !d.ordens.length && !r.vendas;
  $("#ordens-erro").hidden = !d.erro;
  $("#ordens-erro").textContent = d.erro || "";
  const desde = r.desde ? new Date(r.desde).toLocaleDateString("pt-BR") : "";
  $("#ordens-resumo").innerHTML = r.vendas
    ? `Lucro real registrado: <b class="${r.lucro >= 0 ? "pos" : "neg"}">${moeda(r.lucro)}</b> em ${r.vendas} venda${r.vendas > 1 ? "s" : ""} desde ${desde}.`
    : "Ficam gravadas aqui até você marcar Vendi ou Cancelei.";
  $("#ordens-lista").innerHTML = d.ordens.length
    ? d.ordens.map(cartaoOrdem).join("")
    : `<div class="vazio">Nenhuma ordem aberta. Marque "Já coloquei" num flip para acompanhá-lo aqui.</div>`;
}

async function carregarOrdens() {
  ordensAtivas = Dados.ordensSalvas();
  const d = await Dados.listar(CFG);
  ordensAtivas = d.ordens;
  renderOrdens(d);
}

async function acaoOrdem(uid, corpo, msg) {
  try {
    Dados.atualizar(uid, corpo);
    toast(msg);
    await carregarOrdens();
    sincronizarMarcas();
  } catch (e) {
    toast(e.message);
  }
}

function sincronizarMarcas() {
  document.querySelectorAll(".item[data-item]").forEach((el) => {
    const tem = !!ordemDoItem(Number(el.dataset.item));
    $(".feito input", el).checked = tem;
    el.classList.toggle("colocado", tem);
  });
  const b = $("#heroi-colocar");
  if (b) b.textContent = ordemDoItem(Number(b.dataset.item)) ? "✓ Ordem gravada" : "Já coloquei esta ordem";
}

$("#ordens-lista").addEventListener("click", (e) => {
  const b = e.target.closest("[data-acao]");
  if (!b) return;
  const card = b.closest(".ordem");
  const uid = card.dataset.uid;
  const acao = b.dataset.acao;
  if (acao === "comprado") acaoOrdem(uid, { acao: "comprado" }, "Marcado como comprado");
  else if (acao === "abrir-vendi") { $(".vendi-form", card).hidden = false; $(".ordem-acoes", card).hidden = true; }
  else if (acao === "fechar-vendi") { $(".vendi-form", card).hidden = true; $(".ordem-acoes", card).hidden = false; }
  else if (acao === "cancelei") {
    if (b.dataset.confirmar) acaoOrdem(uid, { acao: "cancelei" }, "Ordem cancelada");
    else {
      b.dataset.confirmar = "1";
      b.textContent = "Confirmar cancelamento?";
      b.classList.add("perigo");
      setTimeout(() => { delete b.dataset.confirmar; b.textContent = "Cancelei"; b.classList.remove("perigo"); }, 4000);
    }
  }
});

$("#ordens-lista").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  const card = f.closest(".ordem");
  const v = (n) => Math.max(0, parseInt(f.elements[n].value, 10) || 0);
  const preco = v("g") * 10000 + v("s") * 100 + v("c");
  if (!preco) { toast("Informe o preço de venda"); return; }
  acaoOrdem(card.dataset.uid, { acao: "vendi", preco, qtd: v("qtd") }, "Venda registrada no histórico");
});

$("#ordens-atualizar").addEventListener("click", async () => {
  await carregarOrdens();
  toast("Preços atualizados");
});

// ---------- utilidades de UI ----------

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1600);
}

function copiar(texto, msg) {
  navigator.clipboard.writeText(texto).then(() => toast(msg), () => toast("Não consegui copiar"));
}

function blocoDias(it) {
  const d = it.dias;
  if (!d) return "";
  const linha = (rot, dia, preco, p, conf, classe) => `
    <div class="dia-linha ${classe}">
      <span class="dia-rot">${rot}</span>
      <span class="dia-nome">${cap(DIAS[dia])}${dia === d.hoje ? " (hoje)" : ""}</span>
      <span class="dia-preco">~${moeda(preco)} <span class="dia-pct">${sinal(p)}</span></span>
      <span class="dia-conf ${conf ? "sim" : ""}">${conf ? "costuma se repetir" : "varia pouco"}</span>
    </div>`;

  const dicas = [];
  if (d.barato_conf) {
    dicas.push(d.dias_ate_barato === 0
      ? "Hoje é o dia mais barato: bom momento para colocar a buy order."
      : `A buy order costuma sair mais barata ${naDia(d.barato)} (${emDias(d.dias_ate_barato)}).`);
  }
  if (d.caro_conf) {
    if (d.dias_ate_caro === 0) dicas.push("Hoje é o dia mais caro: bom momento para listar.");
    else if (d.caro_lucro_extra > 0) dicas.push(`Se puder esperar, liste ${naDia(d.caro)}: cerca de ${moeda(d.caro_lucro_extra)} a mais de lucro. Volte ${emDias(d.dias_ate_caro)}.`);
  }
  if (!d.barato_conf && !d.caro_conf) dicas.push("O preço quase não muda entre os dias — não vale esperar, siga o flip normal.");
  else if (!dicas.length) dicas.push("Pode listar assim que a compra completar.");

  return `<div class="dias">
    ${linha("Mais barato p/ comprar", d.barato, d.barato_preco, d.barato_pct, d.barato_conf, "barato")}
    ${linha("Mais caro p/ vender", d.caro, d.caro_preco, d.caro_pct, d.caro_conf, "caro")}
    <p class="dia-dica">${dicas.join(" ")}</p>
  </div>`;
}

function seloDia(it) {
  const d = it.dias;
  if (!d || !d.caro_conf) return "";
  const txt = d.caro >= 5 ? "Mais caro no fim de semana" : `Mais caro ${naDia(d.caro)}`;
  return `<span class="selo-dia">${txt}</span>`;
}

function selo(v) {
  return `<span class="veredito ${v}">${VEREDITO[v]}</span>`;
}

function listaMotivos(it) {
  const m = it.motivos.map((t) => `<li>${esc(t)}</li>`).join("");
  const a = it.alertas.map((x) => `<li class="${x.nivel}">${esc(x.texto)}</li>`).join("");
  return `<ul class="lista-motivos">${m}</ul>${a ? `<ul class="lista-alertas">${a}</ul>` : ""}`;
}

function numeros(it) {
  const linhas = [
    ["Lucro por unidade", moeda(it.lucro_un)],
    ["Retorno (ROI)", pct(it.roi)],
    ["Investimento c/ taxa", moeda(it.investimento)],
    ["Vendas por dia", num(it.vendas_dia)],
    ["Buy orders preenchidas/dia", num(it.compras_dia)],
    ["Última venda", horas(it.horas_sem_venda)],
    ["Última buy order preenchida", horas(it.horas_sem_compra)],
    ["Tempo p/ comprar", horas(it.horas_compra)],
    ["Tempo p/ vender", horas(it.horas_venda)],
    ["Margem normal do item", it.lucro_tipico == null ? "—" : moeda(it.lucro_tipico) + " / un"],
  ];
  return `<div class="numeros">${linhas.map(([r, v]) => `<div><span>${r}</span>${v}</div>`).join("")}</div>`;
}

// ---------- renderização ----------

function renderResumo(d) {
  const p = d.plano;
  const n = p.ids.length;
  $("#resumo").innerHTML = `
    <div class="stat"><span class="rot">Investir agora</span><span class="num">${moeda(p.investimento)}</span>
      <span class="sub">sobram ${moeda(p.livre)} livres</span></div>
    <div class="stat lucro"><span class="rot">Lucro esperado</span><span class="num">${moeda(p.lucro)}</span>
      <span class="sub">${p.investimento ? pct(p.lucro / p.investimento) + " sobre o investido" : "&nbsp;"}</span></div>
    <div class="stat"><span class="rot">Itens no plano</span><span class="num">${n}</span>
      <span class="sub">de ${d.stats.aprovados} aprovados</span></div>
    <div class="stat"><span class="rot">Tudo vendido em</span><span class="num">~${horas(p.ciclo_max_horas)}</span>
      <span class="sub">estimativa</span></div>`;
}

function renderDestaque(it, noPlano) {
  const titulo = noPlano ? "Comece por aqui · melhor flip agora" : "Melhor opção encontrada · vá com cuidado";
  const el = $("#destaque");
  el.innerHTML = `
    <article class="destaque">
      <span class="selo">${titulo}</span>
      <div class="destaque-cab">
        <img src="${esc(it.img)}" alt="" onerror="this.style.visibility='hidden'">
        <div>
          <h2>${esc(it.nome)}</h2>
          <div class="meta">${selo(it.veredito)}${seloDia(it)}<span class="sub">${esc(it.raridade)}</span></div>
        </div>
      </div>
      <ol class="passos">
        <li><span class="n">1</span><div>
          <div class="t">Coloque uma buy order de</div>
          <div class="v">${num(it.qtd)} unidades a ${moeda(it.compra)} cada</div>
          <div class="t">Total: ${moeda(it.custo_compra)}</div></div></li>
        <li><span class="n">2</span><div>
          <div class="t">Quando a compra completar, liste para venda a</div>
          <div class="v">${moeda(it.venda)} cada</div>
          <div class="t">A taxa de listagem de ${moeda(it.taxa_listagem)} é paga na hora em que você lista</div></div></li>
        <li><span class="n">3</span><div>
          <div class="t">Lucro esperado, já sem as taxas</div>
          <div class="v ok">${moeda(it.lucro_total)}</div>
          <div class="t">em cerca de ${horas(it.ciclo_dias * 24)} (comprar ~${horas(it.horas_compra)} + vender ~${horas(it.horas_venda)}), já considerando o movimento do dia da semana</div></div></li>
      </ol>
      ${blocoDias(it)}
      <div class="botoes">
        <button class="botao-sec ok" id="heroi-colocar" data-item="${it.id}">${ordemDoItem(it.id) ? "✓ Ordem gravada" : "Já coloquei esta ordem"}</button>
        <button class="botao-sec" data-copiar="${esc(it.nome)}" data-msg="Nome copiado — cole na busca do Trading Post">Copiar nome</button>
        <button class="botao-sec" data-copiar="${esc(it.chat_link)}" data-msg="Chat link copiado">Copiar chat link</button>
      </div>
      <div class="porque"><h4>Por que este item</h4>${listaMotivos(it)}</div>
      <details class="item-mais" style="margin-left:0"><summary>Ver números</summary><div class="item-detalhe">${numeros(it)}</div></details>
    </article>`;
  $("#heroi-colocar").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const gravar = !ordemDoItem(it.id);
      await marcarColocado(it, gravar);
      toast(gravar ? "Ordem gravada em Minhas ordens" : "Ordem removida");
      sincronizarMarcas();
    } catch (err) {
      toast(err.message);
    } finally {
      b.disabled = false;
    }
  });
}

function cartao(it, rank) {
  const tpl = $("#tpl-item").content.cloneNode(true);
  const el = $(".item", tpl);
  $(".rank", el).textContent = rank ? `${rank}º` : "";
  const img = $(".icone", el);
  img.src = it.img;
  img.onerror = () => { img.style.visibility = "hidden"; };
  $("h3", el).textContent = it.nome;
  $("h3", el).title = it.nome;
  $(".veredito", el).outerHTML = selo(it.veredito) + seloDia(it);
  $(".compra", el).innerHTML = `${num(it.qtd)} × ${moeda(it.compra)}`;
  $(".venda", el).innerHTML = moeda(it.venda);
  $(".lucro", el).innerHTML = moeda(it.lucro_total);
  $(".tempo", el).textContent = `~${horas(it.ciclo_dias * 24)}`;
  $(".item-dias", el).innerHTML = blocoDias(it);
  $(".item-detalhe", el).innerHTML = `${listaMotivos(it)}${numeros(it)}
    <div class="botoes" style="margin:0">
      <button class="botao-sec" data-copiar="${esc(it.nome)}" data-msg="Nome copiado — cole na busca do Trading Post">Copiar nome</button>
      <button class="botao-sec" data-copiar="${esc(it.chat_link)}" data-msg="Chat link copiado">Copiar chat link</button>
    </div>`;

  el.dataset.item = it.id;
  const chk = $(".feito input", el);
  chk.checked = !!ordemDoItem(it.id);
  el.classList.toggle("colocado", chk.checked);
  chk.addEventListener("change", async () => {
    chk.disabled = true;
    try {
      await marcarColocado(it, chk.checked);
      toast(chk.checked ? "Ordem gravada em Minhas ordens" : "Ordem removida");
      sincronizarMarcas();
    } catch (err) {
      chk.checked = !chk.checked;
      toast(err.message);
    } finally {
      chk.disabled = false;
    }
  });
  return el;
}

function renderExplica(d) {
  const c = d.config;
  $("#explica").innerHTML = `
    <p><b>Taxas.</b> Ao vender no Trading Post você paga 5% para listar (na hora, e não volta se cancelar) e 10% quando vende.
    Todos os lucros mostrados já descontam os 15%.</p>
    <p><b>Preços.</b> A buy order sugerida fica 1 cobre acima da maior oferta atual, e a venda 1 cobre abaixo da menor listagem,
    para você ser o primeiro da fila nos dois lados.</p>
    <p><b>Rotatividade.</b> Antes de considerar a margem, o sistema confere o histórico hora a hora: descarta itens sem venda há mais de
    ${c.max_horas_sem_venda}h e itens que não negociam com regularidade nas últimas ${c.janela_regularidade_horas}h.
    Margem alta em item parado não entra.</p>
    <p><b>Quantidade.</b> No máximo ${pct(c.fracao_max_por_item)} do seu ouro em um único item e uma fatia pequena do que o mercado
    gira por dia, para você não travar o ouro nem derrubar o preço.</p>
    <p><b>Tempo estimado.</b> Supõe que você pega cerca de ${pct(c.captura_estimada)} das negociações (há outros flippers disputando).
    É uma estimativa — pode ser mais rápido ou mais lento.</p>
    <p><b>Vereditos.</b> <span class="veredito recomendado">Recomendado</span> não tem nenhum sinal de alerta.
    <span class="veredito cautela">Com cautela</span> tem algum sinal (preço caindo, margem fora do normal, mais concorrência).
    <span class="veredito arriscado">Arriscado</span> fica fora do plano.</p>
    <p><b>Dia da semana.</b> Com o histórico diário das últimas ${c.semanas_dia} semanas, cada item mostra o dia em que a compra
    costuma sair mais barata e o dia em que a venda costuma sair mais cara, com o preço estimado. Só aparece
    <b>"costuma se repetir"</b> quando o efeito passa de 1,5% e aparece nas duas metades do período; senão a diferença é ruído.
    O tempo estimado também leva em conta o movimento de cada dia (no fim de semana o jogo vende bem mais).</p>
    <p><b>Dica.</b> Se alguém passar na sua frente por 1 cobre e o item vende bem, não cancele: cada relistagem paga 5% de novo.</p>`;
}

function render(d) {
  const itens = d.itens;
  const plano = itens.filter((i) => i.no_plano);
  const outros = itens.filter((i) => !i.no_plano);

  $("#atualizado").textContent = `Análise de ${new Date(d.gerado_em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  renderExplica(d);

  if (!itens.length) {
    $("#resumo").innerHTML = "";
    $("#destaque").innerHTML = `<div class="vazio">Nenhum flip passou nos filtros agora.<br>
      Com pouco ouro poucos itens cabem — tente um valor maior, ou rode de novo mais tarde.</div>`;
    $("#plano-sec").hidden = true;
    $("#outros-sec").hidden = true;
    return;
  }

  renderResumo(d);
  const heroi = plano[0] || outros[0];
  renderDestaque(heroi, !!plano[0]);

  const lp = $("#plano-lista");
  lp.innerHTML = "";
  plano.slice(1).forEach((it, i) => lp.appendChild(cartao(it, i + 2)));
  $("#plano-sec").hidden = plano.length < 2;

  const lo = $("#outros-lista");
  lo.innerHTML = "";
  outros.filter((it) => it !== heroi).forEach((it) => lo.appendChild(cartao(it, 0)));
  $("#outros-titulo").textContent = `Outros flips aprovados (${lo.children.length})`;
  $("#outros-sec").hidden = lo.children.length === 0;
}

// ---------- fluxo ----------

function carregando(sim) {
  $("#carregando").hidden = !sim;
  $("#botao").disabled = sim;
  $("#botao").textContent = sim ? "Analisando..." : "Encontrar flips";
  if (sim) $("#carregando-texto").textContent = "Analisando o Trading Post...";
}

async function analisar(ev) {
  ev.preventDefault();
  const ouro = $("#ouro").value.trim();
  if (!ouro || Number(ouro) <= 0) { $("#ouro").focus(); return; }
  try { localStorage.setItem("ouro", ouro); } catch { /* sem storage */ }

  $("#erro").hidden = true;
  $("#resultado").hidden = true;
  carregando(true);
  try {
    const cfg = { ...CFG, ouro_disponivel: Number(ouro.replace(",", ".")) };
    const fonte = Dados.fonte(cfg, !$("#atualizar").checked);
    const { res, plano, stats } = await Motor.executar(cfg, fonte, (m) => { $("#carregando-texto").textContent = m; });
    const d = {
      gerado_em: new Date().toISOString(),
      ouro: cfg.ouro_disponivel,
      config: cfg,
      stats, plano,
      itens: res,
    };
    await carregarOrdens();
    render(d);
    $("#resultado").hidden = false;
    $("#atualizar").checked = false;
    $("#resultado").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    console.error(e);
    $("#erro").textContent = e.rede || e instanceof TypeError
      ? `Não consegui buscar os dados do Trading Post. Confira sua internet e tente de novo. (${e.message})`
      : `Algo deu errado na análise: ${e.message}`;
    $("#erro").hidden = false;
  } finally {
    carregando(false);
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copiar]");
  if (b) copiar(b.dataset.copiar, b.dataset.msg);
});

// ---------- backup ----------

$("#exportar").addEventListener("click", () => {
  const d = Dados.exportar();
  const blob = new Blob([JSON.stringify(d, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `flip-gw2-backup-${d.exportado_em.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Backup salvo: ${d.ordens.length} ordens, ${d.historico.length} flips no histórico`);
});

$("#importar").addEventListener("click", () => $("#importar-arq").click());

$("#importar-arq").addEventListener("change", async (e) => {
  let ordens = 0, historico = 0;
  for (const arq of e.target.files) {
    try {
      const r = Dados.importar(await arq.text());
      ordens += r.ordens;
      historico += r.historico;
    } catch (err) {
      toast(`${arq.name}: ${err.message}`);
      e.target.value = "";
      return;
    }
  }
  e.target.value = "";
  toast(ordens || historico
    ? `Carregado: ${ordens} ordens e ${historico} flips no histórico`
    : "Nada novo: esse backup já estava aqui");
  await carregarOrdens();
  sincronizarMarcas();
});

$("#form").addEventListener("submit", analisar);
try { $("#ouro").value = localStorage.getItem("ouro") || ""; } catch { /* sem storage */ }
$("#ouro").focus();
carregarOrdens();
