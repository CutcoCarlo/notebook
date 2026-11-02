/* app.js — Notebook editor: notebooks, pages, ink, shapes, text, images, links, selection, undo, storage. */
import * as R from './render.js';
import { notebookToPDF, pageToPNG, shareOrDownload } from './export.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const clone = o => JSON.parse(JSON.stringify(o, (k, v) => (k[0] === '_' ? undefined : v)));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const COLORS = ['#111827', '#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#9333ea', '#6b7280'];
const FILLS  = ['none', '#fde68a', '#bfdbfe', '#bbf7d0', '#fecaca', '#e9d5ff', '#e5e7eb'];
const COVERS = ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#9333ea', '#7c4a2d', '#0e7490'];

/* ---------------- storage ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('notebook-app', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('notebooks', { keyPath: 'id' }); d.createObjectStore('meta', { keyPath: 'id' }); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
    });
  },
  get(s, id) { return this.tx(s, 'readonly', st => st.get(id)); },
  put(s, v) { return this.tx(s, 'readwrite', st => st.put(v)); },
  del(s, id) { return this.tx(s, 'readwrite', st => st.delete(id)); },
  all(s) { return this.tx(s, 'readonly', st => st.getAll()); },
};

/* ---------------- state ---------------- */
const S = {
  metas: [], nb: null, pi: 0,
  tool: 'pen', color: COLORS[0], size: 'm',
  pencilOnly: localStorage.getItem('pencilOnly') === '1',
  view: { s: 1, x: 0, y: 0 },
  sel: [],
  editing: null, editBefore: null, editIsNew: false,
  thumb: null, thumbDirty: true,
};
const page = () => S.nb.pages[S.pi];
const newPage = template => ({ id: uid(), template, elements: [] });

/* ---------------- elements ---------------- */
const canvas = $('#canvas'), stage = $('#stage'), ta = $('#textEdit'), selBar = $('#selBar');
const ctx = canvas.getContext('2d');
let dpr = 1, W = 0, H = 0;
/* Finished ink is drawn once into this offscreen layer; each frame only repaints the live stroke
   and the selection on top of it. layerDirty forces a rebuild. */
const layer = document.createElement('canvas'), lctx = layer.getContext('2d');
let layerDirty = true, layerView = null, wheelTimer = null;
const cloneEl = el => { const c = {}; for (const k in el) if (k[0] !== '_') c[k] = el[k]; return c; };
function setSel(arr) { S.sel = arr; layerDirty = true; updateSelBar(); }

function resize() {
  const r = stage.getBoundingClientRect(); W = r.width; H = r.height; dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  layerDirty = true; requestRender();
}
new ResizeObserver(resize).observe(stage);

const stagePt = e => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
const toPage = ([sx, sy]) => [(sx - S.view.x) / S.view.s, (sy - S.view.y) / S.view.s];
const toScreen = ([px, py]) => [px * S.view.s + S.view.x, py * S.view.s + S.view.y];
const evPage = e => toPage(stagePt(e));

function fitView() {
  const s = Math.min((W - 32) / R.PAGE_W, (H - 32) / R.PAGE_H);
  S.view = { s, x: (W - R.PAGE_W * s) / 2, y: (H - R.PAGE_H * s) / 2 };
  requestRender();
}
function clampView() {
  const v = S.view, pw = R.PAGE_W * v.s, ph = R.PAGE_H * v.s, m = 80;
  v.x = clamp(v.x, m - pw, W - m); v.y = clamp(v.y, m - ph, H - m);
}
function zoomAt(k, [sx, sy]) {
  const v = S.view, ns = clamp(v.s * k, 0.25, 8), f = ns / v.s;
  v.x = sx - (sx - v.x) * f; v.y = sy - (sy - v.y) * f; v.s = ns; clampView(); requestRender();
}

/* ---------------- rendering ---------------- */
let needs = false, gesture = null, nav = null;
function requestRender() { if (!needs) { needs = true; requestAnimationFrame(render); } }
function renderLayer() {
  S._layerRenders = (S._layerRenders || 0) + 1;
  if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0); lctx.clearRect(0, 0, W, H);
  lctx.translate(S.view.x, S.view.y); lctx.scale(S.view.s, S.view.s);
  lctx.fillStyle = 'rgba(0,0,0,.16)'; lctx.fillRect(3 / S.view.s, 4 / S.view.s, R.PAGE_W, R.PAGE_H);   // cheap paper shadow
  lctx.save(); lctx.beginPath(); lctx.rect(0, 0, R.PAGE_W, R.PAGE_H); lctx.clip();
  lctx.fillStyle = '#fff'; lctx.fillRect(0, 0, R.PAGE_W, R.PAGE_H);
  R.drawMarks(lctx, R.templateMarks(page().template));
  const skip = new Set(S.sel); if (S.editing) skip.add(S.editing);
  const onImage = () => { layerDirty = true; requestRender(); };
  for (const el of page().elements) if (!skip.has(el)) R.drawElement(lctx, el, { onImage });
  lctx.restore();
  layerView = { ...S.view }; layerDirty = false;
}
function render() {
  needs = false;
  if (!S.nb) return;
  S._renders = (S._renders || 0) + 1;
  const v = S.view;
  const same = layerView && v.s === layerView.s && v.x === layerView.x && v.y === layerView.y;
  if (layerDirty || !layerView || (!same && !nav && !wheelTimer)) renderLayer();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (same || layerDirty === false && (v.s === layerView.s && v.x === layerView.x && v.y === layerView.y)) ctx.drawImage(layer, 0, 0, W, H);
  else {  // mid pan/zoom: reuse the layer, scaled; it is rebuilt sharp when the gesture ends
    const lv = layerView, k = v.s / lv.s;
    ctx.save(); ctx.translate(v.x - k * lv.x, v.y - k * lv.y); ctx.scale(k, k); ctx.drawImage(layer, 0, 0, W, H); ctx.restore();
  }
  ctx.translate(v.x, v.y); ctx.scale(v.s, v.s);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, R.PAGE_W, R.PAGE_H); ctx.clip();
  for (const el of S.sel) if (el !== S.editing) R.drawElement(ctx, el, { onImage: requestRender });
  if (gesture && gesture.kind === 'stroke') R.drawElement(ctx, gesture.el, { live: true });
  if (gesture && gesture.kind === 'shape') R.drawElement(ctx, gesture.el, {});
  ctx.restore();
  if (gesture && gesture.kind === 'lasso' && gesture.pts.length > 1) {
    ctx.save(); ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.5 / S.view.s; ctx.setLineDash([6 / S.view.s, 5 / S.view.s]);
    ctx.beginPath(); gesture.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); ctx.restore();
  }
  drawSelection();
  positionSelBar();
  if (S.editing) positionTA();
}

