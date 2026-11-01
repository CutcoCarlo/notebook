# Notebook App – Feature Research (Oct 31, 2026)

Brief from Carlo's email (Oct 28, 2026): an iPad web app that simulates a paper notebook.
Type, handwrite, sketch. Page styles: blank, college ruled, composition, grid.
Shapes (box, circle, line, arrow) that can be selected, resized, rotated. Text box anywhere.
Colors, images, website links. Export PDF. Sync with Claude. Handwriting-to-text is nice-to-have.

## What the existing tools do

### reMarkable (Paper Pro / rM2)
- Notebooks in folders, plus tags. Many page templates (lined, grid, dots, planners, music, etc.).
- Pen types: ballpoint, fineliner, marker, pencil, highlighter, calligraphy. Eraser. Lasso select
  that can move, resize and rotate strokes.
- Layers (show/hide sets of content on a page).
- Handwriting-to-text conversion, send page by email, Google Drive / Dropbox / OneDrive sync,
  Screen Share. Since Oct 2025 these are free; the "Connect" subscription ($2.99/mo) mainly adds
  cloud storage and editing from phone/laptop.
- Weakness: search only finds typed text and titles, not handwriting, unless you convert first.
- PDF and ePub import with annotation. "Quick Sheets" scratchpad notebook.

### GoodNotes 6 (iPad)
- Notebooks with covers and paper templates; PDF import and annotation.
- Draw a shape and hold the pen to snap it to a clean geometric shape (reviewers find it hit-or-miss).
- Lasso tool, handwriting-to-text, stickers/"elements" library, zoom window for small writing.
- PDF export (users complain export settings reset and large exports get blurry).

### Notability (iPad)
- Signature feature: audio recording synced to your handwriting; tap a word to replay that moment.
- Handwriting conversion in 22 languages, math conversion (paid tier).
- Multi-note side-by-side view.

### Apple Freeform (free, on your iPad already)
- Infinite canvas whiteboard, not pages.
- ~700 shapes, sticky notes, text boxes, images, files, website link cards.
- Connectors: lines/arrows that stay attached to shapes when you move them.
- Hold pen after drawing a shape to snap it clean. iCloud sync and collaboration.

### Apple Notes (free)
- Smart Script tidies handwriting as you write; Math Notes solves handwritten equations.
- Scribble: write with the Pencil in any standard text field and it becomes typed text.
  Scribble also works in ordinary text fields inside Safari web pages. That means a web app's
  text boxes get handwriting-to-text for free, with no code.

### Excalidraw / tldraw (web, open source)
- Hand-drawn-look shapes, arrows that bind to shapes, text, images, libraries of reusable shapes.
- Export PNG / SVG / PDF. Excalidraw is MIT licensed (free to borrow ideas or code).
- tldraw is a commercial SDK; production use needs a license. Good interaction model to copy.

### Concepts (iPad)
- Infinite canvas with optional paper types and grids.
- Every stroke stays editable (vector) after drawing: move, recolor, resize, smooth.
- Objects library (save a sketch, tap to reuse). Export SVG/PDF to scale.

### Nebo (iPad)
- Best-in-class handwriting recognition (MyScript engine), turns whole pages into headings,
  lists and paragraphs. Shows how far recognition can go, but a heavy lift to build ourselves.

## What this means for a web app on iPad

- Apple Pencil in Safari gives position and pressure through pointer events. Finger vs pen is
  distinguishable, so we can draw only with the pen and use fingers for scroll/zoom. That is the
  practical palm-rejection approach. Pencil hover, double-tap and squeeze are NOT available to web apps.
- Ink rendering: the perfect-freehand library makes pressure-sensitive, natural-looking strokes.
- PDF export: pdf-lib or jsPDF can draw strokes and shapes as true vectors in the browser.
- Offline + saved on device: same PWA pattern as the Mind Map app (works with no signal,
  "Add to Home Screen").
- Latency will be good but not quite native-app smooth. Worth setting that expectation.

## Recommended Version 1

1. Notebooks with pages; add/reorder/delete pages; page thumbnails.
2. Page templates: blank, college ruled, composition (wide ruled with red margin), grid, dot grid.
3. Pen, highlighter, eraser; 3 widths; color palette; pressure-sensitive ink; undo/redo.
4. Pen-only drawing mode (fingers scroll and pinch-zoom).
5. Lasso select: move, resize, rotate, recolor, delete handwriting.
6. Shapes: rectangle, ellipse, line, arrow with drag handles for resize and rotate.
7. Text box anywhere (type or Scribble with the Pencil). Font size and color.
8. Insert image from Photos/camera; insert a website link as a clickable card.
9. Export notebook or page as PDF. Also PNG of a page.
10. "Send to Claude": save the PDF/PNG into a Google Drive folder Claude can read.

## Good candidates for Version 2

- Hold-to-snap shapes (draw a rough circle, hold, it becomes a perfect circle).
- Connectors that stay attached to shapes (Freeform).
- Convert selected handwriting to text (needs an outside recognition service).
- Tags and search across notebooks. Layers.
- Import a PDF and write on it.
- Shape/sticker library of reusable items (Concepts "objects").
- Audio recording linked to notes (Notability) – probably not needed.
