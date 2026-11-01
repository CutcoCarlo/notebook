# Notebook

A paper notebook for iPad (works in any modern browser): handwrite with the Apple Pencil,
type, sketch, add boxes / circles / lines / arrows, photos and web links, then export to PDF.
Pure static site: no build step, no server, works offline once opened.

## Files
- `index.html` – screens, toolbar and dialogs
- `style.css` – styling
- `app.js` – editor: notebooks, pages, input, tools, selection, undo, storage (IndexedDB)
- `render.js` – page templates, ink, shapes, text and hit-testing (shared by canvas, thumbnails and PDF)
- `export.js` – PDF (vector) and PNG export, share sheet
- `perfect-freehand.mjs` – pressure-sensitive stroke outlines (MIT)
- `jspdf.umd.min.js` – PDF writer (MIT)
- `sw.js` – offline cache (bump `VERSION` on every release)
- `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` – home-screen install
- `RESEARCH.md` – feature research behind the design

## Deploy
Upload everything to a GitHub repo with Pages enabled (main / root), same as the other apps.
Bump `VERSION` in `sw.js` on every release so installed iPads pick up the update.

## Install on iPad
Open the site in Safari → Share → Add to Home Screen.

## Sending notes to Claude
Menu (⋯) → Export notebook as PDF → in the share sheet choose Google Drive and save into a
"Notebook" folder. Claude can read PDFs from Google Drive.

## Data
Notebooks live in the browser's IndexedDB on the device. Use Menu → Save backup file to export a
`.notebook.json` you can re-import from the home screen.
