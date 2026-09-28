// Rýchly test rýchlosti internetu (odozva, sťahovanie, odosielanie) cez servery Cloudflare.
// Používa sieťové jadro Chromium, takže rešpektuje systémové proxy a firemné certifikáty.
const { net } = require('electron');

const BASE = process.env.SOVA_SPEED_BASE || 'https://speed.cloudflare.com';
const now = () => performance.now();

async function ping(n = 6) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t = now();
    const r = await net.fetch(`${BASE}/__down?bytes=0&r=${Math.random()}`, { cache: 'no-store' });
    await r.arrayBuffer();
    times.push(now() - t);
  }
  times.shift(); // prvé meranie obsahuje nadviazanie spojenia
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

// Beží `parallel` súbežných prenosov po dobu `ms`; výsledok = priemer bez prvej sekundy (rozbeh)
async function measure(ms, parallel, worker, report, isCancelled) {
  const start = now();
  let bytes = 0, warmBytes = 0, warmAt = 0;
  const add = (n) => { bytes += n; };
  const stop = () => isCancelled() || now() - start > ms;
  const timer = setInterval(() => {
    const el = now() - start;
    if (!warmAt && el > 1000) { warmAt = el; warmBytes = bytes; }
    if (el > 300) report((bytes * 8) / (el / 1000));
  }, 250);
  await Promise.all(Array.from({ length: parallel }, () => worker(add, stop).catch(() => {})));
  clearInterval(timer);
  const el = now() - start;
  return warmAt && el > warmAt ? ((bytes - warmBytes) * 8) / ((el - warmAt) / 1000) : (bytes * 8) / (el / 1000);
}

async function runSpeedTest(onProgress, isCancelled = () => false) {
  const res = { ping: null, down: null, up: null };
  res.ping = await ping();
  onProgress({ phase: 'ping', ...res });
  if (isCancelled()) return res;

  res.down = await measure(8000, 4, async (add, stop) => {
    while (!stop()) {
      const r = await net.fetch(`${BASE}/__down?bytes=50000000&r=${Math.random()}`, { cache: 'no-store' });
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        add(value.length);
        if (stop()) { reader.cancel().catch(() => {}); break; }
      }
    }
  }, (bps) => onProgress({ phase: 'download', live: bps, ...res }), isCancelled);
  onProgress({ phase: 'download-done', ...res });
  if (isCancelled()) return res;

  const chunk = new Uint8Array(2 * 1024 * 1024);
  for (let i = 0; i < chunk.length; i += 4096) chunk[i] = (i * 31) & 255;
  res.up = await measure(8000, 3, async (add, stop) => {
    while (!stop()) {
      const r = await net.fetch(`${BASE}/__up?r=${Math.random()}`, { method: 'POST', body: chunk, cache: 'no-store' });
      await r.arrayBuffer();
      add(chunk.length);
    }
  }, (bps) => onProgress({ phase: 'upload', live: bps, ...res }), isCancelled);
  onProgress({ phase: 'done', ...res });
  return res;
}

module.exports = { runSpeedTest };
