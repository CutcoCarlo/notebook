/* export.js — PDF (vector) and PNG export of notebook pages. */
import { PAGE_W, PAGE_H, templateMarks, strokeCommands, layoutText, corners, fromLocal, arrowHead,
         TEXT_PAD, imageReady, hostOf, renderPage, linePts, curveSegments, trimEnd, endDirection, tintedFill } from './render.js';

const rgb = hex => {
  if (!hex || hex[0] !== '#') return [0, 0, 0];
  if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(c => c + c).join('');
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
};

export async function notebookToPDF(nb, indices) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
  doc.setProperties({ title: nb.name, creator: 'Notebook app' });
  for (let n = 0; n < indices.length; n++) {
    if (n) doc.addPage();
    await drawPagePDF(doc, nb.pages[indices[n]]);
  }
  return doc.output('blob');
}

/* path commands (m / l / q / h) -> jsPDF ops (quadratic converted to cubic) */
function toOps(cmds) {
  const ops = []; let cur = [0, 0];
  for (const c of cmds) {
    if (c.op === 'm') { cur = [c.c[0], c.c[1]]; ops.push({ op: 'm', c: cur.slice() }); }
    else if (c.op === 'l') { cur = [c.c[0], c.c[1]]; ops.push({ op: 'l', c: cur.slice() }); }
    else if (c.op === 'q') {
      const [qx, qy, x, y] = c.c;
      ops.push({ op: 'c', c: [cur[0] + 2 / 3 * (qx - cur[0]), cur[1] + 2 / 3 * (qy - cur[1]), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y] });
      cur = [x, y];
    } else ops.push({ op: 'h' });
  }
  return ops;
}
function polyOps(pts) { return pts.map((p, i) => ({ op: i ? 'l' : 'm', c: [p[0], p[1]] })).concat([{ op: 'h' }]); }

