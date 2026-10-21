# Flip GW2

Assistente de flips do Trading Post do Guild Wars 2: você informa quanto ouro tem e ele diz
**o que comprar, por quanto, quanto vender e quanto vai lucrar** — levando em conta margem e rotatividade.

## Como usar

1. Dois cliques em `rodar.bat`. O navegador abre sozinho.
2. Digite quanto ouro você tem e clique em **Encontrar flips**.
3. Siga o card **"Comece por aqui"** e depois o plano, na ordem. Marque "Já coloquei" em cada item.

Deixe a janela preta do `rodar.bat` aberta enquanto usa; feche-a para encerrar.
Também roda pelo terminal: `python flip.py --ouro 300` (gera um CSV em `relatorios/`).

## Como decide

1. Baixa todos os itens do DataWars2 (preço + unidades vendidas/compradas em 1d e 7d).
2. Calcula o lucro com as taxas (5% listagem + 10% câmbio, mín. 1c cada), superando os preços em 1c.
3. Usa o ritmo **conservador** (menor entre média de 7d e últimas 24h) para definir quantidade e tempo.
4. Confirma o preço atual dos candidatos na API oficial.
5. Analisa o histórico hora a hora: tempo desde a última venda e desde a última buy order preenchida,
   % das horas com negócio, margem normal do item, tendência de preço e de estoque.
6. Dá um veredito (Recomendado / Com cautela / Arriscado) e monta um plano com até 80% do seu ouro,
   no máximo 10% por item, recomendados primeiro.
7. **Dia da semana** (26 semanas de histórico diário): mostra em cada item o dia em que a compra costuma
   sair mais barata e o dia em que a venda costuma sair mais cara, com o preço estimado e quanto rende a mais
   esperar. "Costuma se repetir" só quando o efeito passa de 1,5% e aparece nas duas metades do período.
   O tempo estimado considera o movimento de cada dia (no fim de semana vende ~46% mais).
   Dia do jogo = UTC (vira às 21h de Brasília).

## Minhas ordens

Ao marcar **"Já coloquei"**, a ordem fica gravada e aparece no topo do app sempre que você abrir,
com o preço de compra, o preço para listar agora, o mínimo sem prejuízo e o dia mais caro da semana.

- `dados/ordens.json` — só as ordens abertas. "Vendi" e "Cancelei" tiram a ordem daqui.
- `dados/historico.jsonl` — uma linha por flip finalizado (~300 bytes), com previsto × real,
  para análises futuras. Pode apagar quando quiser; o app recomeça do zero.

Ajustes finos em `config.json`. Requer só Python 3.9+, sem dependências.

## Gerar o executável (.exe) para outra pessoa

A pasta `distribuir/` tem o `FlipGW2.exe` (não precisa de Python) e um `LEIA-ME.txt`.
Depois de mudar o código, gere de novo com:

```
python -m PyInstaller --noconfirm --onefile --name FlipGW2 --add-data "web;web" --distpath distribuir servidor.py
```

O .exe não leva seus dados: cache, ordens e histórico são criados ao lado dele na primeira execução.

## Versão para o navegador (`site/`)

A pasta `site/` é o mesmo app rodando 100% no navegador, sem Python e sem servidor. É ela que vai
para o GitHub Pages, Netlify, Cloudflare Pages ou Vercel. O motor (`motor.js`) é a conversão do `flip.py`
e dá exatamente os mesmos números.

- **Onde salva:** ordens e histórico no `localStorage` do navegador. O cache dos dados do TP fica no IndexedDB
  (apagado sozinho depois de 2 dias). Cada pessoa que abre o site tem os próprios dados.
- **Backup:** botões "Baixar backup" e "Carregar backup" no fim da página. O "Carregar" também aceita o
  `dados/ordens.json` e o `dados/historico.jsonl` desta versão de PC, para migrar.
- **Peso:** uma análise baixa ~2 MB (a lista de itens vem comprimida e os históricos só com os campos usados).
  As seguintes, dentro de 10 minutos, saem do cache em menos de 1 segundo.
- **Testar no PC:** `python -m http.server 8000 --directory site` e abra http://127.0.0.1:8000.
- **Ajustes finos:** em `site/motor.js`, no bloco `PADRAO` (o `config.json` não é lido pelo site).

### Publicar

- **GitHub Pages:** suba o projeto para um repositório, branch `main`. Em *Settings → Pages → Source*,
  escolha **GitHub Actions**. O arquivo `.github/workflows/pages.yml` publica a pasta `site/` a cada push.
- **Netlify / Cloudflare Pages / Vercel:** conecte o repositório e diga que a pasta publicada é `site`,
  sem comando de build.

O `.gitignore` deixa de fora `cache/`, `dados/` (suas ordens), `relatorios/` e o `.exe`.

## Arquivos

- `site/` — versão para o navegador (`index.html`, `motor.js`, `dados.js`, `app.js`, `style.css`)
- `rodar.bat` — abre o app
- `servidor.py` — servidor local (http://127.0.0.1:8787)
- `flip.py` — motor de análise
- `ordens.py` — suas ordens e o histórico
- `web/` — interface (HTML, CSS, JS)
