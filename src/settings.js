// Jednoduché nastavenia uložené v JSON súbore v priečinku používateľa (%APPDATA%\Sova).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULTS = {
  freezeDelaySec: 3,        // po koľkých sekundách sa neaktívna karta zmrazí (0 = hneď)
  discardAfterMin: 10,      // po koľkých minútach sa zmrazená karta uspí (uvoľní RAM); 0 = nikdy
  keepAudibleAwake: true,   // karty, ktoré hrajú zvuk (hudba, hovor), sa nezmrazujú
  adblock: true,
  adblockLevel: 'ads',      // 'ads' = reklamy + sledovanie, 'full' = aj cookie lišty a otravné prvky
  allowlist: [],            // domény, na ktorých je blokovanie vypnuté
  neverSleep: [],           // domény, ktoré sa nikdy nezmrazia/neuspia (napr. outlook.office.com, teams.microsoft.com)
  searchEngine: 'google',   // google | duckduckgo | bing
  restoreSession: true,     // po spustení obnoviť karty (uspaté, nenačítavajú sa)
  showBookmarkBar: true,    // lišta záložiek pod adresným riadkom (Ctrl+Shift+B)
  tabsPosition: 'top',      // 'top' = karty hore (ako Chrome), 'bottom' = adresa hore, karty a záložky dole
  downloadDir: '',          // priečinok na stiahnuté súbory ('' = Stiahnuté/Downloads)
  askWhereToSave: false,    // pri každom sťahovaní sa spýtať, kam uložiť
};

const SEARCH = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
};

class Settings extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch { /* prvé spustenie */ }
  }
  get(key) { return this.data[key]; }
  all() { return { ...this.data }; }
  set(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS)) continue;
      const old = this.data[k];
      this.data[k] = v;
      if (JSON.stringify(old) !== JSON.stringify(v)) this.emit('change', k, v, old);
    }
    this.save();
  }
  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); } catch (e) { console.error(e); }
  }
  searchUrl(q) { return (SEARCH[this.data.searchEngine] || SEARCH.google) + encodeURIComponent(q); }
}

module.exports = { Settings, DEFAULTS };
