# My Gardrobe

Landing page for **My Gardrobe** — *Style and organise your clothes.*

## What's here

- `index.html` — the landing page (logo, motto, "Get started", how it works, contact, language picker with 246 languages, walk-in wardrobe animation and the app download screen).
- `js/dc-mini.js` — a tiny dependency-free renderer the page uses for its template, language switching and animation state.
- `i18n/translations.json` — page texts in the languages translated so far (the rest fall back to English).
- `assets/` — the black outline illustrations.

## Run it locally

Start the server (Node 22.5 or newer, no packages to install). It serves the website and the app and holds the accounts:

```sh
node server/server.js
```

Then visit http://localhost:8000 (the app is at /app.html). Another port: `node server/server.js 8001`.

## Backend

`server/server.js` keeps accounts and each person's wardrobe in one SQLite file, `server/data/gardrobe.db` (not in git).

- Passwords are hashed with scrypt; sign-in uses an HttpOnly session cookie (60 days).
- The app still works from localStorage; while someone is signed in, changes to their wardrobe keys (`mg-items`, `mg-fav`, `mg-outfit`, …) are sent to `/api/data/<key>`, and on opening the app the account's data is loaded. Theme, units and language stay per device.
- API: `POST /api/signup`, `POST /api/login`, `POST /api/logout`, `GET /api/me`, `POST /api/password`, `PUT|DELETE /api/data/<key>`.

## Still to do

- Replace the placeholder phone number (+43 660 123 4567) with the real one.
- Add the real App Store / Google Play links on the download screen.
- Password reset by email and Google / Apple sign-in (the server has no email sending yet).
- Run the server on HTTPS when it goes online (then mark the session cookie `Secure`).
- Finish translations for the remaining languages and have the less common ones checked by native speakers.
