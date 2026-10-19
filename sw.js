// My Gardrobe service worker, two jobs:
// - pictures and links shared from other apps (Pinterest -> Share -> My Gardrobe) are kept in IndexedDB
//   and Styles -> Inspirations opens, where the app asks for a folder before saving;
// - the app opens without a connection once it has been opened online: its own files are fetched fresh
//   when possible and come from the cache only offline; Google Fonts come from the cache first.
// The API is never cached: wardrobe data lives in the app and on the server.
var CACHE = 'mg-v3';
var SHELL = ['app.html', 'i18n/app-strings.js', 'manifest.webmanifest', 'assets/icons/icon-192.png', 'assets/swatches.svg', 'assets/wardrobe.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function keepShared(value) {
  return new Promise(function (ok, no) {
    var r = indexedDB.open('my-gardrobe', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
    r.onerror = function () { no(r.error); };
    r.onsuccess = function () {
      var t = r.result.transaction('kv', 'readwrite');
      t.objectStore('kv').put(value, 'share-inbox');
      t.oncomplete = function () { ok(); };
      t.onerror = function () { no(t.error); };
    };
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.slice(-10) === '/share-in/') {
    e.respondWith(req.formData().then(function (form) {
      return keepShared({
        title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '',
        files: form.getAll('photos').filter(function (f) { return f && f.size; })
      });
    })['catch'](function () {}).then(function () {
      return Response.redirect(new URL('../app.html?shared=1#inspoBoard', url).href, 303);
    }));
    return;
  }
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
