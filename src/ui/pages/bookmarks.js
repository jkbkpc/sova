// sova://bookmarks – správca záložiek
const api = window.sova;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SVG = {
  folder: '<svg viewBox="0 0 16 16"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6h5.5c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/></svg>',
  globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>',
  arrow: '<svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg>',
  edit: '<svg viewBox="0 0 16 16"><path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5v-3z"/></svg>',
  del: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/></svg>',
  open: '<svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4"/></svg>',
};
const st = { tree: null, sel: 'bar', expanded: new Set(['root', 'bar', 'other']), q: '', drag: null };

// ------------------------------------------------------------ pomocné
function find(id, n = st.tree, parent = null) {
  if (!n) return null;
  if (n.id === id) return { node: n, parent };
  for (const c of n.children || []) { const r = find(id, c, n); if (r) return r; }
  return null;
}
function pathTo(id) {
  const out = [];
  const rec = (n, trail) => {
    if (n.id === id) { out.push(...trail, n); return true; }
    return (n.children || []).some((c) => c.type === 'folder' && rec(c, [...trail, n]));
  };
  rec(st.tree, []);
  return out.filter((n) => n.id !== 'root');
}
const host = (u) => { try { return new URL(u).host; } catch { return u; } };

let toastTimer;
function toast(text, undo) {
  $('#toasttext').textContent = text;
  const b = $('#undo');
  b.hidden = !undo;
  b.onclick = undo ? async () => { await undo(); $('#toast').classList.remove('show'); } : null;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), undo ? 6000 : 2200);
}

// ------------------------------------------------------------ ťahanie myšou
function dropTarget(el, getMode, onDrop) {
  el.addEventListener('dragover', (e) => {
    if (!st.drag) return;
    const mode = getMode(e);
    if (!mode) return;
    e.preventDefault();
    clearDrop();
    el.classList.add('drop-' + mode);
    el.dataset.drop = mode;
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    const mode = el.dataset.drop;
    clearDrop();
    if (st.drag && mode) await onDrop(mode, st.drag);
    st.drag = null;
  });
}
function clearDrop() {
  for (const x of document.querySelectorAll('.drop-before, .drop-after, .drop-into')) x.classList.remove('drop-before', 'drop-after', 'drop-into');
}
const canDropInto = (folderId) => st.drag && st.drag !== folderId && !pathTo(folderId).some((n) => n.id === st.drag);

// ------------------------------------------------------------ strom priečinkov
function renderTree() {
  const box = $('#tree');
  box.innerHTML = '';
  const rec = (n, depth) => {
    for (const c of n.children || []) {
      if (c.type !== 'folder') continue;
      const hasSub = (c.children || []).some((x) => x.type === 'folder');
      const el = document.createElement('div');
      el.className = 'tnode' + (c.id === st.sel && !st.q ? ' sel' : '') + (st.expanded.has(c.id) ? ' expanded' : '');
      el.style.paddingLeft = 4 + depth * 16 + 'px';
      el.innerHTML = `<span class="tw">${hasSub ? SVG.arrow : ''}</span>${SVG.folder}<span class="t">${esc(c.title)}</span>`;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.tw') && hasSub) {
          st.expanded.has(c.id) ? st.expanded.delete(c.id) : st.expanded.add(c.id);
          renderTree();
          return;
        }
        st.sel = c.id; st.q = ''; $('#search').value = '';
        st.expanded.add(c.id);
        render();
      });
      dropTarget(el, () => (canDropInto(c.id) ? 'into' : null), async (_m, id) => { await api.invoke('bookmarks:move', id, c.id, -1); });
      box.appendChild(el);
      if (st.expanded.has(c.id)) rec(c, depth + 1);
    }
  };
  rec(st.tree, 0);
}

