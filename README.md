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

## Install on a phone

**As a web app (no store):** open the app in the browser; Chrome offers *Install app* (on Android: *Add to Home screen*). It then opens full screen with its own icon and works offline (`manifest.webmanifest`, `sw.js`). Phones only install it from an HTTPS address, so this works once the server is online.

**As an Android app:** `android/` is a [Capacitor](https://capacitorjs.com) project that wraps the same app. `npm install` once, then:

```sh
MG_API_URL=https://your-server.example npm run android   # opens Android Studio
```

`scripts/build-app.mjs` copies the app into `www/` (start page: `app.html`) and sets the server address. Without `MG_API_URL` it uses `http://10.0.2.2:8000`, which is this Mac as seen from the Android emulator. The app signs in with a bearer token instead of the cookie (the server allows its origin, `https://localhost`).

For the Google Play Store you need a Play Console account; an APK can also be shared directly. Before the first upload, settle the app id (`com.mygardrobe.app` in `capacitor.config.json`), and once the server is on HTTPS turn off `cleartext` / `allowMixedContent` there.

The icon is `assets/app-icon.svg`; the PNGs in `assets/icons/` and `android/` were made from it.

## Backend

`server/server.js` keeps accounts and each person's wardrobe in one SQLite file, `server/data/gardrobe.db` (not in git).

- Passwords are hashed with scrypt; sign-in uses an HttpOnly session cookie (60 days).
- The app still works from localStorage; while someone is signed in, changes to their wardrobe keys (`mg-items`, `mg-fav`, `mg-outfit`, `mg-capsule`, …) are sent to `/api/data/<key>`, and on opening the app the account's data is loaded. Theme, units and language stay per device.
- Adding a piece: a shop link in the Google panel is read by `server/lookup.js` (`POST /api/lookup`); a new photo is recognised by Claude in `server/classify.js` (`POST /api/classify`, model `claude-opus-5-5`, low effort) and fills in category, type, colour and brand. Recognition needs Claude API credentials on the server, e.g. `ANTHROPIC_API_KEY=… node server/server.js` (`npm install` first); without them the form is filled in by hand.
- API: `POST /api/signup`, `POST /api/login`, `POST /api/logout`, `GET /api/me`, `POST /api/password`, `PUT|DELETE /api/data/<key>`.

## Still to do

- Replace the placeholder phone number (+43 660 123 4567) with the real one.
- Add the real App Store / Google Play links on the download screen.
- Password reset by email and Google sign-in (the server has no email sending yet).
- Run the server on HTTPS when it goes online (then mark the session cookie `Secure`).
- Finish translations for the remaining languages and have the less common ones checked by native speakers.
