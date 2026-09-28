// Rozhranie prehliadača: karty, adresný riadok s návrhmi, hľadanie na stránke.
const $ = (s) => document.querySelector(s);
const api = window.sova;
let state = { tabs: [], activeId: null };
const tabEls = new Map();

const ICONS = {
  frozen: '<svg viewBox="0 0 16 16"><path d="M8 1.5v13M2.4 4.75l11.2 6.5M2.4 11.25l11.2-6.5M6 2.8 8 4.3l2-1.5M6 13.2l2-1.5 2 1.5"/></svg>',
  sleep: '<svg viewBox="0 0 16 16"><path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  audio: '<svg viewBox="0 0 16 16"><path d="M2.5 6v4h2.5l3.5 3V3L5 6zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6.3 6.3 0 0 1 0 9"/></svg>',
  muted: '<svg viewBox="0 0 16 16"><path d="M2.5 6v4h2.5l3.5 3V3L5 6zM11 6l3.5 4M14.5 6 11 10"/></svg>',
};
const STATE_TEXT = {
  active: 'Aktívna', hidden: 'Na pozadí (o chvíľu sa zmrazí)',
  frozen: 'Zmrazená – CPU ≈ 0 %, ostáva v RAM', sleeping: 'Uspaná – nezaberá RAM ani CPU',
  blank: 'Nová karta – nezaberá RAM ani CPU',
};

// -------------------------------------------------------------------- karty
function makeTab(t) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  el.innerHTML = `<span class="fav"></span><span class="title"></span>
    <span class="state s-frozen">${ICONS.frozen}</span><span class="state s-sleep">${ICONS.sleep}</span>
    <button class="icon audio" title="Stlmiť / zapnúť zvuk"></button>
    <button class="icon close" title="Zavrieť (Ctrl+W)">${ICONS.close}</button>`;
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('button')) api.send('tab:activate', t.id);
    if (e.button === 1) { e.preventDefault(); api.send('tab:close', t.id); }
  });
  el.addEventListener('pointerdown', (e) => { if (e.button === 0 && !e.target.closest('button')) dragStart(e, t.id, el); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); api.send('tab:menu', t.id); });
  el.querySelector('.close').addEventListener('click', () => api.send('tab:close', t.id));
  el.querySelector('.audio').addEventListener('click', () => api.send('tab:mute', t.id));
  el._fav = '';
  return el;
}

// ---------------------------------------------------------- presúvanie kariet ťahaním
// Karta ide za myšou, ostatné sa odsúvajú (ako v Chrome). Pripnuté sa presúvajú len medzi pripnutými.
let drag = null;
function dragStart(e, id, el) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  const group = state.tabs.filter((x) => !!x.pinned === !!t.pinned).map((x) => tabEls.get(x.id)).filter(Boolean);
  drag = { id, el, pinned: !!t.pinned, x0: e.clientX, y0: e.clientY, active: false, group,
    rects: group.map((g) => g.getBoundingClientRect()), from: group.indexOf(el), to: group.indexOf(el), pointer: e.pointerId };
}
function dragMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  if (!drag.active) {
    if (Math.abs(dx) < 5 && Math.abs(e.clientY - drag.y0) < 5) return;
    if (drag.group.length < 2) { drag = null; return; }
    drag.active = true;
    try { drag.el.setPointerCapture(drag.pointer); } catch {}
    drag.el.classList.add('drag');
    $('#tabs').classList.add('dragging');
  }
  const r = drag.rects, from = drag.from;
  // karta sa nedá vytiahnuť mimo svojej skupiny
  const min = r[0].left - r[from].left, max = r[r.length - 1].right - r[from].right;
  const d = Math.max(min, Math.min(max, dx));
  drag.el.style.transform = `translateX(${d}px)`;
  // karta si vymení miesto so susedom, keď jej okraj prejde cez jeho stred
  let to = from;
  r.forEach((q, i) => {
    const mid = q.left + q.width / 2;
    if (i > from && r[from].right + d > mid) to++;
    if (i < from && r[from].left + d < mid) to--;
  });
  drag.to = to;
  const shift = r[from].width + 1;
  drag.group.forEach((g, i) => {
    if (i === from) return;
    const off = from < to && i > from && i <= to ? -shift : from > to && i >= to && i < from ? shift : 0;
    g.style.transform = off ? `translateX(${off}px)` : '';
  });
}
function dragEnd(cancel) {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.active) return;
  for (const g of d.group) g.style.transform = '';
  d.el.classList.remove('drag');
  $('#tabs').classList.remove('dragging');
  if (cancel !== true && d.to !== d.from) {
    const pinned = state.tabs.filter((x) => x.pinned).length;
    const index = d.pinned ? d.to : pinned + d.to;
    // poradie zmeníme hneď (bez preblikutia), hlavný proces ho potvrdí
    const i = state.tabs.findIndex((x) => x.id === d.id);
    if (i >= 0) { const [t] = state.tabs.splice(i, 1); state.tabs.splice(index, 0, t); renderTabs(); }
    api.send('tab:move', d.id, index);
  }
}
document.addEventListener('pointermove', dragMove);
document.addEventListener('pointerup', dragEnd);
document.addEventListener('pointercancel', () => dragEnd(true));

