const CACHE_NAME = 'nsawam-ops-v2';
const OFFLINE_URL = 'index.html';
const urlsToCache = [
  'index.html',
  'manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap'
];

// ── INSTALL: cache all assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache.filter(u => !u.startsWith('http'))))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: cache-first with network fallback
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached || caches.match(OFFLINE_URL));
      return cached || networkFetch;
    })
  );
});

// ── BACKGROUND PUSH NOTIFICATIONS (from server or self-triggered)
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'Nsawam Farms', body: 'You have a farm reminder.' };
  event.waitUntil(
    self.registration.showNotification(data.title || 'Nsawam Farms', {
      body: data.body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: { url: data.url || '/' },
      actions: [
        { action: 'open', title: '📋 Open App' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    })
  );
});

// ── NOTIFICATION CLICK
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow('/');
    })
  );
});

// ── SELF-SCHEDULED BACKGROUND REMINDERS via periodicsync (if available)
self.addEventListener('periodicsync', event => {
  if (event.tag === 'daily-check') {
    event.waitUntil(checkAndNotify());
  }
});

async function checkAndNotify() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const reminders = [
    { h:7, m:55, msg:'🌅 Read the daily email report from Jalil now!' },
    { h:8, m:55, msg:'📱 Check the Farm App — confirm numbers match the email.' },
    { h:9, m:25, msg:'💬 Message Jalil: health update, overnight issues, morning feed done?' },
    { h:11, m:55, msg:'🥚 Confirm morning egg collection. Update egg count.' },
    { h:17, m:55, msg:'🌇 Confirm afternoon egg collection with Jalil. Update total.' },
    { h:20, m:55, msg:'⚠️ Has Jalil signed off the daily report? If not — call him NOW!' },
  ];
  for (const r of reminders) {
    if (h === r.h && m >= r.m && m < r.m + 10) {
      await self.registration.showNotification('Nsawam Farms Reminder', {
        body: r.msg, requireInteraction: true, vibrate: [200,100,200]
      });
    }
  }
}

// ── SKIP WAITING on message
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  // Scheduled alarm from main thread
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(event.data.title, {
      body: event.data.body,
      requireInteraction: true,
      vibrate: [200, 100, 200],
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌿</text></svg>',
    });
  }
});
