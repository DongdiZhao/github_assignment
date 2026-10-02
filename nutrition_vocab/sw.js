// 离线缓存：首次打开后，没有网络也能使用。
// 程序文件：优先联网获取最新版本，断网时用缓存。
// 录音文件（audio/）：播放过一次就缓存下来，之后优先用缓存，离线也能听。
const CACHE = 'nutrition-vocab-v3';
const AUDIO_CACHE = 'nutrition-vocab-audio-v1';
const FILES = [
  './', './index.html', './style.css', './app.js', './words.js',
  './vocab/1-biochem.js', './vocab/2-anatomy.js', './vocab/3-food.js', './vocab/4-sports.js',
  './vocab/5-clinical.js', './vocab/6-assessment.js', './vocab/7-community.js', './vocab/8-foodservice.js',
  './manifest.json', './icon.svg', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  const keep = [CACHE, AUDIO_CACHE];
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !keep.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.includes('/audio/') && url.pathname.endsWith('.mp3')) {
    // 录音：缓存优先。Range 请求（<audio> 直接播放时）交给网络处理，避免返回不完整的数据。
    if (e.request.headers.has('range')) return;
    e.respondWith(caches.open(AUDIO_CACHE).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok && res.status === 200) c.put(e.request, res.clone());
      return res;
    }))));
    return;
  }
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