function renderTabs() {
  const box = $('#tabs');
  const seen = new Set();
  // šírka, ktorú majú karty k dispozícii (celý riadok bez tlačidiel okna a „+“)
  const strip = $('#tabstrip'), cs = getComputedStyle(strip);
  const PIN_W = 40;                                         // pripnutá karta = len ikona
  const pinned = state.tabs.filter((t) => t.pinned).length;
  const normal = state.tabs.length - pinned;
  const avail = strip.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 36 - pinned * (PIN_W + 1) - (pinned ? 6 : 0);
  const tabW = normal ? Math.min(220, avail / normal) : 220;
  const narrow = tabW < 64, compact = !narrow && tabW < 120;
  state.tabs.forEach((t, i) => {
    seen.add(t.id);
    let el = tabEls.get(t.id);
    if (!el) { el = makeTab(t); tabEls.set(t.id, el); }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    el.className = ['tab', t.state, t.id === state.activeId && 'active', t.loading && 'loading',
      t.audible && 'audible', t.muted && 'muted', t.pinned && 'pinned',
      !t.pinned && narrow && 'narrow', !t.pinned && compact && 'compact',
      t.pinned && !state.tabs[i + 1]?.pinned && 'last-pinned', drag?.active && drag.id === t.id && 'drag'].filter(Boolean).join(' ');
    el.querySelector('.title').textContent = t.title || 'Nová karta';
    const fav = t.favicon || '';
    if (el._fav !== fav) {
      el._fav = fav;
      const f = el.querySelector('.fav');
      f.innerHTML = '';
      if (fav) {
        const img = new Image(); img.src = fav; img.onerror = () => { f.innerHTML = '<span class="dot"></span>'; };
        f.appendChild(img);
      } else f.innerHTML = '<span class="dot"></span>';
    }
    el.querySelector('.audio').innerHTML = t.muted ? ICONS.muted : ICONS.audio;
    const lines = [t.title, t.url, `Stav: ${STATE_TEXT[t.state] || t.state}`];
    if (t.memMB) lines.push(`Pamäť procesu: ${t.memMB} MB`);
    if (t.blocked) lines.push(`Zablokované: ${t.blocked}`);
    if (t.pinned) lines.push('Pripnutá karta (pravé tlačidlo → Odopnúť)');
    if (t.neverSleep) lines.push('Táto stránka sa nikdy neuspáva');
    if (t.crashed) lines.push('Stránka spadla – klikni pre obnovenie');
    el.title = lines.filter(Boolean).join('\n');
  });
  for (const [id, el] of tabEls) if (!seen.has(id)) { el.remove(); tabEls.delete(id); }
  if (drag && drag.group.some((g) => !g.isConnected)) dragEnd(true);   // počas ťahania sa zavrela karta
  // šírku kariet počítame sami (Chrome štýl); pri extrémnom počte sa lišta dá posúvať kolieskom
  const w = Math.max(28, Math.floor(tabW));
  state.tabs.forEach((t) => { const el = tabEls.get(t.id); if (el) el.style.width = (t.pinned ? PIN_W : w) + 'px'; });
  const act = tabEls.get(state.activeId);
  if (act && state.activeId !== renderTabs.lastActive) { act.scrollIntoView({ block: 'nearest', inline: 'nearest' }); renderTabs.lastActive = state.activeId; }
}

