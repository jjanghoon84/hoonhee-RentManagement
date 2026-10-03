// 임대관리 웹앱 - 서비스 워커 (앱 셸 캐시)
// v2: 네비게이션은 네트워크 우선 + 정상 응답만 캐시 (깨진 캐시 방지)
const CACHE_NAME = 'rental-app-v2';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;
  // Firebase 관련 호출은 항상 네트워크로 (캐시하지 않음)
  if (url.includes('gstatic.com') || url.includes('googleapis.com') || url.includes('firestore.googleapis.com')) {
    return;
  }
  // 페이지 이동은 네트워크 우선 → 항상 최신 화면을 보여줌
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  // 그 외 파일은 캐시 우선 (단, 정상 응답만 저장)
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
