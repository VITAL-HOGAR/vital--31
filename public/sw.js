const CACHE_NAME = 'vital-hogar-v3';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://i.imgur.com/01YZxey.jpeg'
];

// INSTALL: precachear lo esencial (uno por uno, para que si un CDN falla, no rompa todo)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(url).catch(() => console.log('No se pudo cachear:', url)))
      );
    }).then(() => self.skipWaiting())
  );
});

// ACTIVATE: borrar cachés viejos automáticamente
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// FETCH: RED PRIMERO, caché solo como respaldo sin internet
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // NUNCA cachear la API: pacientes, turnos, chat... siempre frescos de Supabase
  if (url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // HTML y estáticos: intenta red primero, si falla usa caché
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