// ------------------------------------------------------------------- lišta
const address = $('#address');
function renderToolbar() {
  const a = state.tabs.find((t) => t.id === state.activeId);
  $('#back').disabled = !state.canGoBack;
  $('#forward').disabled = !state.canGoForward;
  $('#reload').classList.toggle('loading', !!a?.loading);
  $('#reload').title = a?.loading ? 'Zastaviť' : 'Obnoviť (F5)';
  if (document.activeElement !== address) address.value = a?.url || '';
  const sh = $('#shield');
  const off = !state.adblock || state.siteAllowlisted;
  sh.classList.toggle('off', off);
  $('#blocked').textContent = off ? 'vyp.' : String(a?.blocked || 0);
  sh.title = !state.adblock ? 'Blokovanie reklám je vypnuté (Nastavenia)'
    : state.siteAllowlisted ? `Blokovanie na ${state.siteHost} je vypnuté – klikni pre zapnutie`
    : `Zablokované na tejto stránke: ${a?.blocked || 0} (celkovo ${state.adblockTotal || 0})\nKlikni pre vypnutie na ${state.siteHost || 'tejto stránke'}`;
  renderStats();
  renderSiteInfo();
  document.title = a?.title ? `${a.title} – Sova` : 'Sova';
}

api.on('state', (s) => {
  state = s; applyLayout(s.tabsPosition || 'top');
  renderTabs(); renderToolbar(); renderBookmarks(); renderDownloads(); renderNtp(); renderCert();
});

