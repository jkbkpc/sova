// sova://history – prehľad, hľadanie, výber a mazanie histórie
const api = window.sova;
const $ = (s) => document.querySelector(s);
const list = $('#list');
const PAGE = 150;
const st = { q: '', lastId: Infinity, done: false, loading: false, lastDay: '', selected: new Set(), anchor: null };
const CLOSE = '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  const date = d.toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'long',
    year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
  return diff === 0 ? `Dnes – ${date}` : diff === 1 ? `Včera – ${date}` : date.charAt(0).toUpperCase() + date.slice(1);
}

// ------------------------------------------------------------ výber
const rows = () => [...list.querySelectorAll('.hrow')];
function updateSelection() {
  for (const r of rows()) {
    const on = st.selected.has(+r.dataset.id);
    r.classList.toggle('checked', on);
    r.querySelector('input').checked = on;
  }
  for (const d of list.querySelectorAll('.day')) {
    const own = rows().filter((r) => r.dataset.day === d.dataset.day);
    const n = own.filter((r) => st.selected.has(+r.dataset.id)).length;
    const cb = d.querySelector('input');
    cb.checked = n > 0 && n === own.length;
    cb.indeterminate = n > 0 && n < own.length;
  }
  $('#selcount').textContent = `Vybrané: ${st.selected.size}`;
  $('#selbar').classList.toggle('show', st.selected.size > 0);
}
function toggleRow(r, shift) {
  const id = +r.dataset.id;
  const on = !st.selected.has(id);
  if (shift && st.anchor !== null) {          // Shift = celý rozsah od posledného kliknutia
    const all = rows();
    const a = all.findIndex((x) => +x.dataset.id === st.anchor);
    const b = all.indexOf(r);
    if (a >= 0) {
      for (const x of all.slice(Math.min(a, b), Math.max(a, b) + 1)) {
        on ? st.selected.add(+x.dataset.id) : st.selected.delete(+x.dataset.id);
      }
    }
  } else {
    on ? st.selected.add(id) : st.selected.delete(id);
  }
  st.anchor = id;
  updateSelection();
}

// ------------------------------------------------------------ zoznam
function addDay(day) {
  const h = document.createElement('div');
  h.className = 'day';
  h.dataset.day = day;
  h.innerHTML = `<input type="checkbox" title="Označiť celý deň"><span>${esc(day)}</span>`;
  h.querySelector('input').addEventListener('change', (e) => {
    for (const r of rows()) if (r.dataset.day === day) e.target.checked ? st.selected.add(+r.dataset.id) : st.selected.delete(+r.dataset.id);
    updateSelection();
  });
  list.appendChild(h);
}

function addRow(e, day) {
  const r = document.createElement('div');
  r.className = 'hrow';
  r.dataset.id = e.id;
  r.dataset.day = day;
  r.title = e.url;
  const time = new Date(e.ts).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
  r.innerHTML = `<input type="checkbox"><span class="htime">${time}</span>
    <span class="hfav">${e.favicon ? `<img src="${esc(e.favicon)}">` : '<span class="dot"></span>'}</span>
    <span class="htitle">${esc(e.title || e.url)}</span><span class="hhost">${esc(e.host)}</span>
    <button class="icon hdel" title="Odstrániť z histórie">${CLOSE}</button>`;
  const img = r.querySelector('img');
  if (img) img.onerror = () => { r.querySelector('.hfav').innerHTML = '<span class="dot"></span>'; };
  const cb = r.querySelector('input');
  cb.addEventListener('click', (ev) => toggleRow(r, ev.shiftKey));
  r.querySelector('.hdel').addEventListener('click', () => removeIds([e.id]));
  r.addEventListener('mousedown', (ev) => { if (ev.button === 1) ev.preventDefault(); });
  r.addEventListener('mouseup', (ev) => {
    if (ev.target.closest('input, button')) return;
    // keď je niečo označené, kliknutie na riadok ho označí (ako v Chrome)
    if (st.selected.size && ev.button === 0) { toggleRow(r, ev.shiftKey); return; }
    if (ev.button === 0) api.send('history:open', e.url, !ev.ctrlKey);   // nová karta v popredí
    if (ev.button === 1) api.send('history:open', e.url, false);        // stredné tlačidlo = na pozadí
  });
  list.appendChild(r);
}

