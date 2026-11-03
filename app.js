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
  snap: localStorage.getItem('snap') !== '0',
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
  if (gesture && gesture.kind === 'stroke') {
    const pr = gesture.predicted && gesture.predicted.length ? { ...gesture.el, points: gesture.el.points.concat(gesture.predicted) } : gesture.el;
    R.drawElement(ctx, pr, { live: true });
  }
  if (gesture && gesture.kind === 'shape') R.drawElement(ctx, gesture.el, {});
  ctx.restore();
  if (gesture && gesture.kind === 'lasso' && gesture.pts.length > 1) {
    ctx.save(); ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.5 / S.view.s; ctx.setLineDash([6 / S.view.s, 5 / S.view.s]);
    ctx.beginPath(); gesture.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); ctx.restore();
  }
  drawGuides();
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
    const pts = R.linePts(f.single);
    pts.forEach((p, i) => hs.push({ id: i === 0 ? 'p0' : i === pts.length - 1 ? 'p1' : 'c' + i, p, idx: i }));
    R.curveSegments(pts).forEach((b, i) => hs.push({ id: 'm' + i, p: R.bezierPoint(b, 0.5), idx: i, add: true }));
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
    if (h.add) {   // small hollow dot: tap or drag to add a bend here
      ctx.beginPath(); ctx.arc(h.p[0], h.p[1], 5 / s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fill(); ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1.2 / s; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(h.p[0] - 2.5 / s, h.p[1]); ctx.lineTo(h.p[0] + 2.5 / s, h.p[1]); ctx.moveTo(h.p[0], h.p[1] - 2.5 / s); ctx.lineTo(h.p[0], h.p[1] + 2.5 / s); ctx.stroke();
      ctx.strokeStyle = '#2563eb';
      continue;
    }
    const bend = h.id[0] === 'c';
    ctx.beginPath(); ctx.arc(h.p[0], h.p[1], (h.id === 'rot' ? 8 : 7) / s, 0, Math.PI * 2);
    ctx.fillStyle = (h.id === 'rot' || bend) ? '#2563eb' : '#fff'; ctx.fill(); ctx.lineWidth = 1.5 / s; ctx.stroke();
  }
  ctx.restore();
}

/* ---------------- history (per page, small operations) ---------------- */
const hist = pg => (pg._hist || (pg._hist = { undo: [], redo: [] }));
function commit(op) {
  const h = hist(page()); h.undo.push(op); if (h.undo.length > 500) h.undo.shift(); h.redo = [];
  if (S.pi === 0) S.thumbDirty = true;
  layerDirty = true; updateUndoButtons(); updateSelBar(); saveSoon();
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
    if (S.thumbDirty || !S.thumb) {
      for (const el of S.nb.pages[0].elements) if (el.type === 'image') await R.imageReady(el.src);   // photos must be loaded or the thumbnail shows gaps
      if (!S.nb) return;
      S.thumb = thumbnail(S.nb.pages[0], 160); S.thumbDirty = false;
    }
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
let lastPenTime = -1e9;   // last time the Apple Pencil was in contact (hovering does not count): hand contacts near that moment are ignored
const PEN_GRACE_MS = 350;
canvas.addEventListener('contextmenu', e => e.preventDefault());
/* iPad Safari runs its own double-tap-zoom / text-selection / loupe gesture detectors on raw touches, and a Pencil
   touch that arrives quickly after the previous stroke gets held by them and never reaches us as a pointerdown.
   Claiming every raw touch on the canvas (non-passive, preventDefault) switches those detectors off. Our own
   pointer-event handling is unaffected: pointer events are dispatched before the touch events. */
for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(type, e => { if (e.cancelable) e.preventDefault(); }, { passive: false });
stage.addEventListener('touchstart', e => { if (e.cancelable && e.target === canvas) e.preventDefault(); }, { passive: false });
canvas.addEventListener('pointerdown', onDown);
canvas.addEventListener('pointermove', onMove);
canvas.addEventListener('pointerup', onUp);
canvas.addEventListener('pointercancel', onUp);
canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && gesture && gesture.pointerId === e.pointerId) {/* keep: capture */} });

