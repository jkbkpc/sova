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
  document.getElementById('upver').textContent = u.version + (u.portable ? ' (prenosná)' : '');
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
