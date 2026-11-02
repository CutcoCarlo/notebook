/* render.js — shared drawing code used by the editor (canvas), thumbnails and PDF export.
   All geometry is in "page points": a page is US Letter, 612 x 792 pt, origin top-left. */
import { getStroke } from './perfect-freehand.mjs';

export const PAGE_W = 612, PAGE_H = 792;
export const FONT = 'Helvetica, Arial, sans-serif';

export const TEMPLATES = {
  blank:       { name: 'Blank' },
  ruled:       { name: 'College ruled' },
  composition: { name: 'Composition (wide ruled)' },
  grid:        { name: 'Grid' },
  dots:        { name: 'Dot grid' },
};

export const PEN_SIZES = { s: 1.8, m: 3.2, l: 6 };
export const HL_SIZES  = { s: 10,  m: 16,  l: 26 };
export const SHAPE_WIDTHS = { s: 1.5, m: 2.5, l: 4.5 };
export const TEXT_SIZES = { s: 12, m: 16, l: 24 };

/* ---------- paper templates ---------- */
export function templateMarks(t) {
  const m = [];
  const line = (x1, y1, x2, y2, color, width) => m.push({ k: 'line', x1, y1, x2, y2, color, width });
  if (t === 'ruled' || t === 'composition') {
    const gap = t === 'ruled' ? 20.25 : 24.75;           // 9/32" college, 11/32" wide
    const color = t === 'ruled' ? '#a9c9e8' : '#8fb0d6';
    for (let y = 90; y <= PAGE_H - 36; y += gap) line(0, y, PAGE_W, y, color, 0.75);
    line(90, 0, 90, PAGE_H, '#f09a95', 1);                 // red margin
  } else if (t === 'grid') {
    for (let x = 18; x < PAGE_W; x += 18) line(x, 0, x, PAGE_H, '#c5dcf1', 0.5);
    for (let y = 18; y < PAGE_H; y += 18) line(0, y, PAGE_W, y, '#c5dcf1', 0.5);
  } else if (t === 'dots') {
    for (let x = 18; x < PAGE_W; x += 18) for (let y = 18; y < PAGE_H; y += 18) m.push({ k: 'dot', x, y, r: 1.1, color: '#a3b6ca' });
  }
  return m;
}

export function drawMarks(ctx, marks) {
  for (const k of marks) {
    if (k.k === 'line') { ctx.strokeStyle = k.color; ctx.lineWidth = k.width; ctx.beginPath(); ctx.moveTo(k.x1, k.y1); ctx.lineTo(k.x2, k.y2); ctx.stroke(); }
    else { ctx.fillStyle = k.color; ctx.beginPath(); ctx.arc(k.x, k.y, k.r, 0, Math.PI * 2); ctx.fill(); }
  }
}

/* ---------- ink ---------- */
export function strokeOpts(el, live) {
  if (el.tool === 'highlighter') return { size: el.size, thinning: 0, smoothing: 0.6, streamline: 0.4, simulatePressure: false, last: !live, start: { cap: true }, end: { cap: true } };
  return { size: el.size, thinning: 0.5, smoothing: 0.5, streamline: 0.4, simulatePressure: !!el.sim, last: !live };
}