function onDown(e) {
  if (S.editing) finishEdit();
  const now = performance.now();
  if (e.pointerType === 'pen' && !S.pencilOnly && !localStorage.getItem('penSeen')) {
    localStorage.setItem('penSeen', '1'); setPencilOnly(true); toast('Apple Pencil detected: fingers now scroll and zoom.');
  }
  if (e.pointerType === 'touch') {
    if (S.pencilOnly) {
      // The side of the writing hand: a contact while the Pencil is down, right after it was used, or palm-sized. Never let it touch a stroke.
      const palm = (e.width || 0) > 40 || (e.height || 0) > 40;
      if (palm || (gesture && gesture.pen) || now - lastPenTime < PEN_GRACE_MS) return;
    }
    pointers.set(e.pointerId, stagePt(e));
    if (pointers.size === 2) { if (gesture && !gesture.pen) cancelGesture(); nav = pinchStart(); return; }
    if (pointers.size > 2) return;
    if (S.pencilOnly) { const p = stagePt(e); nav = { kind: 'pan', x: p[0], y: p[1], vx: S.view.x, vy: S.view.y }; return; }
  } else {
    if (e.pointerType === 'pen') lastPenTime = now;
    pointers.clear(); nav = null;
    if (gesture && gesture.pen) endGesture(e);        // a missed pen-up: keep that stroke rather than drop it
    else if (gesture) cancelGesture();
  }
  if (gesture) return;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  startGesture(e);
  if (gesture) gesture.pen = e.pointerType !== 'touch';
}
function onMove(e) {
  if (e.pointerType === 'pen' && (e.buttons & 1)) lastPenTime = performance.now();
  if (e.pointerType === 'touch' && pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, stagePt(e));
    if (nav && nav.kind === 'pinch') { pinchMove(); return; }
    if (nav && nav.kind === 'pan') { const p = stagePt(e); S.view.x = nav.vx + p[0] - nav.x; S.view.y = nav.vy + p[1] - nav.y; clampView(); requestRender(); return; }
  }
  if (!gesture || gesture.pointerId !== e.pointerId) return;
  let evs = [e];
  if (gesture.kind === 'stroke' && e.getCoalescedEvents) { const co = e.getCoalescedEvents(); if (co.length) evs = co; }
  for (const ev of evs) moveGesture(ev);
  if (gesture && gesture.kind === 'stroke') {   // predicted points: drawn live only, never stored
    gesture.predicted = e.getPredictedEvents ? e.getPredictedEvents().map(pe => { const q = evPage(pe); return [q[0], q[1], pressureOf(pe)]; }) : [];
  }
}
function onUp(e) {
  if (e.pointerType === 'pen') lastPenTime = performance.now();
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

const pressureOf = e => e.pointerType === 'pen' ? (e.pressure > 0 ? Math.max(0.2, e.pressure) : 0.5) : 0.5;

function startGesture(e) {
  const p = evPage(e), id = e.pointerId;
  switch (S.tool) {
    case 'pen': case 'highlighter':
      gesture = { kind: 'stroke', pointerId: id, el: { type: 'stroke', id: uid(), tool: S.tool, color: S.color,
        size: S.tool === 'pen' ? R.PEN_SIZES[S.size] : R.HL_SIZES[S.size], sim: e.pointerType !== 'pen', points: [[p[0], p[1], pressureOf(e)]] } };
      break;
    case 'eraser':
      gesture = { kind: 'erase', pointerId: id, removed: [] }; eraseAt(p); break;
    case 'rect': case 'ellipse': case 'line': case 'arrow': case 'triangle': case 'rtriangle': case 'diamond': case 'pentagon': case 'hexagon': case 'star': case 'rrect': {
      let p0 = p, T = null;
      if (S.snap) { T = snapTargets(new Set()); p0 = snapPoint(p, T, []); }
      gesture = { kind: 'shape', pointerId: id, start: p0, T, el: { type: 'shape', id: uid(), kind: S.tool, cx: p0[0], cy: p0[1], w: 0, h: 0, rot: 0,
        color: S.color, width: R.SHAPE_WIDTHS[S.size], fill: 'none' } };
      break;
    }
    case 'text': createText(p); break;
    case 'bucket': bucketFill(p); break;
    case 'select': selectDown(e, p); break;
  }
  requestRender();
}

/* ---------------- paint bucket ----------------
   Rasterise every barrier (pen ink, shape outlines, lines, photos) at FILL_SCALE px per point, widened by
   GAP_PT so small gaps close, flood-fill from the tapped pixel, grow the region back by GAP_PT so it tucks
   under the lines, and store it as a bitmap mask element placed underneath the ink. */
const FILL_SCALE = 3, GAP_PT = 4;
function drawBarrier(c, el, extra) {
  c.strokeStyle = '#000'; c.fillStyle = '#000'; c.lineCap = 'round'; c.lineJoin = 'round';
  switch (el.type) {
    case 'stroke':
      if (el.tool === 'highlighter') return;
      { const path = R.strokePath(el); c.fill(path); c.lineWidth = extra * 2; c.stroke(path); }
      return;
    case 'image':
      c.save(); c.translate(el.cx, el.cy); c.rotate(el.rot || 0); c.fillRect(-el.w / 2 - extra, -el.h / 2 - extra, el.w + 2 * extra, el.h + 2 * extra); c.restore();
      return;
    case 'shape':
      if (isLineEl(el)) {
        const pts = R.linePts(el);
        c.lineWidth = el.width + extra * 2; c.beginPath(); R.tracePath(c, R.curveSegments(pts)); c.stroke();
        if (el.kind === 'arrow') { const hs = R.arrowHead(el), tip = pts[pts.length - 1], [dx, dy] = R.endDirection(pts);
          c.beginPath(); c.moveTo(tip[0], tip[1]); c.lineTo(tip[0] - dx * hs - dy * hs * 0.45, tip[1] - dy * hs + dx * hs * 0.45); c.lineTo(tip[0] - dx * hs + dy * hs * 0.45, tip[1] - dy * hs - dx * hs * 0.45); c.closePath(); c.fill(); c.lineWidth = extra * 2; c.stroke(); }
        return;
      }
      c.save(); c.translate(el.cx, el.cy); c.rotate(el.rot || 0); c.lineWidth = el.width + extra * 2; c.beginPath();
      if (el.kind === 'rect') c.rect(-el.w / 2, -el.h / 2, el.w, el.h);
      else if (R.isPolyKind(el.kind)) R.tracePoly(c, R.polyPoints(el));
      else c.ellipse(0, 0, Math.max(0.1, el.w / 2), Math.max(0.1, el.h / 2), 0, 0, Math.PI * 2);
      c.stroke(); c.restore();
      return;
  }
}
async function bucketFill(p) {
  if (p[0] < 0 || p[1] < 0 || p[0] > R.PAGE_W || p[1] > R.PAGE_H) return;
  // tapping an existing fill recolours it
  for (const f of page().elements) if (f.type === 'fill') await R.imageReady(f.mask);
  const old = page().elements.slice().reverse().find(e => e.type === 'fill' && R.hitElement(e, p, 0));
  if (old) {
    if (old.color === S.color) return;
    const before = cloneEl(old); old.color = S.color; commit(opModify([before], [cloneEl(old)])); requestRender(); return;
  }
  toast('Filling…'); await new Promise(r => setTimeout(r, 30));
  const W = R.PAGE_W * FILL_SCALE, H = R.PAGE_H * FILL_SCALE;
  const sx = Math.min(W - 1, Math.floor(p[0] * FILL_SCALE)), sy = Math.min(H - 1, Math.floor(p[1] * FILL_SCALE));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d', { willReadFrequently: true });
  /* Try the lines at their true thickness first (reaches every corner exactly); only if the colour would
     leak through a gap, thicken the lines a little, then a little more, and grow the result back by the same amount. */
  let result = null;
  for (const extra of [0, 1.5, GAP_PT]) {
    c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); c.scale(FILL_SCALE, FILL_SCALE);
    for (const el of page().elements) drawBarrier(c, el, extra);
    const data = c.getImageData(0, 0, W, H).data;
    const open = i => data[i * 4] >= 128;
    if (!open(sy * W + sx)) { if (extra === 0) { toast('Tap inside an empty area to fill it.'); return; } continue; }
    const region = new Uint8Array(W * H), stack = [sy * W + sx]; region[sy * W + sx] = 1;
    let minx = sx, maxx = sx, miny = sy, maxy = sy, leaked = false;
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i - x) / W;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { leaked = true; break; }
      if (x > 0 && !region[i - 1] && open(i - 1)) { region[i - 1] = 1; stack.push(i - 1); }
      if (x < W - 1 && !region[i + 1] && open(i + 1)) { region[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !region[i - W] && open(i - W)) { region[i - W] = 1; stack.push(i - W); }
      if (y < H - 1 && !region[i + W] && open(i + W)) { region[i + W] = 1; stack.push(i + W); }
    }
    if (!leaked) { result = { region, minx, maxx, miny, maxy, extra }; break; }
  }
  if (!result) { toast('That area isn’t closed, so the colour would spill across the page. Close the gap (Snap helps) and try again.'); return; }
  // grow back by the thickening used, plus a hair so the fill tucks under the ink with no pale seam
  const r = Math.round(result.extra * FILL_SCALE) + 2;
  const bx0 = Math.max(0, result.minx - r), by0 = Math.max(0, result.miny - r), bx1 = Math.min(W - 1, result.maxx + r), by1 = Math.min(H - 1, result.maxy + r);
  let cur = result.region;
  for (let k = 0; k < r; k++) {
    const next = new Uint8Array(cur);
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const i = y * W + x; if (cur[i]) continue;
      if ((x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1]) || (y > 0 && cur[i - W]) || (y < H - 1 && cur[i + W])) next[i] = 1;
    }
    cur = next;
  }
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const out = document.createElement('canvas'); out.width = bw; out.height = bh;
  const oc = out.getContext('2d'), id = oc.createImageData(bw, bh), od = id.data;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (cur[(by0 + y) * W + bx0 + x]) { const o = (y * bw + x) * 4; od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255; }
  }
  oc.putImageData(id, 0, 0);
  const el = { type: 'fill', id: uid(), mask: out.toDataURL('image/png'), color: S.color,
    cx: (bx0 + bw / 2) / FILL_SCALE, cy: (by0 + bh / 2) / FILL_SCALE, w: bw / FILL_SCALE, h: bh / FILL_SCALE, rot: 0 };
  let idx = 0; while (idx < page().elements.length && page().elements[idx].type === 'fill') idx++;   // fills live under the ink
  page().elements.splice(idx, 0, el);
  commit(opAdd([el])); requestRender();
  toast('Filled.');
}

