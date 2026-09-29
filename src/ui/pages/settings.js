// sova://settings – nastavenia sa ukladajú hneď pri zmene
const api = window.sova;
const toast = document.getElementById('toast');
let toastTimer;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1400);
}

async function load() {
  const s = await api.invoke('settings:get');
  for (const el of document.querySelectorAll('[data-key]')) {
    const v = s[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v;
    else if ('list' in el.dataset) el.value = (v || []).join('\n');
    else el.value = String(v);
  }
}

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-key]');
  if (!el) return;
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if ('list' in el.dataset) {
    v = el.value.split(/[\s,]+/).map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
  } else if ('num' in el.dataset) v = Number(el.value);
  else v = el.value;
  await api.invoke('settings:set', { [el.dataset.key]: v });
  showToast('Uložené');
});

document.getElementById('cleardata').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  await api.invoke('clear-data');
  b.disabled = false;
  showToast('Údaje prehliadania vymazané');
});

async function showDir() { document.getElementById('dldir').textContent = await api.invoke('settings:download-dir'); }
document.getElementById('pickdir').addEventListener('click', async () => {
  const d = await api.invoke('settings:pick-download-dir');
  if (d) { showDir(); showToast('Uložené'); }
});
showDir();

// po návrate na kartu načítať aktuálny stav (napr. „Nikdy neuspávať“ zmenené cez menu karty)
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
load();

// ---------------------------------------------------------------- aktualizácie
const upBtn = document.getElementById('upbtn');
const hm = (t) => new Date(t).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
async function renderUpdate() {
  const u = await api.invoke('update:state');
  document.getElementById('upver').textContent = u.version + (u.portable ? ' (prenosná)' : '')
    + (u.chrome ? ` · Chromium ${u.chrome} · Electron ${u.electron}` : '');
  const txt = {
    disabled: 'Aktualizácie fungujú len v nainštalovanej verzii (nie pri spustení cez npm start).',
    idle: 'Kontrola prebehne o chvíľu po spustení a potom každé 4 hodiny.',
    checking: 'Hľadám aktualizácie…',
    latest: `Máš najnovšiu verziu · skontrolované o ${hm(u.lastCheck)}`,
    available: `K dispozícii je verzia ${u.newVersion}.`,
    downloading: `Sťahujem verziu ${u.newVersion}… ${u.progress || 0} %`,
    ready: `Verzia ${u.newVersion} je stiahnutá a pripravená na inštaláciu.`,
    portable: `Na GitHube je verzia ${u.newVersion}. Prenosná verzia sa neaktualizuje sama – stiahni si novú.`,
    error: `Kontrola zlyhala: ${u.error}`,
  }[u.status] || '';
  document.getElementById('upstatus').textContent = txt;
  const btn = { available: 'Stiahnuť', ready: 'Reštartovať a aktualizovať', portable: 'Otvoriť stránku na stiahnutie', error: 'Skúsiť znova' }[u.status] || 'Skontrolovať teraz';
  upBtn.textContent = btn;
  upBtn.classList.toggle('primary', u.status === 'ready');
  upBtn.disabled = ['disabled', 'checking', 'downloading'].includes(u.status);
  upBtn.dataset.status = u.status;
}
upBtn.addEventListener('click', async () => {
  const st = upBtn.dataset.status;
  if (st === 'ready' || st === 'portable') return api.invoke('update:install');
  if (st === 'available') return api.invoke('update:download');
  upBtn.disabled = true;
  await api.invoke('update:check');
  renderUpdate();
});
api.on('update:changed', renderUpdate);
renderUpdate();

