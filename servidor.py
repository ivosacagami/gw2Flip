#!/usr/bin/env python3
"""
Servidor local da interface do Flip GW2.
Sobe em http://127.0.0.1:8787 (ou a próxima porta livre) e abre o navegador.
"""
import json
import sys
import threading
import traceback
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import flip
import ordens

# No .exe a interface vem dentro do pacote (sys._MEIPASS); rodando o .py, da pasta web/
WEB = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "web"
TIPOS = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"}
trava = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silencia o log de cada requisição

    def _enviar(self, status, corpo, tipo):
        self.send_response(status)
        self.send_header("Content-Type", tipo)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def _json(self, status, dados):
        self._enviar(status, json.dumps(dados, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/analisar":
            return self._analisar(parse_qs(url.query))
        if url.path == "/api/ordens":
            return self._json(200, ordens.listar(flip.carregar_config()))
        nome = "index.html" if url.path in ("", "/") else url.path.lstrip("/")
        arq = (WEB / nome).resolve()
        if WEB not in arq.parents or not arq.is_file():
            return self._enviar(404, b"nao encontrado", "text/plain")
        self._enviar(200, arq.read_bytes(), TIPOS.get(arq.suffix, "application/octet-stream"))

    def do_POST(self):
        # Só aceita JSON: um site de fora não consegue enviar isso sem permissão do navegador
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self._json(415, {"erro": "Envie JSON."})
        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho > 65536:
            return self._json(413, {"erro": "Requisição grande demais."})
        try:
            dados = json.loads(self.rfile.read(tamanho) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"erro": "JSON inválido."})

        partes = urlparse(self.path).path.strip("/").split("/")
        try:
            if partes == ["api", "ordens"]:
                return self._json(201, ordens.adicionar(dados))
            if len(partes) == 3 and partes[:2] == ["api", "ordens"]:
                ordens.atualizar(partes[2], dados)
                return self._json(200, {"ok": True})
        except KeyError as e:
            return self._json(404, {"erro": str(e.args[0])})
        except ValueError as e:
            return self._json(400, {"erro": str(e)})
        self._json(404, {"erro": "Rota não encontrada."})

    def _analisar(self, q):
        try:
            ouro = float(q.get("ouro", ["0"])[0].replace(",", "."))
        except ValueError:
            return self._json(400, {"erro": "Valor de ouro inválido."})
        if ouro <= 0:
            return self._json(400, {"erro": "Informe quanto ouro você tem para investir."})
        atualizar = q.get("atualizar", ["0"])[0] == "1"

        with trava:  # uma análise por vez
            try:
                cfg = flip.carregar_config(ouro_disponivel=ouro)
                res, plano, stats = flip.executar(cfg, usar_cache=not atualizar,
                                                  log=lambda m: print("  " + m))
            except Exception as e:
                traceback.print_exc()
                return self._json(502, {"erro": f"Não consegui buscar os dados do Trading Post: {e}"})

        print(f"  Pronto: {stats['aprovados']} flips aprovados, {len(plano['ids'])} no plano.")
        self._json(200, {
            "gerado_em": datetime.now().isoformat(timespec="seconds"),
            "ouro": ouro,
            "config": {k: cfg[k] for k in ("reserva", "fracao_max_por_item", "captura_estimada",
                                           "janela_regularidade_horas", "max_horas_sem_venda",
                                           "semanas_dia")},
            "stats": stats,
            "plano": plano,
            "itens": res,
        })


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    for porta in range(8787, 8800):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", porta), Handler)
            break
        except OSError:
            continue
    else:
        sys.exit("Nenhuma porta livre entre 8787 e 8799.")

    endereco = f"http://127.0.0.1:{porta}"
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.kernel32.SetConsoleTitleW("Flip GW2 — deixe aberta enquanto usa")
    print(f"Flip GW2 rodando em {endereco}")
    print("Se o navegador não abrir sozinho, copie o endereço acima e cole nele.")
    print("Deixe esta janela aberta enquanto usa. Feche-a para encerrar.\n")
    if "--sem-navegador" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(endereco)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
