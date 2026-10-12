// 앱 셸은 네트워크 우선으로 캐시하고, 음원(/audio/)은 사용자가 '오프라인 음원' 화면에서 받아 둔 것만 캐시에서 꺼내 쓴다.
const CACHE = "opic-shell-v7";
const AUDIO_CACHE = "opic-audio-v1"; // 셸 버전을 올려도 지워지지 않는다(activate 에서 opic-audio- 는 보존)
const SHELL = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && !k.startsWith("opic-audio-")).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Cache API 는 Range 를 처리하지 못하므로(Safari 의 <audio> 는 항상 Range 로 요청) 캐시된 본문을 직접 잘라 206 으로 답한다.
async function rangeResponse(req, res) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
  if (!m || (m[1] === "" && m[2] === "")) return res;
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  let start, end;
  if (m[1] === "") { start = Math.max(0, size - +m[2]); end = size - 1; }
  else { start = +m[1]; end = m[2] === "" ? size - 1 : Math.min(+m[2], size - 1); }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "audio/mpeg",
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/audio/")) {
    // 받아 둔 음원이면 캐시에서, 없으면 네트워크(자동으로 캐시에 쌓지는 않는다)
    e.respondWith((async () => {
      const hit = await (await caches.open(AUDIO_CACHE)).match(url.pathname, { ignoreSearch: true });
      if (hit) return rangeResponse(e.request, hit);
      return fetch(e.request);
    })());
    return;
  }
  // 네트워크 우선, 실패 시 캐시 (콘텐츠 갱신이 바로 반영되도록)
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