/* Outline polygon -> path commands (quadratic curves through midpoints, like the perfect-freehand docs). */
function outlineToCmds(pts) {
  if (pts.length < 2) return [];
  const cmds = [{ op: 'm', c: [pts[0][0], pts[0][1]] }];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    cmds.push({ op: 'q', c: [a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  cmds.push({ op: 'h' });
  return cmds;
}
export function strokeCommands(el, live = false) {
  return outlineToCmds(getStroke(el.points, strokeOpts(el, live)));
}
export function cmdsToPath2D(cmds) {
  const p = new Path2D();
  for (const c of cmds) {
    if (c.op === 'm') p.moveTo(c.c[0], c.c[1]);
    else if (c.op === 'l') p.lineTo(c.c[0], c.c[1]);
    else if (c.op === 'q') p.quadraticCurveTo(c.c[0], c.c[1], c.c[2], c.c[3]);
    else p.closePath();
  }
  return p;
}
const pathCache = new WeakMap();   // keyed by el.points array; replaced arrays miss automatically
export function strokePath(el) {
  let p = pathCache.get(el.points);
  if (!p) { p = cmdsToPath2D(strokeCommands(el)); pathCache.set(el.points, p); }
  return p;
}

/* ---------- rich text layout ----------
   A text element holds `doc`: paragraphs [{ align, spans: [{ t, b, i, u, size, font, color }] }].
   Older elements only have `text`; textDoc() upgrades them on the fly. */
const mctx = document.createElement('canvas').getContext('2d');
export const TEXT_PAD = 4;
export const FONTS = ['Helvetica', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Palatino',
  'Avenir Next', 'Futura', 'Gill Sans', 'American Typewriter', 'Marker Felt', 'Noteworthy', 'Chalkboard SE', 'Bradley Hand', 'Snell Roundhand'];
export function fontString(st) { return `${st.i ? 'italic ' : ''}${st.b ? 'bold ' : ''}${st.size}px "${st.font || 'Helvetica'}", Helvetica, Arial, sans-serif`; }
export function textDoc(el) {
  if (el.doc && el.doc.length) return el.doc;
  return String(el.text || '').split('\n').map(line => ({ align: 'left', spans: [{ t: line, size: el.size || 16, color: el.color || '#111827', font: 'Helvetica' }] }));
}
export function docText(doc) { return doc.map(p => p.spans.map(sp => sp.t).join('')).join('\n'); }
const metricCache = new Map();
function metrics(st) {
  const key = fontString(st); let m = metricCache.get(key);
  if (!m) {
    mctx.font = key; const t = mctx.measureText('Hgjp');
    m = { asc: t.actualBoundingBoxAscent || st.size * 0.8, desc: t.actualBoundingBoxDescent || st.size * 0.22 };
    if (metricCache.size > 200) metricCache.clear(); metricCache.set(key, m);
  }
  return m;
}
export function layoutText(el) {
  const doc = textDoc(el), maxW = Math.max(10, el.w - TEXT_PAD * 2), lines = [];
  for (const para of doc) {
    const base = para.spans[0] || { size: el.size || 16, color: el.color, font: 'Helvetica' };
    const tokens = [];
    for (const sp of para.spans) for (const m of (sp.t.match(/\S+\s*|\s+/g) || [])) tokens.push({ text: m, st: sp });
    let line = { tokens: [], w: 0, wTrim: 0, align: para.align || 'left', base };
    const flush = () => { lines.push(line); line = { tokens: [], w: 0, wTrim: 0, align: para.align || 'left', base }; };
    for (const tk of tokens) {
      mctx.font = fontString(tk.st);
      const trimmed = tk.text.replace(/\s+$/, ''), w = mctx.measureText(tk.text).width, wTrim = mctx.measureText(trimmed).width;
      if (line.tokens.length && line.w + wTrim > maxW) flush();
      if (wTrim > maxW) {   // a single word wider than the box: break it by characters
        let piece = '';
        for (const ch of trimmed) {
          if (mctx.measureText(piece + ch).width > maxW && piece) { const pw = mctx.measureText(piece).width; line.tokens.push({ text: piece, st: tk.st, x: line.w, w: pw, wTrim: pw }); line.w += pw; line.wTrim = line.w; flush(); piece = ch; }
          else piece += ch;
        }
        const pw = mctx.measureText(piece).width, full = mctx.measureText(piece + tk.text.slice(trimmed.length)).width;
        line.tokens.push({ text: piece + tk.text.slice(trimmed.length), st: tk.st, x: line.w, w: full, wTrim: pw }); line.wTrim = line.w + pw; line.w += full;
        continue;
      }
      line.tokens.push({ text: tk.text, st: tk.st, x: line.w, w, wTrim }); line.wTrim = line.w + wTrim; line.w += w;
    }
    flush();
  }
  let y = 0;
  for (const ln of lines) {
    const sts = ln.tokens.length ? ln.tokens.map(t => t.st) : [ln.base];
    let asc = 0, desc = 0, size = 0;
    for (const st of sts) { const m = metrics(st); asc = Math.max(asc, m.asc); desc = Math.max(desc, m.desc); size = Math.max(size, st.size); }
    ln.h = size * 1.3; ln.y = y; ln.baseline = y + (ln.h - (asc + desc)) / 2 + asc;
    ln.offset = ln.align === 'center' ? (maxW - ln.wTrim) / 2 : ln.align === 'right' ? (maxW - ln.wTrim) : 0;
    y += ln.h;
  }
  el._layout = { lines, h: y };
  el.h = y + TEXT_PAD * 2;
  el.text = docText(doc);
  return lines;
}
export function textLayout(el) { return (el._layout || (layoutText(el), el._layout)); }

/* ---------- images ---------- */
const imgCache = new Map();
export function getImage(src, onReady) {
  let e = imgCache.get(src);
  if (!e) {
    e = { img: new Image(), ok: false, cbs: [] };
    e.img.onload = () => { e.ok = true; const cbs = e.cbs; e.cbs = []; cbs.forEach(cb => cb()); };
    e.img.onerror = () => { e.ok = true; e.failed = true; const cbs = e.cbs; e.cbs = []; cbs.forEach(cb => cb()); };
    e.img.src = src;
    imgCache.set(src, e);
  }
  if (!e.ok && onReady) e.cbs.push(onReady);
  return e.ok && !e.failed ? e.img : null;
}
export function imageReady(src) {
  return new Promise(res => { const i = getImage(src, () => res(imgCache.get(src).img)); if (i) res(i); });
}

/* ---------- paint-bucket fills ----------
   A fill is a bitmap mask (white pixels with alpha) stretched over cx/cy/w/h, tinted with `color`. */
const tintCache = new Map(), maskData = new Map();
export function tintedFill(el, onReady) {
  const key = el.mask + '|' + el.color;
  let c = tintCache.get(key); if (c) return c;
  const img = getImage(el.mask, onReady); if (!img) return null;
  c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = el.color; x.fillRect(0, 0, c.width, c.height);
  if (tintCache.size > 40) tintCache.clear();
  tintCache.set(key, c); return c;
}
export function maskAlpha(el, p) {
  const img = getImage(el.mask); if (!img) return 0;
  let d = maskData.get(el.mask);
  if (!d) {
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
    d = { w: c.width, h: c.height, a: x.getImageData(0, 0, c.width, c.height).data };
    if (maskData.size > 40) maskData.clear();
    maskData.set(el.mask, d);
  }
  const [lx, ly] = toLocal(el, p);
  const px = Math.floor((lx + el.w / 2) / el.w * d.w), py = Math.floor((ly + el.h / 2) / el.h * d.h);
  if (px < 0 || py < 0 || px >= d.w || py >= d.h) return 0;
  return d.a[(py * d.w + px) * 4 + 3];
}

/* ---------- lines & curves ----------
   A line/arrow is a list of points `pts` (page coords). The first and last are the ends; any points
   between are handles the curve passes through (Catmull-Rom spline). cx/cy/w/rot are kept in sync
   with the two ends so the generic selection code keeps working. */
export function arrowHead(el) { return 8 + (el.width || 2) * 2.5; }
export function linePts(el) {
  if (el.pts && el.pts.length >= 2) return el.pts;
  return [fromLocal(el, [-el.w / 2, 0]), fromLocal(el, [el.w / 2, 0])];
}
export function syncLine(el) {
  const a = el.pts[0], b = el.pts[el.pts.length - 1];
  el.cx = (a[0] + b[0]) / 2; el.cy = (a[1] + b[1]) / 2; el.w = Math.hypot(b[0] - a[0], b[1] - a[1]); el.h = 0; el.rot = Math.atan2(b[1] - a[1], b[0] - a[0]);
  return el;
}
/* cubic bezier segments [p0, c1, c2, p1] through all points */
export function curveSegments(pts) {
  const segs = [];
  if (pts.length < 2) return segs;
  if (pts.length === 2) return [[pts[0], pts[0], pts[1], pts[1]]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    segs.push([p1, [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2]);
  }
  return segs;
}
export function bezierPoint(b, t) {
  const u = 1 - t, a = u * u * u, bb = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * b[0][0] + bb * b[1][0] + c * b[2][0] + d * b[3][0], a * b[0][1] + bb * b[1][1] + c * b[2][1] + d * b[3][1]];
}
function lerp(p, q, t) { return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; }
export function splitBezier(b, t) {
  const p01 = lerp(b[0], b[1], t), p12 = lerp(b[1], b[2], t), p23 = lerp(b[2], b[3], t);
  const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t), m = lerp(p012, p123, t);
  return [[b[0], p01, p012, m], [m, p123, p23, b[3]]];
}
/* shorten the end of a curve by `len` (so an arrowhead can sit cleanly on the tip) */
export function trimEnd(segs, len) {
  if (!segs.length || len <= 0) return segs;
  const b = segs[segs.length - 1];
  let prev = b[3], acc = 0, t = 1;
  for (let i = 1; i <= 48; i++) { t = 1 - i / 48; const p = bezierPoint(b, t); acc += Math.hypot(p[0] - prev[0], p[1] - prev[1]); prev = p; if (acc >= len) break; }
  if (acc < len) return segs.length > 1 ? trimEnd(segs.slice(0, -1), len - acc) : [[b[0], b[0], b[0], b[0]]];
  return segs.slice(0, -1).concat([splitBezier(b, t)[0]]);
}
export function endDirection(pts) {
  const segs = curveSegments(pts), b = segs[segs.length - 1], end = b[3];
  let dx = end[0] - b[2][0], dy = end[1] - b[2][1];
  if (Math.hypot(dx, dy) < 1e-6) { dx = end[0] - b[0][0]; dy = end[1] - b[0][1]; }
  const d = Math.hypot(dx, dy) || 1; return [dx / d, dy / d];
}
/* polyline approximation (for hit testing and bounds) */
export function curvePolyline(pts, n = 10) {
  const out = [];
  for (const b of curveSegments(pts)) for (let i = 0; i <= n; i++) out.push(bezierPoint(b, i / n));
  return out.length ? out : pts.slice();
}
export function tracePath(ctx, segs) {
  if (!segs.length) return;
  ctx.moveTo(segs[0][0][0], segs[0][0][1]);
  for (const b of segs) ctx.bezierCurveTo(b[1][0], b[1][1], b[2][0], b[2][1], b[3][0], b[3][1]);
}

export function drawElement(ctx, el, env = {}) {
  if (env.hideId && env.hideId === el.id) return;
  switch (el.type) {
    case 'fill': {
      const c = tintedFill(el, env.onImage); if (!c) return;
      ctx.save(); ctx.translate(el.cx, el.cy); ctx.rotate(el.rot || 0);
      ctx.drawImage(c, -el.w / 2, -el.h / 2, el.w, el.h); ctx.restore();
      break;
    }
    case 'stroke': {
      if (el.points.length < 1) return;
      ctx.save();
      if (el.tool === 'highlighter') { ctx.globalAlpha = 0.4; ctx.globalCompositeOperation = 'multiply'; }
      ctx.fillStyle = el.color;
      ctx.fill(env.live ? cmdsToPath2D(strokeCommands(el, true)) : strokePath(el));
      ctx.restore();
      break;
    }
    case 'shape': {
      if (el.kind === 'line' || el.kind === 'arrow') {
        const pts = linePts(el), hs = el.kind === 'arrow' ? arrowHead(el) : 0;
        let segs = curveSegments(pts);
        if (hs) segs = trimEnd(segs, hs * 0.6);
        ctx.save();
        ctx.strokeStyle = el.color; ctx.lineWidth = el.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath(); tracePath(ctx, segs); ctx.stroke();
        if (hs) {
          const tip = pts[pts.length - 1], [dx, dy] = endDirection(pts);
          ctx.fillStyle = el.color; ctx.beginPath();
          ctx.moveTo(tip[0], tip[1]);
          ctx.lineTo(tip[0] - dx * hs - dy * hs * 0.45, tip[1] - dy * hs + dx * hs * 0.45);
          ctx.lineTo(tip[0] - dx * hs + dy * hs * 0.45, tip[1] - dy * hs - dx * hs * 0.45);
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
        break;
      }
      ctx.save();
      ctx.translate(el.cx, el.cy); ctx.rotate(el.rot || 0);
      ctx.strokeStyle = el.color; ctx.lineWidth = el.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const hw = el.w / 2, hh = el.h / 2;
      if (el.kind === 'rect') {
        ctx.beginPath(); ctx.rect(-hw, -hh, el.w, el.h);
        if (el.fill && el.fill !== 'none') { ctx.fillStyle = el.fill; ctx.fill(); }
        ctx.stroke();
      } else if (el.kind === 'ellipse') {
        ctx.beginPath(); ctx.ellipse(0, 0, Math.max(0.1, hw), Math.max(0.1, hh), 0, 0, Math.PI * 2);
        if (el.fill && el.fill !== 'none') { ctx.fillStyle = el.fill; ctx.fill(); }
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'text': {
      const lay = textLayout(el);
      ctx.save();
      ctx.translate(el.cx, el.cy); ctx.rotate(el.rot || 0);
      ctx.textBaseline = 'alphabetic';
      const x0 = -el.w / 2 + TEXT_PAD, y0 = -el.h / 2 + TEXT_PAD;
      for (const ln of lay.lines) for (const tk of ln.tokens) {
        ctx.font = fontString(tk.st); ctx.fillStyle = tk.st.color || el.color || '#111827';
        const x = x0 + ln.offset + tk.x, y = y0 + ln.baseline;
        ctx.fillText(tk.text, x, y);
        if (tk.st.u && tk.wTrim > 0) ctx.fillRect(x, y + tk.st.size * 0.12, tk.wTrim, Math.max(0.8, tk.st.size / 14));
      }
      ctx.restore();
      break;
    }
    case 'image': {
      const img = getImage(el.src, env.onImage);
      ctx.save();
      ctx.translate(el.cx, el.cy); ctx.rotate(el.rot || 0);
      if (img) ctx.drawImage(img, -el.w / 2, -el.h / 2, el.w, el.h);
      else { ctx.fillStyle = '#eef1f5'; ctx.fillRect(-el.w / 2, -el.h / 2, el.w, el.h); }
      ctx.restore();
      break;
    }
    case 'link': {
      ctx.save();
      ctx.translate(el.cx, el.cy); ctx.rotate(el.rot || 0);
      const x = -el.w / 2, y = -el.h / 2, r = 8;
      ctx.beginPath(); ctx.roundRect(x, y, el.w, el.h, r);
      ctx.fillStyle = '#eef4ff'; ctx.fill(); ctx.strokeStyle = '#7aa2e8'; ctx.lineWidth = 1; ctx.stroke();
      // globe-ish icon
      ctx.strokeStyle = '#3b6fd1'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x + 20, 0, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(x + 20, 0, 4, 9, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + 11, 0); ctx.lineTo(x + 29, 0); ctx.stroke();
      ctx.save(); ctx.beginPath(); ctx.rect(x + 36, y, el.w - 42, el.h); ctx.clip();
      ctx.fillStyle = '#1b2a4a'; ctx.textBaseline = 'top'; ctx.font = `bold 12px ${FONT}`;
      ctx.fillText(el.title || hostOf(el.url), x + 36, y + 8);
      ctx.fillStyle = '#5b6b85'; ctx.font = `10px ${FONT}`;
      ctx.fillText(el.url, x + 36, y + 26);
      ctx.restore();
      ctx.restore();
      break;
    }
  }
}
export function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }

export function renderPage(ctx, page, env = {}) {
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  drawMarks(ctx, templateMarks(page.template));
  for (const el of page.elements) drawElement(ctx, el, env);
}

/* ---------- geometry ---------- */
export function corners(el) {
  const c = Math.cos(el.rot || 0), s = Math.sin(el.rot || 0), hw = el.w / 2, hh = (el.h || 0) / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [el.cx + x * c - y * s, el.cy + x * s + y * c]);
}
export function toLocal(el, p) {
  const dx = p[0] - el.cx, dy = p[1] - el.cy, c = Math.cos(-(el.rot || 0)), s = Math.sin(-(el.rot || 0));
  return [dx * c - dy * s, dx * s + dy * c];
}
export function fromLocal(el, [x, y]) {
  const c = Math.cos(el.rot || 0), s = Math.sin(el.rot || 0);
  return [el.cx + x * c - y * s, el.cy + x * s + y * c];
}
export function bbox(el) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, pad = 0;
  if (el.type === 'stroke') {
    for (const p of el.points) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    pad = el.size / 2 + 1;
  } else if (el.type === 'shape' && (el.kind === 'line' || el.kind === 'arrow')) {
    for (const p of curvePolyline(linePts(el), 6)) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    pad = el.width / 2 + (el.kind === 'arrow' ? arrowHead(el) * 0.5 : 0);
  } else {
    for (const p of corners(el)) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    if (el.type === 'shape') pad = el.width / 2;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}
export function unionBox(els) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const el of els) { const e = bbox(el); b.x0 = Math.min(b.x0, e.x0); b.y0 = Math.min(b.y0, e.y0); b.x1 = Math.max(b.x1, e.x1); b.y1 = Math.max(b.y1, e.y1); }
  return b;
}
export function distToSegment(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], wx = p[0] - a[0], wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  const dx = a[0] + t * vx - p[0], dy = a[1] + t * vy - p[1];
  return Math.hypot(dx, dy);
}
export function hitElement(el, p, tol) {
  const b = bbox(el);
  if (p[0] < b.x0 - tol || p[0] > b.x1 + tol || p[1] < b.y0 - tol || p[1] > b.y1 + tol) return false;
  if (el.type === 'stroke') {
    const r = tol + el.size / 2;
    const pts = el.points;
    if (pts.length === 1) return Math.hypot(pts[0][0] - p[0], pts[0][1] - p[1]) <= r;
    for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1], pts[i]) <= r) return true;
    return false;
  }
  if (el.type === 'shape' && (el.kind === 'line' || el.kind === 'arrow')) {
    const r = tol + el.width / 2 + (el.kind === 'arrow' ? arrowHead(el) * 0.3 : 0), poly = curvePolyline(linePts(el), 8);
    for (let i = 1; i < poly.length; i++) if (distToSegment(p, poly[i - 1], poly[i]) <= r) return true;
    return false;
  }
  if (el.type === 'fill') return maskAlpha(el, p) > 0;
  const [lx, ly] = toLocal(el, p), hw = el.w / 2, hh = el.h / 2;
  if (el.type === 'shape') {
    const t = tol + el.width / 2;
    const filled = el.fill && el.fill !== 'none';
    if (el.kind === 'rect') {
      const inside = Math.abs(lx) <= hw + t && Math.abs(ly) <= hh + t;
      if (!inside) return false;
      return filled || !(Math.abs(lx) < hw - t && Math.abs(ly) < hh - t);
    }
    const nx = lx / Math.max(hw, 0.1), ny = ly / Math.max(hh, 0.1), r = Math.hypot(nx, ny);
    if (filled) return r <= 1 + t / Math.min(hw, hh);
    return Math.abs(r - 1) * Math.min(hw, hh) <= t;
  }
  return Math.abs(lx) <= hw + tol && Math.abs(ly) <= hh + tol;
}
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
export function elementInLasso(el, poly) {
  if (el.type === 'stroke') {
    let n = 0; const step = Math.max(1, Math.floor(el.points.length / 40));
    let total = 0;
    for (let i = 0; i < el.points.length; i += step) { total++; if (pointInPolygon(el.points[i], poly)) n++; }
    return total > 0 && n / total >= 0.5;
  }
  return pointInPolygon([el.cx, el.cy], poly);
}