let lastTap = null;
function selectDown(e, p) {
  const f = selFrame();
  if (f) {
    let h = hitHandle(f, stagePt(e));
    if (h) {
      let before = null, moved = false;
      if (h.add) {   // insert a new bend at this spot and start dragging it
        const el = f.single; before = [cloneEl(el)];
        const pts = R.linePts(el).map(q => q.slice()); pts.splice(h.idx + 1, 0, [h.p[0], h.p[1]]); el.pts = pts; R.syncLine(el);
        h = { id: 'c' + (h.idx + 1), idx: h.idx + 1, p: h.p }; moved = true; lastHandleTap = null;
      } else if (h.id[0] === 'c') {   // double-tap a bend to remove it
        const now = performance.now();
        if (lastHandleTap && lastHandleTap.el === f.single && lastHandleTap.id === h.id && now - lastHandleTap.t < 450) { lastHandleTap = null; removeBend(f.single, h.idx); return; }
        lastHandleTap = { el: f.single, id: h.id, t: now };
      }
      gesture = { kind: 'handle', pointerId: e.pointerId, handle: h, f: selFrame(), start: p, els: S.sel.slice(), snap: S.sel.map(cloneEl), before, moved };
      return;
    }
  }
  const hit = hitTest(p);
  if (hit) {
    const now = performance.now();
    if (hit.type === 'text' && lastTap && lastTap.el === hit && now - lastTap.t < 450) { lastTap = null; setSel([hit]); startEdit(hit); return; }
    lastTap = { el: hit, t: now };
    if (S.sel.includes(hit)) {
      gesture = { kind: 'move', pointerId: e.pointerId, start: p, els: S.sel.slice(), snap: S.sel.map(cloneEl), moved: false };
    } else {
      setSel([hit]); gesture = { kind: 'tap', pointerId: e.pointerId };   // first tap only selects
    }
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
  const hs = handles(f);
  for (const h of hs) { if (h.add) continue; const q = toScreen(h.p); if (Math.hypot(q[0] - sp[0], q[1] - sp[1]) <= 18) return h; }
  for (const h of hs) { if (!h.add) continue; const q = toScreen(h.p); if (Math.hypot(q[0] - sp[0], q[1] - sp[1]) <= 14) return h; }
  return null;
}
let lastHandleTap = null;
function removeBend(el, idx) {
  const before = cloneEl(el);
  const pts = R.linePts(el).filter((_, i) => i !== idx); el.pts = pts; R.syncLine(el);
  commit(opModify([before], [cloneEl(el)])); requestRender();
}
function moveGesture(ev) {
  const g = gesture; let p = evPage(ev);
  switch (g.kind) {
    case 'stroke': {
      const pts = g.el.points, last = pts[pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.35) pts.push([p[0], p[1], pressureOf(ev)]);
      break;
    }
    case 'erase': eraseAt(p); break;
    case 'shape': {
      if (S.snap) { if (!g.T) g.T = snapTargets(new Set()); g.guides = []; p = isLineEl(g.el) ? snapLineEnd(g.start, p, g.T, g.guides) : snapPoint(p, g.T, g.guides); }
      const [sx, sy] = g.start, dx = p[0] - sx, dy = p[1] - sy, el = g.el;
      if (el.kind === 'line' || el.kind === 'arrow') { el.pts = [[sx, sy], [p[0], p[1]]]; R.syncLine(el); }
      else {
        let w = Math.abs(dx), h = Math.abs(dy);
        if (S.snap && w > 6 && h > 6 && !(g.guides || []).some(x => x.k === 'pt') && Math.abs(w - h) < Math.max(8 / S.view.s, 0.12 * Math.max(w, h))) {
          w = h = Math.max(w, h);   // lock to a perfect square / circle
          (g.guides || (g.guides = [])).push({ k: 'label', p: [sx + Math.sign(dx || 1) * w, sy + Math.sign(dy || 1) * h], text: el.kind === 'rect' || el.kind === 'rrect' ? 'square' : el.kind === 'ellipse' ? 'circle' : 'regular' });
        }
        el.cx = sx + Math.sign(dx || 1) * w / 2; el.cy = sy + Math.sign(dy || 1) * h / 2; el.w = w; el.h = h;
      }
      break;
    }
    case 'move': {
      let dx = p[0] - g.start[0], dy = p[1] - g.start[1];
      if (!g.moved && Math.hypot(dx, dy) * S.view.s < 3) return;
      g.moved = true;
      if (S.snap) {
        if (!g.T) g.T = snapTargets(new Set(g.els));
        const f = { pts: [], xs: [], ys: [] };
        for (const sn of g.snap) { const ff = featurePts(sn); ff.pts.forEach(q => f.pts.push([q[0] + dx, q[1] + dy])); ff.xs.forEach(x => f.xs.push(x + dx)); ff.ys.forEach(y => f.ys.push(y + dy)); }
        g.guides = []; const [ex, ey] = snapDelta(f, g.T, g.guides); dx += ex; dy += ey;
      }
      g.els.forEach((el, i) => translateEl(el, g.snap[i], dx, dy)); break;
    }
    case 'handle': {
      g.moved = true;
      if (S.snap && g.handle.id !== 'rot') {
        if (!g.T) g.T = snapTargets(new Set(g.els)); g.guides = [];
        const h = g.handle, sn = g.snap[0];
        if (g.els.length === 1 && isLineEl(g.els[0]) && (h.id === 'p0' || h.id === 'p1')) {
          const pts = R.linePts(sn), anchor = h.id === 'p0' ? pts[1] : pts[pts.length - 2];
          p = snapLineEnd(anchor, p, g.T, g.guides);
        } else p = snapPoint(p, g.T, g.guides);
      }
      applyHandle(p); break;
    }
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
      page().elements.push(el);
      const v = S.view, canAppend = !layerDirty && layerView && layerView.s === v.s && layerView.x === v.x && layerView.y === v.y && !S.sel.length && !S.editing;
      commit(opAdd([el]));
      if (canAppend) {   // paint just this stroke into the cached layer instead of rebuilding the page
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0); lctx.translate(v.x, v.y); lctx.scale(v.s, v.s);
        lctx.save(); lctx.beginPath(); lctx.rect(0, 0, R.PAGE_W, R.PAGE_H); lctx.clip(); R.drawElement(lctx, el, {}); lctx.restore();
        layerDirty = false;
      }
      break;
    }
    case 'erase':
      if (g.removed.length) commit(opRemove(g.removed));
      break;
    case 'shape': {
      const el = g.el;
      if (el.w < 4 && el.h < 4) { if (isLineEl(el)) { el.pts = [[g.start[0], g.start[1]], [g.start[0] + 140, g.start[1]]]; R.syncLine(el); } else { el.w = 140; el.h = 90; el.cx = g.start[0] + 70; el.cy = g.start[1] + 45; } }
      page().elements.push(el); setTool('select'); setSel([el]); commit(opAdd([el])); break;
    }
    case 'move': case 'handle':
      if (g.moved) commit(opModify(g.before || g.snap, g.els.map(cloneEl)));
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

/* ---------------- snapping ----------------
   Key points of an element: corners, edge midpoints, centre, line ends and bends, stroke ends.
   xs/ys are the vertical/horizontal edge lines used for edge-to-edge alignment. */
const SNAP_PX = 10;
function featurePts(el) {
  const f = { pts: [], xs: [], ys: [] };
  if (el.type === 'fill') return f;   // paint is not something to snap to
  if (el.type === 'stroke') {
    if (el.tool !== 'highlighter' && el.points.length) { const a = el.points[0], b = el.points[el.points.length - 1]; f.pts.push([a[0], a[1]], [b[0], b[1]]); }
    return f;
  }
  if (isLineEl(el)) {
    const lp = R.linePts(el);
    lp.forEach(q => f.pts.push([q[0], q[1]]));
    R.curveSegments(lp).forEach(b => f.pts.push(R.bezierPoint(b, 0.5)));
    f.xs.push(lp[0][0], lp[lp.length - 1][0]); f.ys.push(lp[0][1], lp[lp.length - 1][1]);
    return f;
  }
  const cs = R.corners(el);
  if (el.type === 'shape' && R.isPolyKind(el.kind)) {
    const vs = R.polyPoints(el).map(q => R.fromLocal(el, q));
    vs.forEach(v => f.pts.push(v)); f.pts.push([el.cx, el.cy]);
    if (el.kind !== 'rrect') for (let i = 0; i < vs.length; i++) { const a = vs[i], b = vs[(i + 1) % vs.length]; f.pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
  } else {
    if (!(el.type === 'shape' && el.kind === 'ellipse')) cs.forEach(c => f.pts.push(c));
    f.pts.push([el.cx, el.cy]);
    for (let i = 0; i < 4; i++) { const a = cs[i], b = cs[(i + 1) % 4]; f.pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
  }
  if (Math.abs(el.rot || 0) < 0.01) { f.xs.push(el.cx - el.w / 2, el.cx, el.cx + el.w / 2); f.ys.push(el.cy - el.h / 2, el.cy, el.cy + el.h / 2); }
  return f;
}
function snapTargets(exclude) {
  const T = { pts: [], xs: [0, R.PAGE_W / 2, R.PAGE_W], ys: [0, R.PAGE_H / 2, R.PAGE_H] };
  for (const el of page().elements) {
    if (exclude.has(el)) continue;
    const f = featurePts(el); T.pts.push(...f.pts); T.xs.push(...f.xs); T.ys.push(...f.ys);
  }
  return T;
}
/* snap one dragged point: a nearby key point wins, otherwise align x and y to edges separately */
function snapPoint(p, T, guides) {
  const th = SNAP_PX / S.view.s;
  let best = null, bd = th;
  for (const q of T.pts) { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } }
  if (best) { guides.push({ k: 'pt', p: best }); return [best[0], best[1]]; }
  let x = p[0], y = p[1], bx = th, by = th, gx = null, gy = null;
  for (const X of T.xs) { const d = Math.abs(X - p[0]); if (d < bx) { bx = d; x = X; gx = X; } }
  for (const Y of T.ys) { const d = Math.abs(Y - p[1]); if (d < by) { by = d; y = Y; gy = Y; } }
  if (gx !== null) guides.push({ k: 'x', x: gx }); if (gy !== null) guides.push({ k: 'y', y: gy });
  return [x, y];
}
/* snap the end of a line: a key point wins; otherwise the line's angle snaps to 0/30/45/60/90° families; otherwise edges */
const SNAP_ANGLES = []; for (let base = -180; base < 180; base += 90) for (const a of [0, 30, 45, 60]) SNAP_ANGLES.push(base + a);
function snapLineEnd(anchor, p, T, guides) {
  const th = SNAP_PX / S.view.s;
  let best = null, bd = th;
  for (const q of T.pts) { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } }
  if (best) { guides.push({ k: 'pt', p: best }); return [best[0], best[1]]; }
  const dx = p[0] - anchor[0], dy = p[1] - anchor[1], len = Math.hypot(dx, dy);
  if (len > 14 / S.view.s) {
    const deg = Math.atan2(dy, dx) * 180 / Math.PI;
    let bestA = null, ba = 4.5;
    for (const a of SNAP_ANGLES) { const diff = Math.abs(((deg - a + 540) % 360) - 180); if (diff < ba) { ba = diff; bestA = a; } }
    if (bestA !== null) {
      const r = bestA * Math.PI / 180, q = [anchor[0] + len * Math.cos(r), anchor[1] + len * Math.sin(r)];
      guides.push({ k: 'ang', a: anchor, b: q, deg: ((bestA % 180) + 180) % 180 });
      return q;
    }
  }
  return snapPoint(p, T, guides);
}
/* snap a moving group: returns the extra [dx, dy] to add */
function snapDelta(f, T, guides) {
  const th = SNAP_PX / S.view.s;
  let best = null, bd = th;
  for (const m of f.pts) for (const q of T.pts) { const d = Math.hypot(q[0] - m[0], q[1] - m[1]); if (d < bd) { bd = d; best = [q[0] - m[0], q[1] - m[1], q]; } }
  if (best) { guides.push({ k: 'pt', p: best[2] }); return [best[0], best[1]]; }
  let dx = 0, dy = 0, bx = th, by = th, gx = null, gy = null;
  for (const m of f.xs) for (const X of T.xs) { const d = Math.abs(X - m); if (d < bx) { bx = d; dx = X - m; gx = X; } }
  for (const m of f.ys) for (const Y of T.ys) { const d = Math.abs(Y - m); if (d < by) { by = d; dy = Y - m; gy = Y; } }
  if (gx !== null) guides.push({ k: 'x', x: gx }); if (gy !== null) guides.push({ k: 'y', y: gy });
  return [dx, dy];
}
function drawGuides() {
  const g = gesture; if (!g || !g.guides || !g.guides.length) return;
  const s = S.view.s;
  ctx.save(); ctx.strokeStyle = '#e11d48'; ctx.lineWidth = 1 / s;
  for (const gd of g.guides) {
    if (gd.k === 'pt') { ctx.setLineDash([]); ctx.lineWidth = 1.5 / s; ctx.beginPath(); ctx.arc(gd.p[0], gd.p[1], 6 / s, 0, Math.PI * 2); ctx.stroke(); continue; }
    if (gd.k === 'label') { ctx.setLineDash([]); ctx.fillStyle = '#e11d48'; ctx.font = `bold ${11 / s}px Helvetica, Arial, sans-serif`; ctx.textBaseline = 'bottom'; ctx.fillText(gd.text, gd.p[0] + 12 / s, gd.p[1] - 8 / s); continue; }
    if (gd.k === 'ang') {
      const dx = gd.b[0] - gd.a[0], dy = gd.b[1] - gd.a[1], len = Math.hypot(dx, dy) || 1, ex = dx / len * 40 / s, ey = dy / len * 40 / s;
      ctx.setLineDash([4 / s, 3 / s]); ctx.lineWidth = 1 / s; ctx.beginPath(); ctx.moveTo(gd.a[0] - ex, gd.a[1] - ey); ctx.lineTo(gd.b[0] + ex, gd.b[1] + ey); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = '#e11d48'; ctx.font = `${11 / s}px Helvetica, Arial, sans-serif`; ctx.textBaseline = 'bottom';
      ctx.fillText(`${gd.deg}°`, gd.b[0] + 10 / s, gd.b[1] - 6 / s);
      continue;
    }
    ctx.setLineDash([4 / s, 3 / s]); ctx.lineWidth = 1 / s; ctx.beginPath();
    if (gd.k === 'x') { ctx.moveTo(gd.x, 0); ctx.lineTo(gd.x, R.PAGE_H); } else { ctx.moveTo(0, gd.y); ctx.lineTo(R.PAGE_W, gd.y); }
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------------- transforms ---------------- */
function translateEl(el, s, dx, dy) {
  if (el.type === 'stroke') el.points = s.points.map(p => [p[0] + dx, p[1] + dy, p[2]]);
  else if (s.pts) { el.pts = s.pts.map(q => [q[0] + dx, q[1] + dy]); R.syncLine(el); }
  else { el.cx = s.cx + dx; el.cy = s.cy + dy; }
}
function scaleEl(el, s, ax, ay, k) {
  if (el.type === 'stroke') { el.points = s.points.map(p => [ax + (p[0] - ax) * k, ay + (p[1] - ay) * k, p[2]]); el.size = s.size * k; return; }
  if (s.pts) { el.pts = s.pts.map(q => [ax + (q[0] - ax) * k, ay + (q[1] - ay) * k]); el.width = s.width * k; R.syncLine(el); return; }
  el.cx = ax + (s.cx - ax) * k; el.cy = ay + (s.cy - ay) * k; el.w = s.w * k; el.h = s.h * k;
  if (el.type === 'shape') el.width = s.width * k;
  if (el.type === 'text') { el.doc = R.textDoc(s); scaleTextSizes(el, k); }
}
function rotateEl(el, s, cx, cy, da) {
  const c = Math.cos(da), sn = Math.sin(da);
  const rp = (x, y) => [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c];
  if (el.type === 'stroke') { el.points = s.points.map(p => { const q = rp(p[0], p[1]); return [q[0], q[1], p[2]]; }); return; }
  if (s.pts) { el.pts = s.pts.map(q => rp(q[0], q[1])); R.syncLine(el); return; }
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
  if (h.id === 'p0' || h.id === 'p1' || h.id[0] === 'c') {
    const el = g.els[0], sn = g.snap[0];
    const pts = R.linePts(sn).map(q => q.slice()); pts[h.idx] = [p[0], p[1]]; el.pts = pts; R.syncLine(el);
    return;
  }
  const sign = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] }[h.id];
  const anchorL = [-sign[0] * f.w / 2, -sign[1] * f.h / 2];
  if (f.single) {
    const el = g.els[0], s = g.snap[0], local = R.toLocal(f, p);
    let nw = Math.max(8, (local[0] - anchorL[0]) * sign[0]), nh = Math.max(8, (local[1] - anchorL[1]) * sign[1]);
    if (el.type === 'image') { const k = Math.max(nw / s.w, nh / s.h); nw = s.w * k; nh = s.h * k; }
    if (el.type === 'text' || el.type === 'link') nh = s.h;
    if (S.snap && el.type === 'shape' && R.isAreaKind(el.kind) && Math.abs(nw - nh) < Math.max(8 / S.view.s, 0.12 * Math.max(nw, nh))) {
      nw = nh = Math.max(nw, nh);
      (g.guides || (g.guides = [])).push({ k: 'label', p: p, text: el.kind === 'rect' || el.kind === 'rrect' ? 'square' : el.kind === 'ellipse' ? 'circle' : 'regular' });
    }
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
  if (S.editing) { buildFormatBar(); return; }
  if (!S.sel.length) { selBar.hidden = true; return; }
  const sel = S.sel, hasShape = sel.some(e => e.type === 'shape' && R.isAreaKind(e.kind));
  const colorable = sel.some(e => e.type !== 'image' && e.type !== 'link');
  const add = (label, fn, cls) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; selBar.appendChild(b); return b; };
  const sep = () => { const s = document.createElement('span'); s.className = 'sep'; selBar.appendChild(s); };
  if (colorable) {
    for (const c of COLORS) { const b = add('', () => mutateSel(e => setElColor(e, c)), 'sw'); b.style.background = c; b.title = 'Color'; }
    sep();
  }
  if (hasShape) {
    for (const c of FILLS) { const b = add('', () => mutateSel(e => { if (e.type === 'shape') e.fill = c; }), 'sw' + (c === 'none' ? ' none' : '')); if (c !== 'none') b.style.background = c; b.title = c === 'none' ? 'No fill' : 'Fill'; }
    sep();
  }
  if (sel.some(e => e.type !== 'image' && e.type !== 'link' && e.type !== 'fill')) {
    add('−', () => resizeSel(0.8), ''); add('+', () => resizeSel(1.25), ''); sep();
  }
  if (sel.length === 1 && sel[0].type === 'text') add('Edit', () => startEdit(sel[0]));
  if (sel.length === 1 && isLineEl(sel[0]) && R.linePts(sel[0]).length > 2) add('Straighten', () => mutateSel(e => { const q = R.linePts(e); e.pts = [q[0], q[q.length - 1]]; R.syncLine(e); }));
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
function setElColor(e, c) {
  if (e.type === 'image' || e.type === 'link') return;
  e.color = c;
  if (e.type === 'text') { e.doc = R.textDoc(e).map(p => ({ ...p, spans: p.spans.map(sp => ({ ...sp, color: c })) })); R.layoutText(e); }
}
function scaleTextSizes(e, k) {
  e.doc = R.textDoc(e).map(p => ({ ...p, spans: p.spans.map(sp => ({ ...sp, size: clamp(Math.round(sp.size * k * 2) / 2, 6, 160) })) }));
  e.size = e.doc[0] && e.doc[0].spans[0] ? e.doc[0].spans[0].size : e.size; R.layoutText(e);
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
    else if (e.type === 'text') scaleTextSizes(e, k);
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

/* ---------------- text editing (rich text, in place) ---------------- */
const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function spanStyle(sp) {
  return `font-size:${sp.size}px;font-family:'${sp.font || 'Helvetica'}',Helvetica,Arial,sans-serif;color:${sp.color || '#111827'};` +
    (sp.b ? 'font-weight:bold;' : 'font-weight:normal;') + (sp.i ? 'font-style:italic;' : '') + (sp.u ? 'text-decoration:underline;' : '');
}
function docToHTML(doc) {
  return doc.map(p => {
    const inner = p.spans.map(sp => sp.t ? `<span style="${spanStyle(sp)}">${esc(sp.t)}</span>` : '').join('');
    return `<div style="text-align:${p.align || 'left'}">${inner || '<br>'}</div>`;
  }).join('');
}
const rgbToHex = c => { const m = String(c).match(/\d+(\.\d+)?/g); if (!m || m.length < 3) return c && c[0] === '#' ? c : '#111827'; return '#' + m.slice(0, 3).map(v => Math.round(+v).toString(16).padStart(2, '0')).join(''); };
function styleOf(node, fallback) {
  const cs = getComputedStyle(node);
  const fam = (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim() || 'Helvetica';
  return { size: Math.round(parseFloat(cs.fontSize) * 2) / 2 || fallback.size, font: R.FONTS.includes(fam) ? fam : fallback.font || 'Helvetica',
    color: rgbToHex(cs.color), b: cs.fontWeight === 'bold' || parseInt(cs.fontWeight, 10) >= 600, i: cs.fontStyle === 'italic', u: (cs.textDecorationLine || cs.textDecoration || '').includes('underline') };
}
/* read the editor's DOM back into paragraphs of spans */
function docFromEditor(fallback) {
  const paras = []; let cur = null;
  const open = node => { const al = node && node.nodeType === 1 ? getComputedStyle(node).textAlign : 'left'; cur = { align: ['center', 'right'].includes(al) ? al : 'left', spans: [] }; paras.push(cur); };
  const pushText = (text, node) => {
    if (!cur) open(null);
    const st = styleOf(node, fallback), last = cur.spans[cur.spans.length - 1];
    if (last && last.size === st.size && last.font === st.font && last.color === st.color && !!last.b === st.b && !!last.i === st.i && !!last.u === st.u) last.t += text;
    else cur.spans.push({ t: text, ...st });
  };
  const walk = (node, inBlock) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) { if (ch.nodeValue) pushText(ch.nodeValue.replace(/ /g, ' '), ch.parentElement); continue; }
      if (ch.nodeType !== 1) continue;
      const tag = ch.tagName;
      if (tag === 'BR') { if (!cur) open(null); cur = null; continue; }
      const block = ['DIV', 'P', 'LI', 'H1', 'H2', 'H3'].includes(tag);
      if (block) { open(ch); walk(ch, true); cur = null; }
      else walk(ch, inBlock);
    }
  };
  walk(ta, false);
  if (!paras.length) paras.push({ align: 'left', spans: [] });
  for (const p of paras) if (!p.spans.length) p.spans.push({ t: '', ...fallback });
  return paras;
}
let savedRange = null;
document.addEventListener('selectionchange', () => {
  if (!S.editing) return;
  const sel = document.getSelection();
  if (sel && sel.rangeCount && ta.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
});
function restoreRange() {
  ta.focus();
  if (savedRange) { const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); }
}
function exec(cmd, val) {
  restoreRange();
  try { document.execCommand('styleWithCSS', false, true); } catch {}
  document.execCommand(cmd, false, val);
  ta.dispatchEvent(new Event('input'));
}
function applyFontSize(px) {
  exec('fontSize', '7');
  ta.querySelectorAll('font[size="7"], span[style*="xxx-large"]').forEach(n => { n.removeAttribute('size'); n.style.fontSize = px + 'px'; });
  ta.dispatchEvent(new Event('input'));
}
function currentStyle() {
  const sel = document.getSelection(); let node = sel && sel.anchorNode; if (!node) return null;
  if (node.nodeType === 3) node = node.parentElement;
  if (!ta.contains(node) || node === ta) return null;
  return styleOf(node, { size: S.editing.size, font: 'Helvetica' });
}
function buildFormatBar() {
  selBar.innerHTML = '';
  const st = currentStyle() || (R.textDoc(S.editing)[0].spans[0]) || { size: 16, font: 'Helvetica' };
  const mk = (tag, cls) => { const x = document.createElement(tag); if (cls) x.className = cls; selBar.appendChild(x); return x; };
  const font = mk('select'); for (const f of R.FONTS) { const o = document.createElement('option'); o.value = f; o.textContent = f; o.style.fontFamily = f; if (f === st.font) o.selected = true; font.appendChild(o); }
  font.onchange = () => { exec('fontName', font.value); };
  const size = mk('select'); for (const n of [9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 64]) { const o = document.createElement('option'); o.value = n; o.textContent = n; if (n === Math.round(st.size)) o.selected = true; size.appendChild(o); }
  size.onchange = () => applyFontSize(+size.value);
  const btn = (label, cls, fn, on) => { const b = mk('button', 'fmt ' + cls + (on ? ' on' : '')); b.textContent = label; b.onclick = fn; return b; };
  btn('B', '', () => exec('bold'), st.b); btn('I', '', () => exec('italic'), st.i).style.fontStyle = 'italic'; btn('U', '', () => exec('underline'), st.u).style.textDecoration = 'underline';
  mk('span', 'sep');
  for (const c of COLORS) { const b = mk('button', 'sw'); b.style.background = c; b.title = 'Colour'; b.onclick = () => exec('foreColor', c); }
  mk('span', 'sep');
  btn('⇤', '', () => exec('justifyLeft')); btn('↔', '', () => exec('justifyCenter')); btn('⇥', '', () => exec('justifyRight'));
  mk('span', 'sep');
  const done = mk('button'); done.textContent = 'Done'; done.onclick = () => finishEdit();
  selBar.hidden = false; positionSelBar();
}
selBar.addEventListener('pointerdown', e => { if (S.editing && e.target.tagName !== 'SELECT') e.preventDefault(); });   // keep the text selection alive

function createText(p) {
  const el = { type: 'text', id: uid(), cx: p[0] + 100, cy: p[1], w: 200, h: 30, rot: 0, text: '', size: R.TEXT_SIZES[S.size], color: S.color,
    doc: [{ align: 'left', spans: [{ t: '', size: R.TEXT_SIZES[S.size], color: S.color, font: 'Helvetica' }] }] };
  R.layoutText(el); el.cy = p[1] + el.h / 2;
  page().elements.push(el); setTool('select'); setSel([el]); startEdit(el, true);
}
function startEdit(el, isNew) {
  S.editing = el; S.editBefore = cloneEl(el); S.editIsNew = !!isNew; layerDirty = true;
  const doc = R.textDoc(el); el.doc = doc;
  ta.hidden = false; ta.innerHTML = docToHTML(doc); positionTA(); requestRender();
  // focus synchronously: iPadOS only shows the keyboard when focus happens inside the tap handler
  ta.focus();
  try { const r = document.createRange(); r.selectNodeContents(ta); r.collapse(false); const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r); savedRange = r.cloneRange(); } catch {}
  updateSelBar();
}
function positionTA() {
  const el = S.editing, s = S.view.s, [sx, sy] = toScreen([el.cx, el.cy]);
  const base = (R.textDoc(el)[0].spans[0]) || { size: el.size, color: el.color };
  ta.style.left = sx + 'px'; ta.style.top = sy + 'px'; ta.style.width = el.w + 'px'; ta.style.minHeight = el.h + 'px';
  ta.style.fontSize = base.size + 'px'; ta.style.padding = R.TEXT_PAD + 'px'; ta.style.color = base.color || el.color;
  ta.style.fontFamily = `"${base.font || 'Helvetica'}", Helvetica, Arial, sans-serif`;
  ta.style.transform = `translate(-50%,-50%) rotate(${el.rot || 0}rad) scale(${s})`;
}
ta.addEventListener('input', () => {
  const el = S.editing; if (!el) return;
  const base = R.textDoc(el)[0].spans[0] || { size: el.size, color: el.color, font: 'Helvetica' };
  const h0 = el.h;
  el.doc = docFromEditor({ size: base.size, color: base.color, font: base.font }); R.layoutText(el);
  if (el.h !== h0) { const dh = el.h - h0, rot = el.rot || 0; el.cx += -Math.sin(rot) * dh / 2; el.cy += Math.cos(rot) * dh / 2; }   // top edge stays put
  positionTA(); requestRender(); if (!selBar.hidden) positionSelBar();
});
ta.addEventListener('blur', () => setTimeout(() => { if (S.editing && document.activeElement !== ta && !selBar.contains(document.activeElement)) finishEdit(); }, 60));
ta.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); finishEdit(); } });
function finishEdit() {
  const el = S.editing; if (!el) return;
  const base = R.textDoc(el)[0].spans[0] || { size: el.size, color: el.color, font: 'Helvetica' };
  el.doc = docFromEditor({ size: base.size, color: base.color, font: base.font }); R.layoutText(el);
  el.size = base.size; el.color = base.color;
  S.editing = null; ta.hidden = true; ta.innerHTML = ''; layerDirty = true; savedRange = null;
  const before = S.editBefore, isNew = S.editIsNew; S.editBefore = null; S.editIsNew = false;
  if (!page().elements.includes(el)) { updateSelBar(); requestRender(); return; }
  if (!el.text.trim()) { removeEls([el]); setSel([]); saveSoon(); }
  else if (isNew) commit(opAdd([el]));
  else if (JSON.stringify(el.doc) !== JSON.stringify(R.textDoc(before))) commit(opModify([before], [cloneEl(el)]));
  updateSelBar(); requestRender();
}
ta.addEventListener('paste', e => {   // paste as plain text so outside formatting does not sneak in
  e.preventDefault(); const t = (e.clipboardData || window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, t);
});

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
/* "More" shapes: a small menu; the chosen shape becomes the More button's face */
const MORE_SHAPES = { rtriangle: 'Right tri.', diamond: 'Diamond', pentagon: 'Pentagon', hexagon: 'Hexagon', star: 'Star', rrect: 'Rounded' };
let moreShape = localStorage.getItem('moreShape') in MORE_SHAPES ? localStorage.getItem('moreShape') : 'diamond';
const btnMore = $('#btnMoreShapes'), shapeMenu = $('#shapeMenu');
function setMoreShape(k) {
  moreShape = k; localStorage.setItem('moreShape', k);
  btnMore.dataset.tool = k; btnMore.querySelector('span').textContent = MORE_SHAPES[k];
  btnMore.querySelector('svg').innerHTML = $(`#shapeMenu button[data-kind="${k}"] svg`).innerHTML;
}
btnMore.onclick = () => {
  if (S.tool === moreShape && shapeMenu.hidden) { shapeMenu.hidden = false; return; }   // second tap opens the menu
  if (!shapeMenu.hidden) { shapeMenu.hidden = true; return; }
  setTool(moreShape);
};
btnMore.addEventListener('contextmenu', e => { e.preventDefault(); shapeMenu.hidden = false; });
$$('#shapeMenu button').forEach(b => b.onclick = () => { setMoreShape(b.dataset.kind); shapeMenu.hidden = true; setTool(moreShape); });
document.addEventListener('pointerdown', e => { if (!shapeMenu.hidden && !shapeMenu.contains(e.target) && e.target !== btnMore && !btnMore.contains(e.target)) shapeMenu.hidden = true; });
setMoreShape(moreShape);

