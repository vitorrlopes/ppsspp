#!/usr/bin/env python3
# Serves web/dist locally with the headers the threaded build needs (the same ones as
# frontend/_headers). Usage: python3 web/serve.py [port]
#
# Browsers treat http://localhost as a secure context, so OPFS and service workers work here.
# From another device, use HTTPS (a tunnel or the real host).

import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
	extensions_map = {
		**http.server.SimpleHTTPRequestHandler.extensions_map,
		'.wasm': 'application/wasm',
		'.mjs': 'text/javascript',
		'.js': 'text/javascript',
		'.webmanifest': 'application/manifest+json',
	}

	def end_headers(self):
		self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
		self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
		self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
		self.send_header('Cache-Control', 'no-cache')
		super().end_headers()


def main():
	port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
	root = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist')
	handler = lambda *args, **kw: Handler(*args, directory=root, **kw)
	with http.server.ThreadingHTTPServer(('127.0.0.1', port), handler) as httpd:
		print(f'Serving {root} at http://localhost:{port}/')
		httpd.serve_forever()


if __name__ == '__main__':
	main()