function selFrame() {
  if (!S.sel.length) return null;
  if (S.sel.length === 1 && S.sel[0].type !== 'stroke') { const e = S.sel[0]; return { cx: e.cx, cy: e.cy, w: e.w, h: e.h || 0, rot: e.rot || 0, single: e }; }
  const b = R.unionBox(S.sel); return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, w: b.x1 - b.x0, h: b.y1 - b.y0, rot: 0 };
}
const isLineEl = e => e && e.type === 'shape' && (e.kind === 'line' || e.kind === 'arrow');
function handles(f) {
  const hs = [];
  if (isLineEl(f.single)) {
    hs.push({ id: 'p0', p: R.fromLocal(f, [-f.w / 2, 0]) }, { id: 'p1', p: R.fromLocal(f, [f.w / 2, 0]) });
  } else {
    const hw = f.w / 2, hh = f.h / 2;
    hs.push({ id: 'nw', p: R.fromLocal(f, [-hw, -hh]) }, { id: 'ne', p: R.fromLocal(f, [hw, -hh]) },
            { id: 'se', p: R.fromLocal(f, [hw, hh]) }, { id: 'sw', p: R.fromLocal(f, [-hw, hh]) },
            { id: 'rot', p: R.fromLocal(f, [0, -hh - 34 / S.view.s]) });
  }
  return hs;
}
function drawSelection() {
  const f = selFrame(); if (!f || S.editing) return;
  const s = S.view.s;
  ctx.save();
  ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.2 / s;
  if (!isLineEl(f.single)) {
    ctx.setLineDash([5 / s, 4 / s]);
    const cs = R.corners(f); ctx.beginPath(); cs.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    const top = R.fromLocal(f, [0, -f.h / 2]), rh = R.fromLocal(f, [0, -f.h / 2 - 34 / s]);
    ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(rh[0], rh[1]); ctx.stroke();
  }
  for (const h of handles(f)) {
    ctx.beginPath(); ctx.arc(h.p[0], h.p[1], (h.id === 'rot' ? 8 : 7) / s, 0, Math.PI * 2);
    ctx.fillStyle = h.id === 'rot' ? '#2563eb' : '#fff'; ctx.fill(); ctx.lineWidth = 1.5 / s; ctx.stroke();
  }
  ctx.restore();
}

/* ---------------- history (per page, small operations) ---------------- */
const hist = pg => (pg._hist || (pg._hist = { undo: [], redo: [] }));
function commit(op) {
  const h = hist(page()); h.undo.push(op); if (h.undo.length > 500) h.undo.shift(); h.redo = [];
  if (S.pi === 0) S.thumbDirty = true;
  layerDirty = true; updateUndoButtons(); saveSoon();
}
const opAdd = els => ({ t: 'add', items: els.map(el => ({ i: page().elements.indexOf(el), el: cloneEl(el) })) });
const opRemove = items => ({ t: 'remove', items });          // items in removal order, index at time of removal
const opModify = (before, after) => ({ t: 'modify', before, after });
const opReorder = (before, after) => ({ t: 'reorder', before, after });
/* remove elements one at a time (highest index first) and record where each one was */
function removeEls(list) {
  const items = [];
  const idx = list.map(el => page().elements.indexOf(el)).filter(i => i >= 0).sort((a, b) => b - a);
  for (const i of idx) { items.push({ i, el: page().elements[i] }); page().elements.splice(i, 1); }
  return items;
}
function insertItems(items, reverse) {
  const arr = page().elements;
  const list = reverse ? items.slice().reverse() : items;
  for (const it of list) arr.splice(Math.min(it.i, arr.length), 0, cloneEl(it.el));
}
function replaceEls(clones) { const map = new Map(clones.map(c => [c.id, c])); page().elements = page().elements.map(e => map.has(e.id) ? cloneEl(map.get(e.id)) : e); }
function setOrder(ids) {
  const map = new Map(page().elements.map(e => [e.id, e]));
  const ordered = ids.map(id => map.get(id)).filter(Boolean), rest = page().elements.filter(e => !ids.includes(e.id));
  page().elements = ordered.concat(rest);
}
function applyOp(op, forward) {
  const removeByIds = items => { const ids = new Set(items.map(it => it.el.id)); page().elements = page().elements.filter(e => !ids.has(e.id)); };
  switch (op.t) {
    case 'add':     forward ? insertItems(op.items, false) : removeByIds(op.items); break;
    case 'remove':  forward ? removeByIds(op.items) : insertItems(op.items, true); break;
    case 'modify':  replaceEls(forward ? op.after : op.before); break;
    case 'reorder': setOrder(forward ? op.after : op.before); break;
  }
}
function undo() { if (S.editing) finishEdit(); const h = hist(page()); const op = h.undo.pop(); if (!op) return; applyOp(op, false); h.redo.push(op); afterHistory(); }
function redo() { if (S.editing) finishEdit(); const h = hist(page()); const op = h.redo.pop(); if (!op) return; applyOp(op, true); h.undo.push(op); afterHistory(); }
function afterHistory() { if (S.pi === 0) S.thumbDirty = true; setSel([]); layerDirty = true; updateUndoButtons(); requestRender(); saveSoon(); }
function updateUndoButtons() { const h = hist(page()); $('#btnUndo').disabled = !h.undo.length; $('#btnRedo').disabled = !h.redo.length; }

