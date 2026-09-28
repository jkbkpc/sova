// sova://downloads – všetky stiahnuté súbory
const api = window.sova;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FILE = '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const size = (b) => !b ? '0 B' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} kB` : b < 1073741824 ? `${(b / 1048576).toFixed(1).replace('.', ',')} MB` : `${(b / 1073741824).toFixed(2).replace('.', ',')} GB`;
const dur = (s) => s < 60 ? `${Math.max(1, Math.round(s))} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1).replace('.', ',')} h`;
let q = '';

let toastTimer;
function toast(t) {
  $('#toast').textContent = t;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2000);
}

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  const date = d.toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'long' });
  return diff === 0 ? `Dnes – ${date}` : diff === 1 ? `Včera – ${date}` : date.charAt(0).toUpperCase() + date.slice(1);
}

function status(d) {
  const time = new Date(d.end || d.start).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
  if (d.state === 'progressing') {
    if (d.paused) return `Pozastavené · ${size(d.received)}${d.total ? ' z ' + size(d.total) : ''}`;
    const left = d.total && d.speed > 0 ? ` · zostáva ${dur((d.total - d.received) / d.speed)}` : '';
    return `${size(d.received)}${d.total ? ' z ' + size(d.total) : ''} · ${size(d.speed)}/s${left}`;
  }
  if (d.state === 'completed') return d.exists === false ? `Súbor bol presunutý alebo odstránený · ${time}` : `${size(d.received || d.total)} · ${time}`;
  if (d.state === 'cancelled') return `Zrušené · ${time}`;
  return `Prerušené · ${time}`;
}

async function render() {
  const list = await api.invoke('downloads:list', q);
  const box = $('#list');
  box.innerHTML = '';
  if (!list.length) box.innerHTML = `<div class="empty">${q ? 'Nič sa nenašlo.' : 'Zatiaľ si nič nestiahol.'}</div>`;
  let lastDay = '';
  for (const d of list) {
    const day = dayLabel(d.start);
    if (day !== lastDay) { lastDay = day; box.insertAdjacentHTML('beforeend', `<div class="day">${esc(day)}</div>`); }
    const ok = d.state === 'completed' && d.exists !== false;
    const el = document.createElement('div');
    el.className = 'item' + (d.state === 'cancelled' || d.exists === false ? ' bad' : '');
    const btn = (a, t, cls = '') => `<button class="btn ${cls}" data-a="${a}">${t}</button>`;
    let acts = '';
    if (d.state === 'progressing') acts = btn(d.paused ? 'resume' : 'pause', d.paused ? 'Pokračovať' : 'Pozastaviť') + btn('cancel', 'Zrušiť', 'danger');
    else if (ok) acts = btn('show', 'Zobraziť v priečinku') + btn('trash', 'Do koša', 'danger') + btn('remove', 'Zo zoznamu');
    else acts = btn('retry', 'Stiahnuť znova', 'primary') + btn('remove', 'Zo zoznamu');
    const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : 30;
    el.innerHTML = `<div class="fi">${d.icon ? `<img src="${d.icon}">` : FILE}</div>
      <div class="info">
        <div class="name">${ok ? `<a data-a="open">${esc(d.filename)}</a>` : esc(d.filename)}</div>
        <div class="url" title="${esc(d.url)}">${esc(d.url)}</div>
        <div class="st${d.state === 'interrupted' ? ' err' : ''}">${esc(status(d))}</div>
        ${d.state === 'progressing' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      <div class="acts">${acts}</div>`;
    el.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'trash') { if (await api.invoke('downloads:trash', d.id)) toast('Súbor presunutý do koša'); return; }
      await api.invoke('downloads:' + a, d.id);
    });
    box.appendChild(el);
  }
}

$('#folder').addEventListener('click', () => api.invoke('downloads:folder'));
$('#clear').addEventListener('click', async () => { await api.invoke('downloads:clear'); toast('Zoznam vymazaný (súbory ostali na disku)'); });
let t;
$('#search').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value; render(); }, 120); });
let pending = false;
api.on('downloads:changed', () => {            // počas sťahovania najviac 2× za sekundu
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; render(); }, 500);
});
api.invoke('downloads:dir').then((d) => { $('#dir').textContent = `Súbory sa ukladajú do: ${d} (zmeníš v Nastaveniach)`; });
render();
