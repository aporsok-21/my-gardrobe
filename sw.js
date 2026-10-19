// My Gardrobe service worker: only receives pictures and links shared from other apps
// (Pinterest → Share → My Gardrobe). It keeps them in IndexedDB and opens Styles → Inspirations,
// where the app asks for a folder before saving. Nothing else is intercepted or cached.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

function keep(value) {
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
  var url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.pathname.slice(-10) !== '/share-in/') return;
  e.respondWith(e.request.formData().then(function (form) {
    return keep({
      title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '',
      files: form.getAll('photos').filter(function (f) { return f && f.size; })
    });
  })['catch'](function () {}).then(function () {
    return Response.redirect(new URL('../app.html?shared=1#inspoBoard', url).href, 303);
  }));
});