/* ---------------- save ---------------- */
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 1200); }
function snapshotNotebook() {
  const nb = S.nb;
  return { id: nb.id, name: nb.name, created: nb.created, updated: nb.updated, template: nb.template, cover: nb.cover,
    pages: nb.pages.map(p => ({ id: p.id, template: p.template, elements: p.elements.map(cloneEl) })) };
}
async function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!S.nb) return;
  S.nb.updated = Date.now();
  const nb = snapshotNotebook();
  try {
    if (S.thumbDirty || !S.thumb) { S.thumb = thumbnail(S.nb.pages[0], 160); S.thumbDirty = false; }
    await DB.put('notebooks', nb);
    await DB.put('meta', { id: nb.id, name: nb.name, updated: nb.updated, created: nb.created, pages: nb.pages.length, template: nb.template, cover: nb.cover, thumb: S.thumb });
  } catch (e) { console.error(e); toast('Could not save: ' + e.message); }
}
function thumbnail(pg, w) {
  const cv = document.createElement('canvas'); const s = w / R.PAGE_W; cv.width = w; cv.height = Math.round(R.PAGE_H * s);
  const c = cv.getContext('2d'); c.scale(s, s); R.renderPage(c, pg, {}); return cv.toDataURL('image/jpeg', 0.7);
}

/* ---------------- pointer input ---------------- */
const pointers = new Map();
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', onDown);
canvas.addEventListener('pointermove', onMove);
canvas.addEventListener('pointerup', onUp);
canvas.addEventListener('pointercancel', onUp);
canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && gesture && gesture.pointerId === e.pointerId) {/* keep: capture */} });

function onDown(e) {
  if (S.editing) finishEdit();
  if (e.pointerType === 'pen' && !S.pencilOnly && !localStorage.getItem('penSeen')) {
    localStorage.setItem('penSeen', '1'); setPencilOnly(true); toast('Apple Pencil detected: fingers now scroll and zoom.');
  }
  if (e.pointerType === 'touch') {
    pointers.set(e.pointerId, stagePt(e));
    if (pointers.size === 2) { if (gesture) cancelGesture(); nav = pinchStart(); return; }
    if (pointers.size > 2) return;
    if (S.pencilOnly) { const p = stagePt(e); nav = { kind: 'pan', x: p[0], y: p[1], vx: S.view.x, vy: S.view.y }; return; }
  } else { pointers.clear(); nav = null; if (gesture) cancelGesture(); }
  if (gesture) return;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  startGesture(e);
}
function onMove(e) {
  if (e.pointerType === 'touch' && pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, stagePt(e));
    if (nav && nav.kind === 'pinch') { pinchMove(); return; }
    if (nav && nav.kind === 'pan') { const p = stagePt(e); S.view.x = nav.vx + p[0] - nav.x; S.view.y = nav.vy + p[1] - nav.y; clampView(); requestRender(); return; }
  }
  if (!gesture || gesture.pointerId !== e.pointerId) return;
  let evs = [e];
  if (gesture.kind === 'stroke' && e.getCoalescedEvents) { const co = e.getCoalescedEvents(); if (co.length) evs = co; }
  for (const ev of evs) moveGesture(ev);
}
function onUp(e) {
  if (e.pointerType === 'touch') {
    pointers.delete(e.pointerId);
    if (nav) {
      if (pointers.size === 1 && S.pencilOnly) { const p = [...pointers.values()][0]; nav = { kind: 'pan', x: p[0], y: p[1], vx: S.view.x, vy: S.view.y }; }
      else if (pointers.size < 2) nav = null;
    }
    if (!nav) requestRender();
  }
  if (gesture && gesture.pointerId === e.pointerId) endGesture(e);
}
function pinchStart() {
  const [a, b] = [...pointers.values()];
  return { kind: 'pinch', mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, v: { ...S.view } };
}
function pinchMove() {
  const [a, b] = [...pointers.values()]; if (!a || !b) return;
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
  const s = clamp(nav.v.s * d / nav.d, 0.25, 8);
  const pp = [(nav.mid[0] - nav.v.x) / nav.v.s, (nav.mid[1] - nav.v.y) / nav.v.s];
  S.view = { s, x: mid[0] - pp[0] * s, y: mid[1] - pp[1] * s }; clampView(); requestRender();
}
stage.addEventListener('wheel', e => {
  e.preventDefault();
  clearTimeout(wheelTimer); wheelTimer = setTimeout(() => { wheelTimer = null; requestRender(); }, 120);
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), stagePt(e));
  else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; clampView(); requestRender(); }
}, { passive: false });

const pressureOf = e => e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;