// ------------------------------------------------------------ neplatný certifikát
const CERT_REASON = {
  'net::ERR_CERT_AUTHORITY_INVALID': 'Certifikát nevydala dôveryhodná certifikačná autorita – napríklad je vlastnoručne podpísaný.',
  'net::ERR_CERT_DATE_INVALID': 'Platnosť certifikátu vypršala alebo ešte nezačala. Skontroluj aj dátum a čas v počítači.',
  'net::ERR_CERT_COMMON_NAME_INVALID': 'Certifikát patrí inej adrese, než ktorú otváraš.',
  'net::ERR_CERT_REVOKED': 'Vydavateľ tento certifikát zrušil.',
  'net::ERR_CERT_WEAK_SIGNATURE_ALGORITHM': 'Certifikát používa zastaraný a slabý podpis.',
  'net::ERR_CERT_WEAK_KEY': 'Certifikát používa príliš slabý kľúč.',
  'net::ERR_CERT_INVALID': 'Certifikát je poškodený alebo neplatný.',
};
let certShown = '';
function renderCert() {
  const c = state.certError;
  const el = $('#certerr');
  const key = c ? `${state.activeId}|${c.host}|${c.error}` : '';
  if (key === certShown) return;
  certShown = key;
  el.hidden = !c;
  if (!c) return;
  $('#cehost').textContent = $('#cehost2').textContent = $('#cehost3').textContent = c.host;
  $('#cereason').textContent = CERT_REASON[c.error] || 'Certifikát servera nie je platný.';
  $('#cecode').textContent = c.error;
  $('#cedetail').hidden = true;
  $('#ceadv').textContent = 'Rozšírené';
  el.scrollTop = 0;
}
$('#ceadv').addEventListener('click', () => {
  const d = $('#cedetail');
  d.hidden = !d.hidden;
  $('#ceadv').textContent = d.hidden ? 'Rozšírené' : 'Skryť podrobnosti';
  if (!d.hidden) d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
$('#ceback').addEventListener('click', () => api.send('cert:back'));
$('#ceproceed').addEventListener('click', (e) => { e.preventDefault(); api.send('cert:proceed'); });

// ------------------------------------------------------------ prázdna nová karta
let ntpTimer = null;
function ntpClock() {
  $('#ntpclock').textContent = new Date().toLocaleString('sk-SK', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}
function renderNtp() {
  const show = !!state.activeBlank;
  const el = $('#ntp');
  if (el.hidden !== !show) {
    el.hidden = !show;
    clearInterval(ntpTimer);
    if (show) { ntpClock(); ntpTimer = setInterval(ntpClock, 30000); $('#ntpq').value = ''; }
  }
}
$('#ntpform').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#ntpq').value.trim();
  if (q) api.send('nav:go', q);
});
api.on('focus-address', () => { address.focus(); address.select(); });

$('#newtab').addEventListener('click', () => api.send('tab:new'));
$('#tabs').addEventListener('wheel', (e) => { $('#tabs').scrollLeft += e.deltaY || e.deltaX; }, { passive: true });
$('#tabstrip').addEventListener('dblclick', (e) => { if (e.target.id === 'tabs' || e.target.id === 'tabstrip') api.send('tab:new'); });
$('#back').addEventListener('click', () => api.send('nav:back'));
$('#forward').addEventListener('click', () => api.send('nav:forward'));
$('#reload').addEventListener('click', (e) => api.send(e.currentTarget.classList.contains('loading') ? 'nav:stop' : 'nav:reload'));
$('#sleepall').addEventListener('click', () => api.send('sleep-others'));
$('#shield').addEventListener('click', () => {
  if (state.adblock && state.siteHost) api.send('adblock:toggle-site'); else api.send('open-internal', 'settings');
});
$('#addrform').addEventListener('submit', (e) => e.preventDefault());
address.addEventListener('focus', () => setTimeout(() => address.select(), 0));

// ---- návrhy domén (youtube.com po napísaní „you“)
const sugg = { typed: '', items: [], sel: -1, deleting: false };
function hideSuggest() {
  if (sugg.items.length) api.send('suggest:hide');
  sugg.items = []; sugg.sel = -1;
}
function querySuggest() {
  sugg.typed = address.value;
  if (!sugg.typed.trim()) { hideSuggest(); return; }
  const r = $('#addrform').getBoundingClientRect();
  api.send('suggest:query', sugg.typed, { x: r.left, y: r.bottom + 2, width: r.width });
}
function selectSuggest(i) {
  sugg.sel = i;
  const it = sugg.items[i];
  address.value = !it ? sugg.typed : it.type === 'domain' ? it.key : it.text;
  address.setSelectionRange(address.value.length, address.value.length);
  api.send('suggest:select', i);
}
api.on('suggest:result', (text, items) => {
  if (document.activeElement !== address || text !== sugg.typed || address.value !== text) return;
  sugg.items = items; sugg.sel = -1;
  // doplnenie priamo v riadku: „you“ → „you|tube.com“ (doplnená časť je označená, písaním sa prepíše)
  const top = items[0];
  if (!sugg.deleting && top && top.type === 'domain' && address.selectionStart === text.length) {
    const lt = text.toLowerCase();
    const full = top.host.toLowerCase().startsWith(lt) ? top.host : null;
    if (full && full.length > text.length) {
      address.value = text + full.slice(text.length);
      address.setSelectionRange(text.length, address.value.length);
      sugg.sel = 0;
      api.send('suggest:select', 0);
    }
  }
});
function go() {
  const it = sugg.items[sugg.sel];
  const target = !it ? address.value : it.type === 'domain' ? it.url : it.text;
  hideSuggest();
  api.send('nav:go', target);
  address.blur();
}
address.addEventListener('input', (e) => {
  sugg.deleting = !!(e.inputType && e.inputType.startsWith('delete'));
  querySuggest();
});
address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); go(); return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sugg.items.length) {
    e.preventDefault();
    const n = sugg.items.length;
    let i = sugg.sel + (e.key === 'ArrowDown' ? 1 : -1);
    if (i >= n) i = -1; else if (i < -1) i = n - 1;
    selectSuggest(i);
    return;
  }
  if (e.key === 'Escape') {
    if (sugg.items.length) { address.value = sugg.typed; hideSuggest(); return; }
    renderToolbar(); address.blur();
  }
});
address.addEventListener('blur', () => { setTimeout(hideSuggest, 150); renderToolbar(); });

