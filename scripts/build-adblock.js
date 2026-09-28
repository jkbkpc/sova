// Stiahne aktuálne zoznamy filtrov a uloží ich ako záložný (offline) engine,
// ktorý sa pribalí do inštalácie. Spúšťa sa pred buildom: npm run build-adblock
const fs = require('fs');
const path = require('path');
const { FiltersEngine } = require('@ghostery/adblocker');

(async () => {
  const out = path.join(__dirname, '..', 'resources');
  fs.mkdirSync(out, { recursive: true });
  const levels = {
    ads: () => FiltersEngine.fromPrebuiltAdsAndTracking(fetch),
    full: () => FiltersEngine.fromPrebuiltFull(fetch),
  };
  for (const [name, load] of Object.entries(levels)) {
    const engine = await load();
    const file = path.join(out, `adblock-${name}.bin`);
    fs.writeFileSync(file, engine.serialize());
    console.log(`${file}: ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
