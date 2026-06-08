const CACHE = 'caoshan-v2';
const URLS = [
  './',
  './index.html',
  './bill.html',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Chart.js CDN → 网络优先
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(networkFirst(e.request));
    return;
  }
  // data.json → 网络优先（数据经常变）
  if (url.pathname.endsWith('/data.json')) {
    e.respondWith(networkFirst(e.request));
    return;
  }
  // 其他本站资源 → 缓存优先
  e.respondWith(cacheFirst(e.request));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) {
      cache.put(req, res.clone());
      return res;
    }
    // 网络返回非 OK（404 等），回退缓存
    const cached = await cache.match(req);
    return cached || res;
  } catch {
    const cached = await cache.match(req);
    return cached || new Response('', { status: 503 });
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  return cached || fetch(req);
}