// ------------------------------------------------------------------ hľadanie
const findbar = $('#findbar'), findtext = $('#findtext');
function openFind() { findbar.hidden = false; reportHeight(); findtext.focus(); findtext.select(); if (findtext.value) doFind(true); }
function closeFind() { findbar.hidden = true; $('#findcount').textContent = ''; api.send('find', ''); reportHeight(); }
function doFind(forward, findNext = false) { api.send('find', findtext.value, { forward, findNext }); if (!findtext.value) $('#findcount').textContent = ''; }
api.on('open-find', openFind);
api.on('find-result', (r) => { if (r.finalUpdate) $('#findcount').textContent = r.matches ? `${r.activeMatchOrdinal} z ${r.matches}` : 'Nenájdené'; });
findtext.addEventListener('input', () => doFind(true));
findtext.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doFind(!e.shiftKey, true);
  if (e.key === 'Escape') closeFind();
});
$('#findnext').addEventListener('click', () => doFind(true, true));
$('#findprev').addEventListener('click', () => doFind(false, true));
$('#findclose').addEventListener('click', closeFind);

// ------------------------------------------------------------------ záložky
const FOLDER_SVG = '<svg viewBox="0 0 16 16"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6h5.5c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/></svg>';
const GLOBE_SVG = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>';
const escH = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
let bmKey = '', dragId = null, bmHidden = [];
// ťahá sa záložka z lišty alebo z menu priečinka?
const isBmDrag = (e) => !!dragId || e.dataTransfer.types.includes('application/x-sova-bm')
  || e.dataTransfer.types.includes('application/x-sova-newbm')      // zámok z adresného riadku
  || e.dataTransfer.types.includes('text/uri-list');                // odkaz zo stránky

// Čo sa pustilo na lištu: existujúca záložka (presun), aktuálna stránka (zámok) alebo odkaz
function dropPayload(e) {
  const dt = e.dataTransfer;
  const id = dragId || dt.getData('application/x-sova-bm');
  if (id) return { move: id };
  if (dt.types.includes('application/x-sova-newbm')) return { current: true };
  const url = (dt.getData('text/uri-list') || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!url) return null;
  let title = '';
  const html = dt.getData('text/html');
  if (html) title = new DOMParser().parseFromString(html, 'text/html').body.textContent.trim().slice(0, 200);
  return { url, title };
}
function applyDrop(p, parentId, index) {
  if (!p) return;
  if (p.move) api.send('bm:move', p.move, parentId, index);
  else api.send('bm:add-drop', p.current ? null : p.url, p.title || '', parentId, index);
}

function renderBookmarks() {
  const star = $('#star');
  star.hidden = !state.canBookmark;
  star.classList.toggle('on', !!state.bookmarked);
  star.title = state.bookmarked ? 'Upraviť záložku (Ctrl+D)' : 'Pridať záložku (Ctrl+D)';
  const bar = $('#bmbar');
  const show = !!state.showBar;
  if (bar.hidden === show) { bar.hidden = !show; reportHeight(); }
  if (!show) return;
  const key = JSON.stringify([state.bmBar, state.bmOther]);
  if (key !== bmKey) { bmKey = key; buildBar(); }
  layoutBar();
}

function clearDrop() {
  for (const x of document.querySelectorAll('.drop-before, .drop-after, .drop-into')) x.classList.remove('drop-before', 'drop-after', 'drop-into');
}

