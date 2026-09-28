import http.server, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        host=self.headers.get('Host','')
        if 'doubleclick' in host or 'google-analytics' in host:
            if self.path.endswith('.gif'):
                self.send_response(200); self.send_header('Content-Type','image/gif'); self.end_headers()
                self.wfile.write(b'GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;'); return
            self.path='/ads.js'
        return super().do_GET()
http.server.ThreadingHTTPServer(('127.0.0.1',80),H).serve_forever()
