#!/usr/bin/env python3
"""Local web server for Teleprompt Pro.

Same as `python3 -m http.server`, but sends no-cache headers so the browser
always picks up app updates immediately.
"""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8347


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass  # keep the terminal quiet


if __name__ == '__main__':
    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Teleprompt Pro running at http://localhost:{PORT}')
    server.serve_forever()