const colorsEl = $('#colors');
for (const c of COLORS) { const b = document.createElement('button'); b.style.background = c; b.dataset.color = c; b.onclick = () => setColor(c); colorsEl.appendChild(b); }
$('#colorPick').oninput = e => setColor(e.target.value, true);
function setColor(c, custom) {
  S.color = c;
  $$('#colors button').forEach(b => b.classList.toggle('on', !custom && b.dataset.color === c));
  $('.custom').classList.toggle('on', !!custom);
  if (S.tool === 'select' && S.sel.length) mutateSel(e => setElColor(e, c));
}
$$('#sizes button').forEach(b => b.onclick = () => setSize(b.dataset.size));
function setSize(s) { S.size = s; $$('#sizes button').forEach(b => b.classList.toggle('on', b.dataset.size === s)); }

function setPencilOnly(v) { S.pencilOnly = v; localStorage.setItem('pencilOnly', v ? '1' : '0'); $('#btnPencilOnly').classList.toggle('on', v); }
/* toolbar docking: drag the grip toward an edge */
const DOCKS = ['bottom', 'top', 'left', 'right'];
function setDock(d) {
  if (!DOCKS.includes(d)) d = 'bottom';
  S.dock = d; localStorage.setItem('dock', d);
  document.body.classList.remove(...DOCKS.map(x => 'dock-' + x)); document.body.classList.add('dock-' + d);
  requestRender();
}
$('#toolGrip').addEventListener('pointerdown', e => {
  e.preventDefault();
  const grip = e.target, hint = $('#dockHint'), body = $('#body');
  let target = S.dock, moved = false;
  try { grip.setPointerCapture(e.pointerId); } catch {}
  const edgeFor = ev => {
    const r = body.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    const d = { left: x, right: r.width - x, top: y, bottom: r.height - y };
    return Object.keys(d).sort((a, b) => d[a] - d[b])[0];
  };
  const move = ev => {
    if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 8) moved = true;
    if (!moved) return;
    target = edgeFor(ev);
    const r = body.getBoundingClientRect(), t = 110;
    hint.hidden = false;
    Object.assign(hint.style, target === 'top' ? { left: '0', top: '0', width: r.width + 'px', height: t + 'px' } :
      target === 'bottom' ? { left: '0', top: (r.height - t) + 'px', width: r.width + 'px', height: t + 'px' } :
      target === 'left' ? { left: '0', top: '0', width: t + 'px', height: r.height + 'px' } : { left: (r.width - t) + 'px', top: '0', width: t + 'px', height: r.height + 'px' });
  };
  const up = () => {
    grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
    hint.hidden = true;
    if (moved && target !== S.dock) { setDock(target); toast(`Toolbar moved to the ${target}.`); }
  };
  grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
});
function setSnap(v) { S.snap = v; localStorage.setItem('snap', v ? '1' : '0'); $('#btnSnap').classList.toggle('on', v); }
$('#btnSnap').onclick = () => { setSnap(!S.snap); toast(S.snap ? 'Snapping on: ends and edges line up with nearby shapes.' : 'Snapping off.'); };
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
$('#btnPageNo').onclick = () => { $('#pageStrip').hidden = !$('#pageStrip').hidden; if (!$('#pageStrip').hidden) renderThumbs(); };
$('#btnStripClose').onclick = () => { $('#pageStrip').hidden = true; };
function renderThumbs() {
  const box = $('#thumbs'); box.innerHTML = '';
  const n = S.nb.pages.length;
  S.nb.pages.forEach((pg, i) => {
    const b = document.createElement('div'); b.className = 'thumb' + (i === S.pi ? ' cur' : ''); b.dataset.i = i;
    const cv = document.createElement('canvas'); const w = 130, sc = w / R.PAGE_W; cv.width = w * 2; cv.height = Math.round(R.PAGE_H * sc) * 2;
    const c = cv.getContext('2d'); c.scale(sc * 2, sc * 2); R.renderPage(c, pg, { onImage: () => {} });
    const lbl = document.createElement('div'); lbl.className = 'n'; lbl.textContent = `Page ${i + 1}`;
    const acts = document.createElement('div'); acts.className = 'acts';
    const act = (txt, title, fn, dis) => { const x = document.createElement('button'); x.textContent = txt; x.title = title; x.disabled = !!dis; x.onclick = ev => { ev.stopPropagation(); fn(); }; acts.appendChild(x); };
    act('▲', 'Move page up', () => movePage(i, i - 1), i === 0);
    act('▼', 'Move page down', () => movePage(i, i + 1), i === n - 1);
    act('⧉', 'Duplicate page', () => duplicatePage(i));
    act('→', 'Copy page to another notebook', () => copyPageDialog(i));
    act('🗑', 'Delete page', () => deletePageAt(i), n <= 1);
    b.append(cv, lbl, acts);
    attachThumbDrag(b, i, cv);
    box.appendChild(b);
  });
  const add = document.createElement('button'); add.className = 'thumb add'; add.textContent = '+ Add page'; add.onclick = addPage; box.appendChild(add);
  const cur = box.querySelector('.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
}
function clonePage(pg) { return { id: uid(), template: pg.template, elements: pg.elements.map(e => { const c = cloneEl(e); c.id = uid(); return c; }) }; }
function movePage(from, to) {
  const pages = S.nb.pages; if (to < 0 || to >= pages.length || from === to) return;
  const [pg] = pages.splice(from, 1); pages.splice(to, 0, pg);
  S.thumbDirty = true; goPage(to); renderThumbs(); saveSoon();
}
function duplicatePage(i) {
  S.nb.pages.splice(i + 1, 0, clonePage(S.nb.pages[i]));
  S.thumbDirty = true; goPage(i + 1); renderThumbs(); saveSoon(); toast(`Page ${i + 1} duplicated`);
}
function deletePageAt(i) {
  if (S.nb.pages.length <= 1) { toast('A notebook needs at least one page.'); return; }
  if (!confirm(`Delete page ${i + 1}? This cannot be undone.`)) return;
  const np = i < S.pi ? S.pi - 1 : S.pi;
  S.nb.pages.splice(i, 1); S.thumbDirty = true; goPage(Math.min(np, S.nb.pages.length - 1)); renderThumbs(); saveSoon();
}
async function copyPageDialog(i) {
  const metas = (await DB.all('meta')).filter(m => m.id !== S.nb.id).sort((a, b) => b.updated - a.updated);
  const list = $('#copyList'); list.innerHTML = '';
  if (!metas.length) { list.innerHTML = '<p class="hint">You have no other notebooks yet. Create one from the home screen first.</p>'; }
  for (const m of metas) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'menuitem'; b.textContent = `${m.name}  (${m.pages} page${m.pages === 1 ? '' : 's'})`;
    b.onclick = async () => {
      $('#dlgCopy').close('done');
      try {
        const target = await DB.get('notebooks', m.id); if (!target) throw new Error('notebook not found');
        target.pages.push(clonePage(S.nb.pages[i])); target.updated = Date.now();
        await DB.put('notebooks', target);
        await DB.put('meta', { ...m, pages: target.pages.length, updated: target.updated });
        toast(`Page ${i + 1} copied to “${m.name}” as its page ${target.pages.length}`);
      } catch (e) { console.error(e); toast('Could not copy the page.'); }
    };
    list.appendChild(b);
  }
  $('#dlgCopy').showModal();
}
/* drag a thumbnail to reorder: hold still for a moment, then drag (so the list can still scroll) */
let thumbDrag = null;
$('#thumbs').addEventListener('touchmove', e => { if (thumbDrag && thumbDrag.active) e.preventDefault(); }, { passive: false });
function attachThumbDrag(el, i, cv) {
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('.acts')) return;
    const box = $('#thumbs'), y0 = e.clientY, x0 = e.clientX;
    thumbDrag = { active: false, target: i, timer: null };
    const d = thumbDrag;
    d.timer = setTimeout(() => { d.active = true; el.classList.add('dragging'); try { el.setPointerCapture(e.pointerId); } catch {} }, 320);
    const thumbsAt = () => [...box.querySelectorAll('.thumb[data-i]')];
    const move = ev => {
      if (!d.active) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) { clearTimeout(d.timer); cleanup(); } return; }
      ev.preventDefault();
      let insertBefore = S.nb.pages.length;
      for (const t of thumbsAt()) { const r = t.getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { insertBefore = +t.dataset.i; break; } }
      d.target = insertBefore;
      thumbsAt().forEach(t => t.classList.toggle('drop-before', +t.dataset.i === insertBefore));
      box.classList.toggle('drop-end', insertBefore === S.nb.pages.length);
      const br = box.getBoundingClientRect();
      if (ev.clientY < br.top + 40) box.scrollTop -= 10; else if (ev.clientY > br.bottom - 40) box.scrollTop += 10;
    };
    const up = ev => {
      clearTimeout(d.timer);
      const wasActive = d.active; cleanup();
      if (!wasActive) { if (ev.type === 'pointerup' && Math.hypot(ev.clientX - x0, ev.clientY - y0) <= 8) { goPage(i); renderThumbs(); } return; }
      let to = d.target > i ? d.target - 1 : d.target;
      to = clamp(to, 0, S.nb.pages.length - 1);
      if (to !== i) movePage(i, to); else renderThumbs();
    };
    function cleanup() {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      el.classList.remove('dragging'); thumbsAt().forEach(t => t.classList.remove('drop-before')); box.classList.remove('drop-end');
      thumbDrag = null;
    }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
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
    case 'deletepage': deletePageAt(S.pi); break;
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
S.appVersion = 'notebook-v13';
(async function boot() {
  setTool('pen'); setColor(COLORS[0]); setSize('m'); setPencilOnly(S.pencilOnly); setSnap(S.snap); setDock(localStorage.getItem('dock') || 'bottom');
  try { await DB.open(); } catch (e) { alert('This browser cannot store notebooks (private mode?). ' + e.message); }
  await showHome();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