function buildBar() {
  const box = $('#bmitems');
  box.innerHTML = '';
  const items = state.bmBar || [];
  if (!items.length) {
    box.innerHTML = '<span class="bmempty">Záložky pridáš hviezdičkou v adresnom riadku alebo ich <a id="bmimport">importuj z iného prehliadača</a>.</span>';
    $('#bmimport').addEventListener('click', () => api.send('open-internal', 'bookmarks', 'import'));
  }
  items.forEach((b, i) => {
    const el = document.createElement('button');
    el.className = 'bm' + (b.type === 'folder' ? ' folder' : '');
    el.draggable = true;
    el.title = b.type === 'url' ? `${b.title}\n${b.url}` : b.title;
    el.innerHTML = (b.type === 'folder' ? FOLDER_SVG : b.favicon ? `<img src="${escH(b.favicon)}">` : GLOBE_SVG)
      + (b.title ? `<span>${escH(b.title)}</span>` : '');
    const img = el.querySelector('img');
    if (img) img.onerror = () => { img.outerHTML = GLOBE_SVG; };
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        if (b.type === 'folder') api.send('bm:folder-menu', b.id, rectOf(el));
        else api.send('bm:open', b.id, e.ctrlKey ? 'background' : e.shiftKey ? 'new' : 'current');
      }
      if (e.button === 1 && b.type === 'url') api.send('bm:open', b.id, 'background');
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); api.send('bm:context', b.id, rectOf(el)); });
    // presúvanie myšou: pred/za položku, alebo do priečinka (stred priečinka)
    el.addEventListener('dragstart', (e) => {
      dragId = b.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-sova-bm', b.id);
      e.dataTransfer.setData('text/plain', b.url || b.title);
    });
    el.addEventListener('dragend', () => { dragId = null; clearDrop(); });
    el.addEventListener('dragover', (e) => {
      if (!isBmDrag(e) || dragId === b.id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const mode = b.type === 'folder' && x > 0.25 && x < 0.75 ? 'into' : x < 0.5 ? 'before' : 'after';
      if (el.dataset.drop !== mode || !el.classList.contains('drop-' + mode)) { clearDrop(); el.classList.add('drop-' + mode); el.dataset.drop = mode; }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const mode = el.dataset.drop;
      clearDrop();
      const p = dropPayload(e);
      dragId = null;
      if (!p || p.move === b.id) return;
      if (mode === 'into') applyDrop(p, b.id, -1);
      else applyDrop(p, 'bar', i + (mode === 'after' ? 1 : 0));
    });
    box.appendChild(el);
  });
  $('#bmother').hidden = !state.bmOther;
}

// položky, ktoré sa nezmestia, idú do menu »
function layoutBar() {
  const box = $('#bmitems');
  const els = [...box.querySelectorAll('.bm')];
  const ov = $('#bmoverflow');
  const fit = () => {
    bmHidden = [];
    let over = false;
    els.forEach((el, i) => {
      el.classList.remove('hide');
      if (!over && el.offsetLeft + el.offsetWidth > box.clientWidth) over = true;
      if (over) { el.classList.add('hide'); bmHidden.push(state.bmBar[i].id); }
    });
  };
  ov.hidden = true;
  fit();
  if (bmHidden.length) { ov.hidden = false; fit(); }
}

