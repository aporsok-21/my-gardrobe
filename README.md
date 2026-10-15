# My Gardrobe

Landing page for **My Gardrobe** — *Style and organise your clothes.*

## What's here

- `index.html` — the landing page (logo, motto, "Get started", how it works, contact, language picker with 246 languages, walk-in wardrobe animation and the app download screen).
- `js/dc-mini.js` — a tiny dependency-free renderer the page uses for its template, language switching and animation state.
- `i18n/translations.json` — page texts in the languages translated so far (the rest fall back to English).
- `assets/` — the black outline illustrations.

## Run it locally

Because the page loads `i18n/translations.json`, open it through a local web server rather than double-clicking the file:

```sh
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Still to do

- Replace the placeholder phone number (+43 660 123 4567) with the real one.
- Add the real App Store / Google Play links on the download screen.
- Finish translations for the remaining languages and have the less common ones checked by native speakers.
