/* Offline shell.
 *
 * Without this the app cannot open without a connection: Vercel serves
 * `cache-control: public, max-age=0, must-revalidate`, so the browser has to
 * reach the server on every load. The data already lives on the device; this
 * puts the app itself there too.
 *
 * Bump CACHE_VERSION on any change to the precache list. Old caches are deleted
 * on activate, which is what stops a stale build being served after a deploy —
 * the failure mode that makes service workers untrustworthy.
 */
const CACHE_VERSION = 'v1';
const CACHE = `asc-shell-${CACHE_VERSION}`;

/* Everything needed to open and bill, all same-origin. The libraries are
   vendored rather than loaded from a CDN precisely so they can live here: a
   cross-origin script request returns an opaque response, which cannot be
   written to a Cache. Without them the page would open offline but
   initSupabase() would find no library. */
const SHELL = [
  './', './index.html', './manifest.json',
  './vendor/supabase-js.min.js', './vendor/tesseract.min.js',
  './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n.startsWith('asc-shell-') && n !== CACHE)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

/** Only same-origin GETs are ours. Everything else — above all the Supabase
 *  REST and auth calls — must go straight to the network.
 *
 *  This worker's own script is excluded explicitly. The spec already bypasses
 *  the worker when fetching it for an update check, but serving it from our own
 *  cache would mean a worker that can never be replaced, which is the failure
 *  this whole versioning scheme exists to avoid. */
function isShellRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return !url.pathname.endsWith('/sw.js');
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (!isShellRequest(request)) return;   // fall through to the network

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });

    /* Stale-while-revalidate: answer instantly from cache so the counter is
       never waiting on a slow connection, and refresh in the background so the
       next open has the current build. */
    const network = fetch(request).then(res => {
      if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);

    if (cached) {
      event.waitUntil(network);
      return cached;
    }

    const fresh = await network;
    if (fresh) return fresh;

    // Offline with nothing cached: for a navigation, fall back to the shell.
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('offline', { status: 503, statusText: 'offline' });
  })());
});

/* Lets a page ask the worker to step aside for a new version immediately. */
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