function startGesture(e) {
  const p = evPage(e), id = e.pointerId;
  switch (S.tool) {
    case 'pen': case 'highlighter':
      gesture = { kind: 'stroke', pointerId: id, el: { type: 'stroke', id: uid(), tool: S.tool, color: S.color,
        size: S.tool === 'pen' ? R.PEN_SIZES[S.size] : R.HL_SIZES[S.size], sim: e.pointerType !== 'pen', points: [[p[0], p[1], pressureOf(e)]] } };
      break;
    case 'eraser':
      gesture = { kind: 'erase', pointerId: id, removed: [] }; eraseAt(p); break;
    case 'rect': case 'ellipse': case 'line': case 'arrow':
      gesture = { kind: 'shape', pointerId: id, start: p, el: { type: 'shape', id: uid(), kind: S.tool, cx: p[0], cy: p[1], w: 0, h: 0, rot: 0,
        color: S.color, width: R.SHAPE_WIDTHS[S.size], fill: 'none' } };
      break;
    case 'text': createText(p); break;
    case 'select': selectDown(e, p); break;
  }
  requestRender();
}
let lastTap = null;
function selectDown(e, p) {
  const f = selFrame();
  if (f) {
    const h = hitHandle(f, stagePt(e));
    if (h) { gesture = { kind: 'handle', pointerId: e.pointerId, handle: h, f, start: p, els: S.sel.slice(), snap: S.sel.map(cloneEl), moved: false }; return; }
  }
  const hit = hitTest(p);
  if (hit) {
    const now = performance.now();
    if (hit.type === 'text' && lastTap && lastTap.el === hit && now - lastTap.t < 450) { lastTap = null; setSel([hit]); startEdit(hit); return; }
    lastTap = { el: hit, t: now };
    if (!S.sel.includes(hit)) setSel([hit]);
    gesture = { kind: 'move', pointerId: e.pointerId, start: p, els: S.sel.slice(), snap: S.sel.map(cloneEl), moved: false };
  } else {
    setSel([]); gesture = { kind: 'lasso', pointerId: e.pointerId, pts: [p] };
  }
}
function hitTest(p) {
  const tol = 7 / S.view.s, els = page().elements;
  for (let i = els.length - 1; i >= 0; i--) if (R.hitElement(els[i], p, tol)) return els[i];
  return null;
}
function hitHandle(f, sp) {
  for (const h of handles(f)) { const q = toScreen(h.p); if (Math.hypot(q[0] - sp[0], q[1] - sp[1]) <= 18) return h; }
  return null;
}
function moveGesture(ev) {
  const g = gesture, p = evPage(ev);
  switch (g.kind) {
    case 'stroke': {
      const pts = g.el.points, last = pts[pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.35) pts.push([p[0], p[1], pressureOf(ev)]);
      break;
    }
    case 'erase': eraseAt(p); break;
    case 'shape': {
      const [sx, sy] = g.start, dx = p[0] - sx, dy = p[1] - sy, el = g.el;
      if (el.kind === 'line' || el.kind === 'arrow') { el.cx = sx + dx / 2; el.cy = sy + dy / 2; el.w = Math.hypot(dx, dy); el.h = 0; el.rot = Math.atan2(dy, dx); }
      else { el.cx = sx + dx / 2; el.cy = sy + dy / 2; el.w = Math.abs(dx); el.h = Math.abs(dy); }
      break;
    }
    case 'move': {
      const dx = p[0] - g.start[0], dy = p[1] - g.start[1];
      if (!g.moved && Math.hypot(dx, dy) * S.view.s < 3) return;
      g.moved = true; g.els.forEach((el, i) => translateEl(el, g.snap[i], dx, dy)); break;
    }
    case 'handle': g.moved = true; applyHandle(p); break;
    case 'lasso': g.pts.push(p); break;
  }
  requestRender();
}
function endGesture() {
  const g = gesture; gesture = null;
  switch (g.kind) {
    case 'stroke': {
      const el = g.el;
      if (el.points.length === 1) el.points.push([el.points[0][0] + 0.3, el.points[0][1] + 0.3, el.points[0][2]]);
      page().elements.push(el); commit(opAdd([el])); break;
    }
    case 'erase':
      if (g.removed.length) commit(opRemove(g.removed));
      break;
    case 'shape': {
      const el = g.el;
      if (el.w < 4 && el.h < 4) { if (isLineEl(el)) { el.w = 140; el.rot = 0; el.cx = g.start[0] + 70; } else { el.w = 140; el.h = 90; el.cx = g.start[0] + 70; el.cy = g.start[1] + 45; } }
      page().elements.push(el); setTool('select'); setSel([el]); commit(opAdd([el])); break;
    }
    case 'move': case 'handle':
      if (g.moved) commit(opModify(g.snap, g.els.map(cloneEl)));
      break;
    case 'lasso':
      if (g.pts.length >= 3) setSel(page().elements.filter(el => R.elementInLasso(el, g.pts)));
      break;
  }
  requestRender();
}
function cancelGesture() {
  const g = gesture; gesture = null; if (!g) return;
  if (g.kind === 'move' || g.kind === 'handle') g.els.forEach((el, i) => Object.assign(el, g.snap[i]));
  requestRender();
}
function eraseAt(p) {
  const tol = Math.max(8 / S.view.s, 3), els = page().elements;
  const gone = els.filter(el => el.type === 'stroke' && R.hitElement(el, p, tol));
  if (!gone.length) return;
  const items = removeEls(gone);
  if (gesture && gesture.kind === 'erase') gesture.removed.push(...items);
  if (S.sel.some(el => gone.includes(el))) setSel(S.sel.filter(el => !gone.includes(el)));
  layerDirty = true;
}