$('#star').addEventListener('click', () => api.send('bm:star', rectOf($('#star'))));
api.on('bm:star-request', () => { if (state.canBookmark) api.send('bm:star', rectOf($('#star'))); });
$('#bmoverflow').addEventListener('click', (e) => api.send('bm:overflow-menu', bmHidden, rectOf(e.currentTarget)));
$('#bmother').addEventListener('click', (e) => api.send('bm:other-menu', rectOf(e.currentTarget)));
$('#bmbar').addEventListener('contextmenu', (e) => { e.preventDefault(); api.send('bm:context', null, null); });
// pustenie na prázdne miesto lišty (aj na text prázdnej lišty) = na koniec
const onEmptyBar = (e) => !e.target.closest('.bm') && !!e.target.closest('#bmitems');
$('#bmitems').addEventListener('dragover', (e) => { if (isBmDrag(e) && onEmptyBar(e)) { e.preventDefault(); e.dataTransfer.dropEffect = dragId ? 'move' : 'copy'; } });
$('#bmitems').addEventListener('drop', (e) => {
  if (!onEmptyBar(e)) return;
  const p = dropPayload(e);
  if (!p) return;
  e.preventDefault(); clearDrop();
  applyDrop(p, 'bar', -1);
  dragId = null;
});

// ------------------------------------------------------ informácie o stránke (zámok)
const SI = {
  secure: ['', '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7"/></svg>', '', 'Pripojenie je zabezpečené'],
  'cert-error': ['bad', '<svg viewBox="0 0 16 16"><path d="M8 2.5 1.8 13.5h12.4z"/><path d="M8 6.8v3M8 11.8v.1"/></svg>', 'Neplatný certifikát', 'Certifikát stránky nie je dôveryhodný'],
  insecure: ['bad', '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.7M8 5.2v.1"/></svg>', 'Nezabezpečené', 'Pripojenie nie je šifrované (HTTP)'],
  internal: ['', '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.7M8 5.2v.1"/></svg>', 'Sova', 'Stránka prehliadača Sova'],
  file: ['', '<svg viewBox="0 0 16 16"><path d="M9.5 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z"/><path d="M9.5 2v3h3"/></svg>', '', 'Súbor v tomto počítači'],
};
let siKey = '';
function renderSiteInfo() {
  const b = $('#siteinfo');
  const sec = state.security || 'none';
  if (sec === siKey) return;
  siKey = sec;
  const s = SI[sec];
  b.className = s ? s[0] : 'none';
  b.draggable = sec === 'secure' || sec === 'insecure' || sec === 'cert-error' || sec === 'file';
  b.querySelector('.si-ic').innerHTML = s ? s[1] : '';
  b.querySelector('.si-label').textContent = s ? s[2] : '';
  b.title = s ? `${s[3]} – klikni pre podrobnosti` : '';
}
$('#siteinfo').addEventListener('click', (e) => api.send('site:info', rectOf(e.currentTarget)));
// Zámok sa dá potiahnuť na lištu záložiek (ako v Chrome) – vznikne záložka aktuálnej stránky
$('#siteinfo').addEventListener('dragstart', (e) => {
  const a = state.tabs.find((t) => t.id === state.activeId);
  if (!state.canBookmark || !a?.url) { e.preventDefault(); return; }
  e.dataTransfer.effectAllowed = 'copyLink';
  e.dataTransfer.setData('application/x-sova-newbm', '1');
  e.dataTransfer.setData('text/uri-list', a.url);
  e.dataTransfer.setData('text/plain', a.url);
  // náhľad pri ťahaní: ikona + názov stránky
  const g = document.createElement('div');
  g.className = 'dragghost';
  g.textContent = a.title || a.url;
  document.body.appendChild(g);
  e.dataTransfer.setDragImage(g, 10, 12);
  setTimeout(() => g.remove(), 0);
});

