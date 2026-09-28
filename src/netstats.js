// Aktuálna rýchlosť siete celého počítača (všetky aplikácie), meraná z počítadiel sieťových kariet.
const fs = require('fs');
const { execFile } = require('child_process');

function readTotals() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // „netstat -e“ vypíše prijaté/odoslané bajty – prvý riadok s dvoma číslami (popis je lokalizovaný)
      execFile('netstat', ['-e'], { windowsHide: true, timeout: 3000 }, (err, out) => {
        if (err || !out) return resolve(null);
        const line = out.split(/\r?\n/).find((l) => /\S.*\s(\d+)\s+(\d+)\s*$/.test(l));
        const m = line && /(\d+)\s+(\d+)\s*$/.exec(line);
        resolve(m ? { rx: Number(m[1]), tx: Number(m[2]) } : null);
      });
    } else {
      try {
        let rx = 0, tx = 0;
        for (const l of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
          const [iface, rest] = l.split(':');
          if (!rest || iface.trim() === 'lo') continue;
          const f = rest.trim().split(/\s+/).map(Number);
          rx += f[0]; tx += f[8];
        }
        resolve({ rx, tx });
      } catch { resolve(null); }
    }
  });
}

class NetStats {
  constructor(onUpdate, intervalMs = 2000) {
    this.onUpdate = onUpdate;
    this.down = 0; // bity za sekundu
    this.up = 0;
    this.prev = null;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }
  async tick() {
    const cur = await readTotals();
    const now = Date.now();
    if (cur && this.prev) {
      const dt = (now - this.prev.t) / 1000;
      // Windows počítadlá sú 32-bitové a po 4 GB pretečú
      const delta = (a, b) => { let d = a - b; if (d < 0) d += 2 ** 32; return d; };
      if (dt > 0) {
        this.down = (delta(cur.rx, this.prev.rx) * 8) / dt;
        this.up = (delta(cur.tx, this.prev.tx) * 8) / dt;
        this.onUpdate();
      }
    }
    if (cur) this.prev = { ...cur, t: now };
  }
  stop() { clearInterval(this.timer); }
}

module.exports = { NetStats };