/* ---------------- transforms ---------------- */
function translateEl(el, s, dx, dy) {
  if (el.type === 'stroke') el.points = s.points.map(p => [p[0] + dx, p[1] + dy, p[2]]);
  else { el.cx = s.cx + dx; el.cy = s.cy + dy; }
}
function scaleEl(el, s, ax, ay, k) {
  if (el.type === 'stroke') { el.points = s.points.map(p => [ax + (p[0] - ax) * k, ay + (p[1] - ay) * k, p[2]]); el.size = s.size * k; return; }
  el.cx = ax + (s.cx - ax) * k; el.cy = ay + (s.cy - ay) * k; el.w = s.w * k; el.h = s.h * k;
  if (el.type === 'shape') el.width = s.width * k;
  if (el.type === 'text') { el.size = s.size * k; R.layoutText(el); }
}
function rotateEl(el, s, cx, cy, da) {
  const c = Math.cos(da), sn = Math.sin(da);
  const rp = (x, y) => [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c];
  if (el.type === 'stroke') { el.points = s.points.map(p => { const q = rp(p[0], p[1]); return [q[0], q[1], p[2]]; }); return; }
  [el.cx, el.cy] = rp(s.cx, s.cy); el.rot = (s.rot || 0) + da;
}
function snapAngle(a) {
  const deg = a * 180 / Math.PI, n = Math.round(deg / 90) * 90;
  return Math.abs(deg - n) < 4 ? n * Math.PI / 180 : a;
}
function applyHandle(p) {
  const g = gesture, f = g.f, h = g.handle;
  if (h.id === 'rot') {
    const a0 = Math.atan2(g.start[1] - f.cy, g.start[0] - f.cx), a1 = Math.atan2(p[1] - f.cy, p[0] - f.cx);
    let da = a1 - a0;
    if (f.single) da = snapAngle(f.rot + da) - f.rot;
    g.els.forEach((el, i) => rotateEl(el, g.snap[i], f.cx, f.cy, da));
    return;
  }
  if (h.id === 'p0' || h.id === 'p1') {
    const el = g.els[0];
    const other = R.fromLocal(f, [h.id === 'p0' ? f.w / 2 : -f.w / 2, 0]);
    const a = h.id === 'p0' ? p : other, b = h.id === 'p0' ? other : p;
    el.cx = (a[0] + b[0]) / 2; el.cy = (a[1] + b[1]) / 2; el.w = Math.max(2, Math.hypot(b[0] - a[0], b[1] - a[1])); el.rot = Math.atan2(b[1] - a[1], b[0] - a[0]);
    return;
  }
  const sign = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] }[h.id];
  const anchorL = [-sign[0] * f.w / 2, -sign[1] * f.h / 2];
  if (f.single) {
    const el = g.els[0], s = g.snap[0], local = R.toLocal(f, p);
    let nw = Math.max(8, (local[0] - anchorL[0]) * sign[0]), nh = Math.max(8, (local[1] - anchorL[1]) * sign[1]);
    if (el.type === 'image') { const k = Math.max(nw / s.w, nh / s.h); nw = s.w * k; nh = s.h * k; }
    if (el.type === 'text' || el.type === 'link') nh = s.h;
    [el.cx, el.cy] = R.fromLocal(f, [anchorL[0] + sign[0] * nw / 2, anchorL[1] + sign[1] * nh / 2]);
    el.w = nw; el.h = nh;
    if (el.type === 'text') { R.layoutText(el); [el.cx, el.cy] = R.fromLocal(f, [anchorL[0] + sign[0] * nw / 2, anchorL[1] + sign[1] * el.h / 2]); }
  } else {
    const anchor = R.fromLocal(f, anchorL), d0 = Math.hypot(f.w, f.h) || 1;
    const dirx = (f.cx - anchor[0]) * 2 / d0, diry = (f.cy - anchor[1]) * 2 / d0;
    const k = Math.max(0.05, ((p[0] - anchor[0]) * dirx + (p[1] - anchor[1]) * diry) / d0);
    g.els.forEach((el, i) => scaleEl(el, g.snap[i], anchor[0], anchor[1], k));
  }
}

/* ---------------- selection toolbar ---------------- */
function updateSelBar() {
  selBar.innerHTML = '';
  if (!S.sel.length || S.editing) { selBar.hidden = true; return; }
  const sel = S.sel, hasShape = sel.some(e => e.type === 'shape' && (e.kind === 'rect' || e.kind === 'ellipse'));
  const colorable = sel.some(e => e.type !== 'image' && e.type !== 'link');
  const add = (label, fn, cls) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; selBar.appendChild(b); return b; };
  const sep = () => { const s = document.createElement('span'); s.className = 'sep'; selBar.appendChild(s); };
  if (colorable) {
    for (const c of COLORS) { const b = add('', () => mutateSel(e => { if (e.type !== 'image' && e.type !== 'link') e.color = c; }), 'sw'); b.style.background = c; b.title = 'Color'; }
    sep();
  }
  if (hasShape) {
    for (const c of FILLS) { const b = add('', () => mutateSel(e => { if (e.type === 'shape') e.fill = c; }), 'sw' + (c === 'none' ? ' none' : '')); if (c !== 'none') b.style.background = c; b.title = c === 'none' ? 'No fill' : 'Fill'; }
    sep();
  }
  if (sel.some(e => e.type !== 'image' && e.type !== 'link')) {
    add('−', () => resizeSel(0.8), ''); add('+', () => resizeSel(1.25), ''); sep();
  }
  if (sel.length === 1 && sel[0].type === 'text') add('Edit', () => startEdit(sel[0]));
  if (sel.length === 1 && sel[0].type === 'link') add('Open', () => window.open(sel[0].url, '_blank', 'noopener'));
  add('Duplicate', duplicateSel); add('Front', () => reorderSel(true)); add('Back', () => reorderSel(false));
  add('Delete', deleteSel, 'danger');
  selBar.hidden = false; positionSelBar();
}
function positionSelBar() {
  if (selBar.hidden) return;
  const f = selFrame(); if (!f) { selBar.hidden = true; return; }
  const b = R.unionBox(S.sel), [x0, y0] = toScreen([b.x0, b.y0]), [x1] = toScreen([b.x1, b.y1]);
  const bw = selBar.offsetWidth, bh = selBar.offsetHeight;
  let left = (x0 + x1) / 2 - bw / 2, top = y0 - bh - 48;
  if (top < 6) top = toScreen([b.x1, b.y1])[1] + 14;
  selBar.style.left = clamp(left, 6, Math.max(6, W - bw - 6)) + 'px'; selBar.style.top = clamp(top, 6, Math.max(6, H - bh - 6)) + 'px';
}
function mutateSel(fn) {
  const before = S.sel.map(cloneEl);
  S.sel.forEach(fn); S.sel.forEach(e => e.type === 'text' && R.layoutText(e));
  commit(opModify(before, S.sel.map(cloneEl))); requestRender();
}
function resizeSel(k) {
  mutateSel(e => {
    if (e.type === 'stroke') e.size *= k;
    else if (e.type === 'shape') e.width = clamp(e.width * k, 0.5, 30);
    else if (e.type === 'text') e.size = clamp(Math.round(e.size * k), 6, 120);
  });
}
function duplicateSel() {
  const copies = S.sel.map(e => { const c = cloneEl(e); c.id = uid(); translateEl(c, c, 18, 18); return c; });
  page().elements.push(...copies); setSel(copies); commit(opAdd(copies)); requestRender();
}
function reorderSel(front) {
  const before = page().elements.map(e => e.id);
  const rest = page().elements.filter(e => !S.sel.includes(e));
  page().elements = front ? rest.concat(S.sel) : S.sel.concat(rest);
  commit(opReorder(before, page().elements.map(e => e.id))); requestRender();
}
function deleteSel() {
  if (!S.sel.length) return;
  const items = removeEls(S.sel); setSel([]); commit(opRemove(items)); requestRender();
}