// ------------------------------------------------------ vyťaženie a sťahovanie
const fmtBits = (bps) => {
  if (bps == null) return '–';
  const m = bps / 1e6;
  if (m < 0.1) return `${Math.round(bps / 1e3)} kb/s`;
  return `${(m < 10 ? m.toFixed(1) : Math.round(m)).toString().replace('.', ',')} Mb/s`;
};
function renderStats() {
  const s = state.stats || {};
  const mb = s.mem ?? state.totalMemMB ?? 0;
  $('#cpu').textContent = `CPU ${Math.round(s.cpu || 0)} %`;
  $('#mem').textContent = mb >= 1024 ? `${(mb / 1024).toFixed(1).replace('.', ',')} GB` : `${mb} MB`;
  $('#netdown').textContent = fmtBits(s.down);
  $('#netup').textContent = fmtBits(s.up);
  const sleeping = state.tabs.filter((t) => t.state === 'sleeping').length;
  const frozen = state.tabs.filter((t) => t.state === 'frozen').length;
  $('#stats').title = `Procesor (Sova): ${Math.round(s.cpu || 0)} %\nPamäť (Sova): ${mb} MB\n`
    + `Sieť celého PC: ↓ ${fmtBits(s.down)}  ↑ ${fmtBits(s.up)}\n`
    + `Karty: ${state.tabs.length} · zmrazené: ${frozen} · uspané: ${sleeping}\n\nKlikni pre test rýchlosti internetu`;
}
let dlActiveBefore = 0;
function renderDownloads() {
  const d = state.dl || {};
  const b = $('#downloads');
  b.classList.toggle('active', d.active > 0);
  b.classList.toggle('unknown', d.active > 0 && d.progress < 0);
  b.classList.toggle('unseen', d.unseen > 0 && !d.active);
  b.querySelector('.ring').style.strokeDasharray = d.progress > 0 ? `${Math.round(d.progress * 100)} 100` : '';
  if (d.active > dlActiveBefore) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  dlActiveBefore = d.active || 0;
  b.title = d.active ? `Sťahuje sa: ${d.active}${d.progress > 0 ? ` (${Math.round(d.progress * 100)} %)` : ''} – Ctrl+J`
    : d.unseen ? `Stiahnuté: ${d.unseen} nové – Ctrl+J` : 'Stiahnuté súbory (Ctrl+J)';
}
$('#stats').addEventListener('click', (e) => api.send('tools:stats', rectOf(e.currentTarget)));
$('#downloads').addEventListener('click', (e) => api.send('tools:downloads', rectOf(e.currentTarget)));
// poloha tlačidla, aby sa bublina vedela ukázať sama pri začatí sťahovania
const sendDlRect = () => api.send('tools:downloads-rect', rectOf($('#downloads')));
new ResizeObserver(sendDlRect).observe($('#toolbar'));
sendDlRect();

// ------------------------------------------- nastavenia a história (samostatné karty)
api.on('activated', (url) => {
  hideSuggest();
  address.blur();
  address.value = url || '';
});
$('#settings').addEventListener('click', () => api.send('open-internal', 'settings'));
$('#history').addEventListener('click', () => api.send('open-internal', 'history'));

// ------------------------------------------------ výška lišty → pozícia stránky
function reportHeight() {
  const h = $('#chrome').getBoundingClientRect().height;
  const bottom = $('#bottombar').getBoundingClientRect().height;
  document.documentElement.style.setProperty('--top', `${h}px`);
  document.documentElement.style.setProperty('--bottom', `${bottom}px`);
  api.send('ui-height', h, bottom);
}

// Umiestnenie kariet (Nastavenia): hore ako Chrome, alebo adresa hore a karty + záložky na spodku okna
let layoutMode = 'top';
function applyLayout(mode) {
  if (mode === layoutMode) return;
  layoutMode = mode;
  const head = $('#chrome'), foot = $('#bottombar');
  const strip = $('#tabstrip'), bar = $('#bmbar'), tb = $('#toolbar'), find = $('#findbar');
  document.body.classList.toggle('tabs-bottom', mode === 'bottom');
  if (mode === 'bottom') {
    head.append(tb, find);
    foot.append(bar, strip);          // záložky nad kartami, karty úplne na spodku okna
  } else {
    head.append(strip, tb, bar, find);
  }
  bmKey = '';                         // prekresliť lištu záložiek
  reportHeight();
  renderTabs();
  if (state.showBar) renderBookmarks();
}
const ro = new ResizeObserver(() => { reportHeight(); renderTabs(); if (state.showBar) layoutBar(); });
ro.observe(document.body);
ro.observe($('#chrome'));
ro.observe($('#bottombar'));
reportHeight();