async function drawPagePDF(doc, page) {
  // paper
  for (const k of templateMarks(page.template)) {
    if (k.k === 'line') { doc.setDrawColor(...rgb(k.color)); doc.setLineWidth(k.width); doc.line(k.x1, k.y1, k.x2, k.y2); }
    else { doc.setFillColor(...rgb(k.color)); doc.circle(k.x, k.y, k.r, 'F'); }
  }
  doc.setLineCap('round'); doc.setLineJoin('round');
  for (const el of page.elements) {
    switch (el.type) {
      case 'fill': {
        await imageReady(el.mask);
        const c = tintedFill(el); if (!c) break;
        doc.addImage(c.toDataURL('image/png'), 'PNG', el.cx - el.w / 2, el.cy - el.h / 2, el.w, el.h, undefined, 'FAST');
        break;
      }
      case 'stroke': {
        if (el.points.length < 1) break;
        doc.setFillColor(...rgb(el.color));
        const hl = el.tool === 'highlighter';
        if (hl) { doc.saveGraphicsState(); doc.setGState(new doc.GState({ opacity: 0.4 })); }
        doc.path(toOps(strokeCommands(el))); doc.fill();
        if (hl) doc.restoreGraphicsState();
        break;
      }
      case 'shape': {
        doc.setDrawColor(...rgb(el.color)); doc.setLineWidth(el.width);
        const filled = el.fill && el.fill !== 'none';
        if (filled) doc.setFillColor(...rgb(el.fill));
        if (el.kind === 'rect') {
          doc.path(polyOps(corners(el))); filled ? doc.fillStroke() : doc.stroke();
        } else if (el.kind === 'ellipse') {
          const a = el.w / 2, b = el.h / 2, k = 0.5523;
          const L = p => fromLocal(el, p);
          const ops = [{ op: 'm', c: L([a, 0]) }];
          const seg = (c1, c2, p) => ops.push({ op: 'c', c: [...L(c1), ...L(c2), ...L(p)] });
          seg([a, b * k], [a * k, b], [0, b]); seg([-a * k, b], [-a, b * k], [-a, 0]);
          seg([-a, -b * k], [-a * k, -b], [0, -b]); seg([a * k, -b], [a, -b * k], [a, 0]);
          ops.push({ op: 'h' });
          doc.path(ops); filled ? doc.fillStroke() : doc.stroke();
        } else {
          const pts = linePts(el), hs = el.kind === 'arrow' ? arrowHead(el) : 0;
          let segs = curveSegments(pts); if (hs) segs = trimEnd(segs, hs * 0.6);
          const ops = [{ op: 'm', c: [segs[0][0][0], segs[0][0][1]] }];
          for (const b of segs) ops.push({ op: 'c', c: [b[1][0], b[1][1], b[2][0], b[2][1], b[3][0], b[3][1]] });
          doc.path(ops); doc.stroke();
          if (hs) {
            const tip = pts[pts.length - 1], [dx, dy] = endDirection(pts);
            doc.setFillColor(...rgb(el.color));
            doc.path(polyOps([tip, [tip[0] - dx * hs - dy * hs * 0.45, tip[1] - dy * hs + dx * hs * 0.45], [tip[0] - dx * hs + dy * hs * 0.45, tip[1] - dy * hs - dx * hs * 0.45]])); doc.fill();
          }
        }
        break;
      }
      case 'text': {
        const lines = el._lines || layoutText(el);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(el.size); doc.setTextColor(...rgb(el.color));
        const lh = el.size * 1.3, angle = -(el.rot || 0) * 180 / Math.PI;
        lines.forEach((ln, i) => {
          if (!ln) return;
          const [x, y] = fromLocal(el, [-el.w / 2 + TEXT_PAD, -el.h / 2 + TEXT_PAD + i * lh]);
          doc.text(ln, x, y, { angle, baseline: 'top' });
        });
        break;
      }
      case 'image': {
        const fmt = el.src.startsWith('data:image/png') ? 'PNG' : 'JPEG';
        if (Math.abs(el.rot || 0) < 0.005) {
          doc.addImage(el.src, fmt, el.cx - el.w / 2, el.cy - el.h / 2, el.w, el.h, undefined, 'FAST');
        } else {
          const img = await imageReady(el.src);
          const cs = corners(el);
          const bw = Math.max(...cs.map(p => p[0])) - Math.min(...cs.map(p => p[0]));
          const bh = Math.max(...cs.map(p => p[1])) - Math.min(...cs.map(p => p[1]));
          const k = 2, cv = document.createElement('canvas'); cv.width = Math.ceil(bw * k); cv.height = Math.ceil(bh * k);
          const ctx = cv.getContext('2d'); ctx.scale(k, k); ctx.translate(bw / 2, bh / 2); ctx.rotate(el.rot); ctx.drawImage(img, -el.w / 2, -el.h / 2, el.w, el.h);
          doc.addImage(cv.toDataURL('image/png'), 'PNG', el.cx - bw / 2, el.cy - bh / 2, bw, bh, undefined, 'FAST');
        }
        break;
      }
      case 'link': {
        const x = el.cx - el.w / 2, y = el.cy - el.h / 2;
        doc.setFillColor(...rgb('#eef4ff')); doc.setDrawColor(...rgb('#7aa2e8')); doc.setLineWidth(1);
        doc.roundedRect(x, y, el.w, el.h, 8, 8, 'FD');
        doc.setDrawColor(...rgb('#3b6fd1')); doc.setLineWidth(1.5); doc.circle(x + 20, el.cy, 9, 'S'); doc.line(x + 11, el.cy, x + 29, el.cy);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...rgb('#1b2a4a'));
        doc.text(doc.splitTextToSize(el.title || hostOf(el.url), el.w - 44)[0] || '', x + 36, y + 8, { baseline: 'top' });
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...rgb('#5b6b85'));
        doc.text(doc.splitTextToSize(el.url, el.w - 44)[0] || '', x + 36, y + 26, { baseline: 'top' });
        doc.link(x, y, el.w, el.h, { url: el.url });
        break;
      }
    }
  }
}

export async function pageToPNG(page, scale = 2) {
  for (const el of page.elements) if (el.type === 'image') await imageReady(el.src);
  const cv = document.createElement('canvas'); cv.width = PAGE_W * scale; cv.height = PAGE_H * scale;
  const ctx = cv.getContext('2d'); ctx.scale(scale, scale);
  renderPage(ctx, page, {});
  return new Promise(res => cv.toBlob(res, 'image/png'));
}

export async function shareOrDownload(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: title || filename }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return 'downloaded';
}