/* ---------------- text editing ---------------- */
function createText(p) {
  const el = { type: 'text', id: uid(), cx: p[0] + 100, cy: p[1], w: 200, h: 30, rot: 0, text: '', size: R.TEXT_SIZES[S.size], color: S.color };
  R.layoutText(el); el.cy = p[1] + el.h / 2;
  page().elements.push(el); setTool('select'); setSel([el]); startEdit(el, true);
}
function startEdit(el, isNew) {
  S.editing = el; S.editBefore = cloneEl(el); S.editIsNew = !!isNew; layerDirty = true;
  ta.hidden = false; ta.value = el.text; positionTA(); updateSelBar(); requestRender();
  // focus synchronously: iPadOS only shows the keyboard when focus happens inside the tap handler
  ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
}
function positionTA() {
  const el = S.editing, s = S.view.s, [sx, sy] = toScreen([el.cx, el.cy]);
  ta.style.left = sx + 'px'; ta.style.top = sy + 'px'; ta.style.width = el.w * s + 'px'; ta.style.height = el.h * s + 'px';
  ta.style.fontSize = el.size * s + 'px'; ta.style.padding = R.TEXT_PAD * s + 'px'; ta.style.color = el.color;
  ta.style.transform = `translate(-50%,-50%) rotate(${el.rot || 0}rad)`;
}
ta.addEventListener('input', () => { const el = S.editing; if (!el) return; el.text = ta.value; R.layoutText(el); positionTA(); requestRender(); });
ta.addEventListener('blur', () => setTimeout(() => { if (S.editing && document.activeElement !== ta) finishEdit(); }, 50));
ta.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); finishEdit(); } });
function finishEdit() {
  const el = S.editing; if (!el) return;
  S.editing = null; ta.hidden = true; layerDirty = true;
  const before = S.editBefore, isNew = S.editIsNew; S.editBefore = null; S.editIsNew = false;
  if (!page().elements.includes(el)) { updateSelBar(); requestRender(); return; }
  if (!el.text.trim()) { removeEls([el]); setSel([]); saveSoon(); }
  else if (isNew) commit(opAdd([el]));
  else if (el.text !== before.text) commit(opModify([before], [cloneEl(el)]));
  updateSelBar(); requestRender();
}

/* ---------------- inserts: image & link ---------------- */
$('#btnImage').onclick = () => { if (S.editing) finishEdit(); $('#fileImage').value = ''; $('#fileImage').click(); };
$('#fileImage').onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const src = await fileToDataURL(file, 1600);
    const img = await R.imageReady(src);
    const maxW = R.PAGE_W * 0.6, k = Math.min(1, maxW / img.naturalWidth, (R.PAGE_H * 0.6) / img.naturalHeight);
    const c = toPage([W / 2, H / 2]);
    const el = { type: 'image', id: uid(), src, cx: clamp(c[0], 0, R.PAGE_W), cy: clamp(c[1], 0, R.PAGE_H), w: img.naturalWidth * k, h: img.naturalHeight * k, rot: 0 };
    page().elements.push(el); setTool('select'); setSel([el]); commit(opAdd([el])); requestRender();
  } catch (err) { toast('Could not add that photo.'); console.error(err); }
};
function fileToDataURL(file, max) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      res(file.type === 'image/png' ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = rej; img.src = url;
  });
}
$('#btnLink').onclick = () => { if (S.editing) finishEdit(); $('#linkUrl').value = ''; $('#linkTitle').value = ''; $('#dlgLink').showModal(); $('#linkUrl').focus(); };
$('#dlgLink').addEventListener('close', () => {
  if ($('#dlgLink').returnValue !== 'ok') return;
  let url = $('#linkUrl').value.trim(); if (!url) return;
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  const c = toPage([W / 2, H / 2]);
  const el = { type: 'link', id: uid(), url, title: $('#linkTitle').value.trim(), cx: clamp(c[0], 120, R.PAGE_W - 120), cy: clamp(c[1], 24, R.PAGE_H - 24), w: 240, h: 48, rot: 0 };
  page().elements.push(el); setTool('select'); setSel([el]); commit(opAdd([el])); requestRender();
});

