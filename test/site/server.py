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
        if self.path.startswith('/__redir'):
            import urllib.parse as up
            to=up.parse_qs(up.urlparse(self.path).query).get('to',['/'])[0]
            self.send_response(302); self.send_header('Location',to); self.end_headers(); return
        if self.path.startswith('/__down'):
            import urllib.parse as up
            n=int(up.parse_qs(up.urlparse(self.path).query).get('bytes',['0'])[0])
            self.send_response(200); self.send_header('Content-Type','application/octet-stream'); self.send_header('Content-Length',str(n)); self.end_headers()
            chunk=b'x'*65536; sent=0
            try:
                while sent<n:
                    k=min(len(chunk),n-sent); self.wfile.write(chunk[:k]); sent+=k
            except Exception: pass
            return
        if self.path.startswith('/big.bin'):
            import urllib.parse as up, time
            qs=up.parse_qs(up.urlparse(self.path).query); n=int(qs.get('size',['3000000'])[0]); rate=int(qs.get('rate',['1000000'])[0])
            self.send_response(200); self.send_header('Content-Type','application/octet-stream'); self.send_header('Content-Length',str(n))
            self.send_header('Content-Disposition','attachment; filename="testovaci subor.zip"'); self.end_headers()
            sent=0; step=max(1,rate//10)
            try:
                while sent<n:
                    k=min(step,n-sent); self.wfile.write(b'z'*k); sent+=k; time.sleep(0.1)
            except Exception: pass
            return
        if self.path.startswith('/yt.html'):
            b=open('yt.html','rb').read()
            self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8')
            self.send_header('Content-Security-Policy',"script-src 'nonce-abc'; require-trusted-types-for 'script'")
            self.end_headers(); self.wfile.write(b); return
        return super().do_GET()
    def do_POST(self):
        if self.path.startswith('/__up'):
            n=int(self.headers.get('Content-Length','0')); self.rfile.read(n)
            self.send_response(200); self.send_header('Content-Type','text/plain'); self.end_headers(); self.wfile.write(b'ok'); return
        if self.path.startswith('/youtubei/v1/player'):
            b=b'{"adPlacements":[1],"playerAds":[2],"streamingData":{"ok":1}}'
            self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b); return
        self.send_response(404); self.end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1',80),H).serve_forever()
