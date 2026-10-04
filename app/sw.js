// 앱 셸만 캐시한다. 음원은 Safari 의 Range 요청 문제를 피하려고 캐시하지 않는다(오프라인 음원은 2차).
const CACHE = "opic-shell-v1";
const SHELL = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/audio/")) return;
  // 네트워크 우선, 실패 시 캐시 (콘텐츠 갱신이 바로 반영되도록)
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
