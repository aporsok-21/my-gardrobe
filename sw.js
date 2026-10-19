// Service worker: lets My Gardrobe open without a connection once it has been opened online.
// The app's own files are fetched fresh when possible (so updates show up at once) and come from the cache
// only without a connection; Google Fonts never change, so they come from the cache first.
// The API is never cached: wardrobe data lives in the app (localStorage) and on the server.
var CACHE = 'mg-v2';
var SHELL = ['app.html', 'i18n/app-strings.js', 'manifest.webmanifest', 'assets/icons/icon-192.png', 'assets/swatches.svg', 'assets/wardrobe.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.indexOf('/api/') === 0) return;
  var mine = url.origin === location.origin, fonts = /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!mine && !fonts) return;   // weather and other services go straight to the network
  function keep(res) { if (res.ok || res.type === 'opaque') { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); } return res; }
  if (fonts) {
    e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req).then(keep); }));
  } else {
    e.respondWith(fetch(req).then(keep).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || (req.mode === 'navigate' ? caches.match('app.html') : Response.error()); });
    }));
  }
});
