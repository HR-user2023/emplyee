// 特休假管理系統 - Service Worker
// 只快取「外觀殼」（HTML/JS/圖示），資料一律即時向 Apps Script 拿，不快取 API 回應。

// 匯入 OneSignal 的推播處理邏輯，讓這個 Service Worker 同時支援手機推播通知
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDKWorker.js');

const CACHE_NAME = 'leave-app-shell-v18';
const SHELL_ASSETS = [
  './',
  './index.html',
  './script.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(SHELL_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      return cached || fetch(event.request);
    })
  );
});