// ---------------------------------------------------------------- predvolený prehliadač
const defBtn = document.getElementById('defbtn');
async function renderDefault() {
  const d = await api.invoke('default:status');
  const st = document.getElementById('defstatus');
  if (!d.supported) {
    st.textContent = 'Dá sa nastaviť len v nainštalovanej verzii (nie pri spustení cez npm start).';
    defBtn.hidden = true;
  } else if (d.isDefault) {
    st.textContent = 'Sova je tvoj predvolený prehliadač – odkazy z Outlooku, Teams a iných aplikácií sa otvárajú tu.';
    defBtn.hidden = true;
  } else {
    st.textContent = 'Odkazy z iných aplikácií sa teraz otvárajú v inom prehliadači. Windows ťa pustí do nastavení, kde klikneš na „Nastaviť predvolené“.';
    defBtn.hidden = false;
  }
}
defBtn.addEventListener('click', async () => {
  defBtn.disabled = true;
  await api.invoke('default:set');
  defBtn.disabled = false;
});
window.addEventListener('focus', renderDefault);            // návrat z Nastavení Windows
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderDefault(); });
renderDefault();

// ---------------------------------------------------------------- ochrana pred nebezpečnými stránkami
const sbBtn = document.getElementById('sbbtn');
const nf = new Intl.NumberFormat('sk-SK');
const ago = (t) => {
  if (!t) return 'ešte nie';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'práve teraz' : m < 60 ? `pred ${m} min` : `o ${hm(t)}`;
};
async function renderSafe() {
  const s = await api.invoke('safe:state');
  const parts = s.lists.map((l) => `${l.name}: ${l.count ? nf.format(l.count) : '—'}${l.error && !l.count ? ' (nedostupný)' : ''}`);
  const last = Math.max(0, ...s.lists.map((l) => l.fetched));
  document.getElementById('sbstatus').textContent = s.checking ? 'Aktualizujem zoznamy…'
    : `${nf.format(s.total)} nebezpečných stránok · skontrolované ${ago(last)}. ${parts.join(' · ')}`;
  sbBtn.disabled = s.checking;
}
sbBtn.addEventListener('click', async () => { sbBtn.disabled = true; await api.invoke('safe:refresh'); renderSafe(); });
api.on('safe:changed', renderSafe);
renderSafe();

// ---------------------------------------------------------------- bočné menu a hľadanie
const secs = [...document.querySelectorAll('.sec')];
const navLinks = [...document.querySelectorAll('#nav a')];
function spy() {
  let cur = secs.find((s) => !s.hidden) || secs[0];
  for (const s of secs) if (!s.hidden && s.getBoundingClientRect().top <= 90) cur = s;
  // na konci stránky vyznačíme posledný viditeľný oddiel
  if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) cur = [...secs].reverse().find((s) => !s.hidden) || cur;
  for (const a of navLinks) a.classList.toggle('on', a.dataset.sec === cur?.id);
}
window.addEventListener('scroll', spy, { passive: true });
for (const a of navLinks) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const s = document.getElementById(a.dataset.sec);
    if (!s || s.hidden) return;
    s.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', '#' + a.dataset.sec);
  });
}
if (location.hash) requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' }));
spy();

const plain = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const squash = (s) => s.replace(/[\s+]/g, '');            // „ctrl+d“ nájde aj skratku Ctrl D
document.getElementById('q').addEventListener('input', (e) => {
  const q = plain(e.target.value.trim());
  let any = false;
  for (const s of secs) {
    const title = plain(s.querySelector('h2').textContent);
    const rows = [...s.querySelectorAll('.row, .col, .krow')];
    let hits = 0;
    for (const r of rows) {
      const t = plain(r.textContent);
      const show = !q || title.includes(q) || t.includes(q) || squash(t).includes(squash(q));
      r.hidden = !show;
      if (show) hits++;
    }
    for (const g of s.querySelectorAll('.kgroup')) g.hidden = ![...g.querySelectorAll('.krow')].some((r) => !r.hidden);
    s.hidden = !!q && !hits;
    if (!s.hidden) any = true;
    navLinks.find((a) => a.dataset.sec === s.id)?.classList.toggle('off', s.hidden);
  }
  document.getElementById('nothing').hidden = any;
  if (q) window.scrollTo(0, 0);
  spy();
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA')) {
    e.preventDefault();
    document.getElementById('q').focus();
  }
});

document.getElementById('incog').addEventListener('click', () => api.invoke('window:incognito'));
