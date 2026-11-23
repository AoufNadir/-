// Atelier · رقمي PWA Service Worker (Network-First for app shell; NEVER caches API or tenant data)
const CACHE = "atelier-shell-v4";
const SHELL = [
  "/assets/atelier/atelier/app.css",
  "/assets/atelier/atelier/app.js",
  "/assets/atelier/atelier/cloud-bridge.js",
  "/assets/atelier/atelier/vendor/vue.esm-browser.prod.js",
  "/assets/atelier/atelier/icon.svg",
  "/assets/atelier/atelier/icon-192.png",
  "/assets/atelier/atelier/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "CLEAR_CACHES") {
    e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Strictly skip non-GET, cross-origin (Firebase Auth/Firestore), and all API/file calls
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/files/")) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.pathname.startsWith("/assets/atelier/")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