/* ---------------- toolbar ---------------- */
function setTool(t) {
  if (S.editing && t !== 'select') finishEdit();
  S.tool = t;
  $$('.tool[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  canvas.classList.toggle('sel', t === 'select');
  if (t !== 'select' && S.sel.length) { setSel([]); requestRender(); }
}
$$('.tool[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));

const colorsEl = $('#colors');
for (const c of COLORS) { const b = document.createElement('button'); b.style.background = c; b.dataset.color = c; b.onclick = () => setColor(c); colorsEl.appendChild(b); }
$('#colorPick').oninput = e => setColor(e.target.value, true);
function setColor(c, custom) {
  S.color = c;
  $$('#colors button').forEach(b => b.classList.toggle('on', !custom && b.dataset.color === c));
  $('.custom').classList.toggle('on', !!custom);
  if (S.tool === 'select' && S.sel.length) mutateSel(e => { if (e.type !== 'image' && e.type !== 'link') e.color = c; });
}
$$('#sizes button').forEach(b => b.onclick = () => setSize(b.dataset.size));
function setSize(s) { S.size = s; $$('#sizes button').forEach(b => b.classList.toggle('on', b.dataset.size === s)); }

function setPencilOnly(v) { S.pencilOnly = v; localStorage.setItem('pencilOnly', v ? '1' : '0'); $('#btnPencilOnly').classList.toggle('on', v); }
$('#btnPencilOnly').onclick = () => { setPencilOnly(!S.pencilOnly); toast(S.pencilOnly ? 'Pencil only: fingers scroll and zoom.' : 'Fingers can draw now. Use two fingers to zoom.'); };
$('#btnFit').onclick = fitView;
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;

document.addEventListener('keydown', e => {
  if (S.editing || !S.nb || $('#editor').hidden || document.querySelector('dialog[open]')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.key === 'Backspace' || e.key === 'Delete') { if (S.sel.length) { e.preventDefault(); deleteSel(); } }
  else if (e.key === 'Escape') { setSel([]); requestRender(); }
});

/* ---------------- pages ---------------- */
function goPage(i) {
  if (S.editing) finishEdit();
  S.pi = clamp(i, 0, S.nb.pages.length - 1); setSel([]); layerDirty = true; updatePageUI(); updateUndoButtons(); requestRender();
}
function updatePageUI() {
  $('#btnPageNo').textContent = `${S.pi + 1} / ${S.nb.pages.length}`;
  $('#btnPrev').disabled = S.pi === 0; $('#btnNext').disabled = S.pi >= S.nb.pages.length - 1;
  $('#btnTitle').textContent = S.nb.name;
  if (!$('#pageStrip').hidden) renderThumbs();
}
$('#btnPrev').onclick = () => goPage(S.pi - 1);
$('#btnNext').onclick = () => goPage(S.pi + 1);
$('#btnAddPage').onclick = addPage;
function addPage() {
  if (S.editing) finishEdit();
  S.nb.pages.splice(S.pi + 1, 0, newPage(page().template));
  goPage(S.pi + 1); saveSoon(); toast(`Page ${S.pi + 1} added`);
}
function deletePage() {
  if (S.nb.pages.length <= 1) { toast('A notebook needs at least one page.'); return; }
  if (!confirm(`Delete page ${S.pi + 1}? This cannot be undone.`)) return;
  S.nb.pages.splice(S.pi, 1); S.thumbDirty = true; goPage(S.pi); saveSoon();
}
$('#btnPageNo').onclick = () => { $('#pageStrip').hidden = !$('#pageStrip').hidden; if (!$('#pageStrip').hidden) renderThumbs(); };
$('#btnStripClose').onclick = () => { $('#pageStrip').hidden = true; };
function renderThumbs() {
  const box = $('#thumbs'); box.innerHTML = '';
  S.nb.pages.forEach((pg, i) => {
    const b = document.createElement('button'); b.className = 'thumb' + (i === S.pi ? ' cur' : '');
    const cv = document.createElement('canvas'); const w = 130, s = w / R.PAGE_W; cv.width = w * 2; cv.height = Math.round(R.PAGE_H * s) * 2;
    const c = cv.getContext('2d'); c.scale(s * 2, s * 2); R.renderPage(c, pg, { onImage: () => {} });
    const n = document.createElement('div'); n.className = 'n'; n.textContent = `Page ${i + 1}`;
    b.append(cv, n); b.onclick = () => { goPage(i); renderThumbs(); };
    box.appendChild(b);
  });
  const add = document.createElement('button'); add.className = 'thumb add'; add.textContent = '+ Add page'; add.onclick = addPage; box.appendChild(add);
  const cur = box.querySelector('.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
}

/* ---------------- menu ---------------- */
$('#btnMenu').onclick = () => { if (S.editing) finishEdit(); $('#menuTitle').textContent = S.nb.name; $('#dlgMenu').showModal(); };
$('#dlgMenu').addEventListener('close', async () => {
  const v = $('#dlgMenu').returnValue; $('#dlgMenu').returnValue = '';
  switch (v) {
    case 'pdf': await doExportPDF(S.nb.pages.map((_, i) => i)); break;
    case 'pdfpage': await doExportPDF([S.pi]); break;
    case 'png': await doExportPNG(); break;
    case 'paper': openPaperDialog(); break;
    case 'deletepage': deletePage(); break;
    case 'rename': renameNotebook(); break;
    case 'backup': await doBackup(); break;
    case 'deletenb': await deleteNotebook(); break;
    case 'help': $('#dlgHelp').showModal(); break;
  }
});
$('#btnTitle').onclick = renameNotebook;
function renameNotebook() {
  const n = prompt('Notebook name', S.nb.name); if (n === null) return;
  S.nb.name = n.trim() || 'Untitled'; updatePageUI(); saveSoon();
}
const safeName = s => (s || 'Notebook').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'Notebook';
async function doExportPDF(indices) {
  try {
    toast('Building PDF…');
    await saveNow();
    const blob = await notebookToPDF(S.nb, indices);
    const name = indices.length === 1 ? `${safeName(S.nb.name)} p${indices[0] + 1}.pdf` : `${safeName(S.nb.name)}.pdf`;
    const r = await shareOrDownload(blob, name, S.nb.name);
    toast(r === 'shared' ? 'PDF shared.' : r === 'downloaded' ? 'PDF saved to downloads.' : 'Cancelled.');
  } catch (e) { console.error(e); toast('PDF export failed: ' + e.message); }
}
async function doExportPNG() {
  try {
    const blob = await pageToPNG(page(), 2);
    const r = await shareOrDownload(blob, `${safeName(S.nb.name)} p${S.pi + 1}.png`, S.nb.name);
    toast(r === 'shared' ? 'Image shared.' : r === 'downloaded' ? 'Image saved to downloads.' : 'Cancelled.');
  } catch (e) { console.error(e); toast('Image export failed: ' + e.message); }
}
async function doBackup() {
  await saveNow();
  const blob = new Blob([JSON.stringify(clone(S.nb))], { type: 'application/json' });
  await shareOrDownload(blob, `${safeName(S.nb.name)}.notebook.json`, S.nb.name + ' backup');
}
async function deleteNotebook() {
  if (!confirm(`Delete “${S.nb.name}” and all its pages? This cannot be undone.`)) return;
  const id = S.nb.id; S.nb = null; clearTimeout(saveTimer);
  await DB.del('notebooks', id); await DB.del('meta', id);
  showHome();
}

/* paper picker (shared by New dialog and Paper dialog) */
function buildPaperPick(container, selected, onPick) {
  container.innerHTML = '';
  for (const [key, t] of Object.entries(R.TEMPLATES)) {
    const b = document.createElement('button'); b.type = 'button'; b.className = key === selected ? 'on' : ''; b.dataset.key = key;
    const cv = document.createElement('canvas'); cv.width = 120; cv.height = 155;
    const c = cv.getContext('2d'); c.scale(120 / R.PAGE_W, 120 / R.PAGE_W); R.renderPage(c, { template: key, elements: [] }, {});
    const n = document.createElement('span'); n.textContent = t.name;
    b.append(cv, n); b.onclick = () => { [...container.children].forEach(x => x.classList.toggle('on', x === b)); onPick(key); };
    container.appendChild(b);
  }
}
let paperChoice = 'ruled';
function openPaperDialog() {
  paperChoice = page().template; $('#paperAll').checked = false;
  buildPaperPick($('#paperPick'), paperChoice, k => paperChoice = k);
  $('#dlgPaper').showModal();
}
$('#dlgPaper').addEventListener('close', () => {
  if ($('#dlgPaper').returnValue !== 'ok') return;
  if ($('#paperAll').checked) { S.nb.pages.forEach(p => p.template = paperChoice); S.nb.template = paperChoice; }
  else page().template = paperChoice;
  layerDirty = true; S.thumbDirty = true; saveSoon(); requestRender(); if (!$('#pageStrip').hidden) renderThumbs();
});

/* ---------------- home ---------------- */
let newPaper = 'ruled', newCover = COVERS[0];
$('#btnNew').onclick = () => {
  $('#newName').value = ''; newPaper = 'ruled'; newCover = COVERS[0];
  buildPaperPick($('#newPaper'), newPaper, k => { newPaper = k; if (k === 'composition') pickCover('marble'); });
  const cp = $('#newCover'); cp.innerHTML = '';
  for (const c of COVERS.concat(['marble'])) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.cover = c; b.title = c === 'marble' ? 'Composition marble' : '';
    if (c === 'marble') b.style.background = marbleCSS(); else b.style.background = c;
    b.onclick = () => pickCover(c); cp.appendChild(b);
  }
  pickCover(newCover);
  $('#dlgNew').showModal(); $('#newName').focus();
};
function pickCover(c) { newCover = c; $$('#newCover button').forEach(b => b.classList.toggle('on', b.dataset.cover === c)); }
const marbleCSS = () => 'radial-gradient(circle at 20% 30%, #fff 0 2px, transparent 3px), radial-gradient(circle at 70% 60%, #fff 0 3px, transparent 4px), radial-gradient(circle at 40% 80%, #ddd 0 2px, transparent 3px), radial-gradient(circle at 85% 20%, #eee 0 2px, transparent 3px), #1a1a1a';
$('#dlgNew').addEventListener('close', async () => {
  if ($('#dlgNew').returnValue !== 'ok') return;
  const nb = { id: uid(), name: $('#newName').value.trim() || 'Untitled', created: Date.now(), updated: Date.now(), template: newPaper, cover: newCover, pages: [newPage(newPaper)] };
  await openNotebook(nb, true);
});

$('#btnImport').onclick = () => { $('#fileImport').value = ''; $('#fileImport').click(); };
$('#fileImport').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const nb = JSON.parse(await f.text());
    if (!nb || !Array.isArray(nb.pages)) throw new Error('not a notebook file');
    nb.id = uid(); nb.name = (nb.name || f.name.replace(/\.notebook\.json$|\.json$/i, '')) + ''; nb.updated = Date.now();
    nb.pages.forEach(p => { p.id = p.id || uid(); p.template = p.template in R.TEMPLATES ? p.template : 'blank'; p.elements = Array.isArray(p.elements) ? p.elements : []; });
    await openNotebook(nb, true);
  } catch (err) { toast('That file is not a notebook backup.'); }
};
$('#btnHelp').onclick = () => $('#dlgHelp').showModal();