// ------------------------------------------------------------ zoznam
function row(n, index, parentId) {
  const el = document.createElement('div');
  el.className = 'brow';
  el.draggable = !st.q;
  const icon = n.type === 'folder' ? SVG.folder : n.favicon ? `<img src="${esc(n.favicon)}">` : SVG.globe;
  const count = n.type === 'folder' ? (n.children || []).length : 0;
  el.innerHTML = `<span class="ic">${icon}</span><span class="t">${esc(n.title || n.url)}</span>
    <span class="u">${n.type === 'folder' ? `${count} ${count === 1 ? 'položka' : count >= 2 && count <= 4 ? 'položky' : 'položiek'}` : esc(host(n.url))}</span>
    <span class="acts">
      ${n.type === 'folder' ? `<button class="icon" data-a="openall" title="Otvoriť všetky v nových kartách">${SVG.open}</button>` : ''}
      <button class="icon" data-a="edit" title="Upraviť">${SVG.edit}</button>
      <button class="icon" data-a="del" title="Odstrániť">${SVG.del}</button>
    </span>`;
  el.title = n.type === 'url' ? n.url : '';
  const img = el.querySelector('img');
  if (img) img.onerror = () => { el.querySelector('.ic').innerHTML = SVG.globe; };
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'edit') return openEdit(n);
    if (a === 'del') return del(n);
    if (a === 'openall') return api.invoke('bookmarks:open', n.id);
    if (n.type === 'folder') { st.sel = n.id; st.expanded.add(parentId); render(); return; }
    api.invoke('bookmarks:open', n.id, e.ctrlKey ? 'background' : 'new');
  });
  el.addEventListener('auxclick', (e) => { if (e.button === 1 && n.type === 'url') api.invoke('bookmarks:open', n.id, 'background'); });
  el.addEventListener('dragstart', (e) => { st.drag = n.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', n.url || n.title); });
  el.addEventListener('dragend', () => { st.drag = null; clearDrop(); });
  dropTarget(el, (e) => {
    if (st.q || st.drag === n.id) return null;
    const r = el.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (n.type === 'folder' && y > 0.25 && y < 0.75) return canDropInto(n.id) ? 'into' : null;
    return y < 0.5 ? 'before' : 'after';
  }, async (mode, id) => {
    if (mode === 'into') await api.invoke('bookmarks:move', id, n.id, -1);
    else await api.invoke('bookmarks:move', id, parentId, index + (mode === 'after' ? 1 : 0));
  });
  return el;
}

async function render() {
  const list = $('#list');
  list.innerHTML = '';
  if (st.q) {
    const res = await api.invoke('bookmarks:search', st.q);
    $('#crumbs').innerHTML = `Výsledky hľadania: <b>${res.length}</b>`;
    res.forEach((n, i) => list.appendChild(row(n, i, null)));
    if (!res.length) list.innerHTML = '<div class="empty">Nič sa nenašlo.</div>';
  } else {
    if (!find(st.sel)) st.sel = 'bar';
    const f = find(st.sel).node;
    $('#crumbs').innerHTML = pathTo(st.sel).map((n, i, a) => (i === a.length - 1 ? `<b>${esc(n.title)}</b>` : esc(n.title))).join(' › ');
    (f.children || []).forEach((n, i) => list.appendChild(row(n, i, f.id)));
    if (!(f.children || []).length) list.innerHTML = '<div class="empty">Priečinok je prázdny. Záložky sem môžeš presunúť myšou.</div>';
  }
  renderTree();
}

async function reload() {
  st.tree = await api.invoke('bookmarks:tree');
  render();
}

// ------------------------------------------------------------ úpravy
let editing = null;
function openEdit(n, isNew) {
  editing = { n, isNew };
  $('#edithead').textContent = isNew ? (n.type === 'folder' ? 'Nový priečinok' : 'Nová záložka') : n.type === 'folder' ? 'Premenovať priečinok' : 'Upraviť záložku';
  $('#etitle').value = n.title || '';
  $('#eurl').value = n.url || '';
  $('#eurlrow').hidden = n.type === 'folder';
  $('#edit').showModal();
  (n.type === 'url' && isNew ? $('#eurl') : $('#etitle')).focus();
}
$('#ecancel').addEventListener('click', () => $('#edit').close());
async function saveEdit() {
  const { n, isNew } = editing;
  const title = $('#etitle').value.trim();
  let url = $('#eurl').value.trim();
  if (n.type === 'url') {
    if (!url) { $('#eurl').focus(); return; }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  }
  if (isNew) await api.invoke('bookmarks:add', { parentId: st.sel, type: n.type, title, url });
  else await api.invoke('bookmarks:update', n.id, { title: title || (n.type === 'folder' ? 'Priečinok' : ''), url: n.type === 'url' ? url : undefined });
  $('#edit').close();
}
$('#esave').addEventListener('click', saveEdit);
$('#edit').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveEdit(); } });

async function del(n) {
  const info = await api.invoke('bookmarks:remove', n.id);
  if (!info) return;
  toast(n.type === 'folder' ? `Priečinok „${n.title}“ odstránený` : 'Záložka odstránená', () => api.invoke('bookmarks:restore', info));
}

$('#addurl').addEventListener('click', () => { if (st.q) { st.q = ''; $('#search').value = ''; } openEdit({ type: 'url' }, true); });
$('#addfolder').addEventListener('click', () => { if (st.q) { st.q = ''; $('#search').value = ''; } openEdit({ type: 'folder', title: 'Nový priečinok' }, true); });

// ------------------------------------------------------------ import / export
async function openImport() {
  const box = $('#sources');
  box.innerHTML = '<p class="hint">Hľadám prehliadače…</p>';
  $('#imp').showModal();
  const srcs = await api.invoke('bookmarks:sources');
  box.innerHTML = srcs.length ? '' : '<p class="hint">Na tomto PC som nenašiel Chrome, Brave, Edge ani iný podporovaný prehliadač so záložkami.</p>';
  for (const s of srcs) {
    const el = document.createElement('div');
    el.className = 'src';
    el.innerHTML = `<span><b>${esc(s.browser)}</b>${s.profile ? `<small>Profil: ${esc(s.profile)}</small>` : ''}</span><button class="btn primary">Importovať</button>`;
    el.querySelector('button').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const n = await api.invoke('bookmarks:import', s.id);
        b.textContent = `Hotovo (${n})`;
        toast(`Importované záložky z ${s.browser}: ${n}`);
      } catch (err) {
        b.disabled = false;
        toast('Import zlyhal: ' + (err.message || err));
      }
    });
    box.appendChild(el);
  }
}
$('#import').addEventListener('click', openImport);
$('#impclose').addEventListener('click', () => $('#imp').close());
$('#imphtml').addEventListener('click', async () => {
  try {
    const n = await api.invoke('bookmarks:import-html');
    if (n !== null) toast(`Importované záložky zo súboru: ${n}`);
  } catch (err) { toast('Súbor sa nepodarilo načítať: ' + (err.message || err)); }
});
$('#export').addEventListener('click', async () => {
  const f = await api.invoke('bookmarks:export-html');
  if (f) toast('Záložky exportované');
});

// ------------------------------------------------------------ hľadanie, udalosti
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { st.q = e.target.value.trim(); render(); }, 120);
});
api.on('bookmarks:changed', reload);
const checkHash = () => { if (location.hash === '#import') { history.replaceState(null, '', location.pathname); openImport(); } };
addEventListener('hashchange', checkHash);
reload().then(checkHash);
