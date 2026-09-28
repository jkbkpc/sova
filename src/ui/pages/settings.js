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