async function showHome() {
  if (S.nb) { if (S.editing) finishEdit(); await saveNow(); }
  S.nb = null; S.sel = [];
  $('#editor').hidden = true; $('#home').hidden = false; $('#pageStrip').hidden = true;
  S.metas = (await DB.all('meta')).sort((a, b) => b.updated - a.updated);
  const cards = $('#cards'); cards.innerHTML = '';
  $('#homeEmpty').hidden = S.metas.length > 0;
  for (const m of S.metas) {
    const b = document.createElement('button'); b.className = 'card';
    const cover = m.cover === 'marble' ? marbleCSS() : (m.cover || COVERS[0]);
    b.innerHTML = `<div class="cover"><div class="spine"></div>${m.thumb ? `<img alt="">` : ''}</div><div class="meta"><div class="name"></div><div class="sub"></div></div>`;
    b.querySelector('.cover').style.background = cover;
    if (m.thumb) b.querySelector('img').src = m.thumb;
    b.querySelector('.name').textContent = m.name;
    b.querySelector('.sub').textContent = `${m.pages} page${m.pages === 1 ? '' : 's'} · ${new Date(m.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    b.onclick = async () => { const nb = await DB.get('notebooks', m.id); if (nb) openNotebook(nb); else toast('Could not open that notebook.'); };
    cards.appendChild(b);
  }
}
async function openNotebook(nb, isNew) {
  S.nb = nb; S.pi = 0; S.sel = []; S.thumb = null; S.thumbDirty = true; layerDirty = true;
  $('#home').hidden = true; $('#editor').hidden = false;
  resize(); fitView(); updatePageUI(); updateUndoButtons(); updateSelBar();
  if (isNew) await saveNow();
  requestRender();
}
$('#btnHome').onclick = showHome;

/* ---------------- misc ---------------- */
$$('dialog .cancel').forEach(b => b.onclick = () => b.closest('dialog').close('cancel'));
let toastTimer = null;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600); }
document.addEventListener('visibilitychange', () => { if (document.hidden && S.nb) saveNow(); });
window.addEventListener('pagehide', () => { if (S.nb) saveNow(); });

/* ---------------- boot ---------------- */
window.__nb = () => S;   // debug hook: inspect state from the console
(async function boot() {
  setTool('pen'); setColor(COLORS[0]); setSize('m'); setPencilOnly(S.pencilOnly);
  try { await DB.open(); } catch (e) { alert('This browser cannot store notebooks (private mode?). ' + e.message); }
  await showHome();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