async function load(reset) {
  if (reset) {
    list.innerHTML = '';
    Object.assign(st, { lastId: Infinity, done: false, lastDay: '', anchor: null });
    st.selected.clear();
    updateSelection();
  }
  if (st.done || st.loading) return;
  st.loading = true;
  const q = st.q;
  const data = await api.invoke('history:query', { q, before: st.lastId, limit: PAGE });
  st.loading = false;
  if (q !== st.q) return;
  for (const e of data) {
    const day = dayLabel(e.ts);
    if (day !== st.lastDay) { st.lastDay = day; addDay(day); }
    addRow(e, day);
    st.lastId = e.id;
  }
  if (data.length < PAGE) st.done = true;
  if (!list.children.length) list.innerHTML = `<div class="empty">${q ? 'Nič sa nenašlo.' : 'História je prázdna.'}</div>`;
  $('#more').textContent = st.done ? '' : 'Načítavam ďalšie…';
  // ak sa stránka ešte nezaplnila, načítať ďalšiu dávku
  if (!st.done && document.documentElement.scrollHeight <= innerHeight + 200) load(false);
}

// ------------------------------------------------------------ mazanie
async function removeIds(ids) {
  const n = await api.invoke('history:removeMany', ids);
  for (const id of ids) {
    list.querySelector(`.hrow[data-id="${id}"]`)?.remove();
    st.selected.delete(id);
  }
  for (const d of [...list.querySelectorAll('.day')]) {
    if (!rows().some((r) => r.dataset.day === d.dataset.day)) d.remove();
  }
  if (!list.children.length) list.innerHTML = '<div class="empty">História je prázdna.</div>';
  updateSelection();
  toast(n === 1 ? 'Záznam zmazaný' : `Zmazané záznamy: ${n}`);
}

$('#seldel').addEventListener('click', () => removeIds([...st.selected]));
$('#selnone').addEventListener('click', () => { st.selected.clear(); updateSelection(); });

const rangeBtn = $('#clearrange');
let confirmTimer;
function resetRangeBtn() { rangeBtn.classList.remove('solid'); rangeBtn.textContent = 'Vymazať'; }
$('#range').addEventListener('change', resetRangeBtn);
rangeBtn.addEventListener('click', async () => {
  if (!rangeBtn.classList.contains('solid')) {     // prvé kliknutie = potvrdenie
    rangeBtn.classList.add('solid');
    rangeBtn.textContent = 'Naozaj vymazať?';
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(resetRangeBtn, 4000);
    return;
  }
  clearTimeout(confirmTimer);
  resetRangeBtn();
  const sel = $('#range');
  const n = await api.invoke('history:removeSince', Number(sel.value));
  toast(`${sel.options[sel.selectedIndex].text}: zmazané záznamy ${n}`);
  load(true);
});

// ------------------------------------------------------------ hľadanie, posúvanie
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { st.q = e.target.value; load(true); }, 150);
});
addEventListener('scroll', () => {
  if (scrollY + innerHeight > document.documentElement.scrollHeight - 500) load(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && st.selected.size) { st.selected.clear(); updateSelection(); }
  if (e.key === 'Delete' && st.selected.size && document.activeElement?.id !== 'search') removeIds([...st.selected]);
});
// po návrate na kartu obnoviť zoznam (pribudli nové návštevy), pokiaľ niečo nie je označené
document.addEventListener('visibilitychange', () => { if (!document.hidden && !st.selected.size) load(true); });
load(true);
