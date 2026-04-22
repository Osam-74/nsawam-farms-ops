const CACHE_NAME = 'nsawam-ops-v3';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(['index.html','manifest.json'])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      const net = fetch(event.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      }).catch(() => cached || caches.match('index.html'));
      return cached || net;
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return clients.openWindow('./');
    })
  );
});

self.addEventListener('push', event => {
  const d = event.data ? event.data.json() : { title: 'Nsawam Farms', body: 'Farm reminder.' };
  event.waitUntil(showNotif(d.title, d.body, d.tag || 'push'));
});

// ── ALARM ENGINE ──
// Main thread sends SET_ALARMS with array of {id, h, m, title, body}
// SW checks every 30s and fires if within window
self._alarms = [];
self._firedToday = {};
self._lastFiredDate = '';

function checkAlarms() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  if (self._lastFiredDate !== todayStr) {
    self._firedToday = {};
    self._lastFiredDate = todayStr;
  }
  const nowM = now.getHours() * 60 + now.getMinutes();
  (self._alarms || []).forEach(alarm => {
    const key = alarm.id + '_' + todayStr;
    if (self._firedToday[key]) return;
    const alarmM = parseInt(alarm.h) * 60 + parseInt(alarm.m);
    const diff = nowM - alarmM;
    if (diff >= 0 && diff < 2) {
      self._firedToday[key] = true;
      showNotif(alarm.title || 'Nsawam Farms', alarm.body, 'alarm-' + alarm.id);
      self.clients.matchAll().then(list => list.forEach(c => c.postMessage({ type: 'ALARM_FIRED', alarm })));
    }
  });
}

// Start the interval loop immediately when SW loads
setInterval(checkAlarms, 30000);
checkAlarms();

self.addEventListener('message', event => {
  const d = event.data;
  if (!d) return;
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  if (d.type === 'SHOW_NOTIFICATION') showNotif(d.title, d.body, d.tag || ('n-' + Date.now()));
  if (d.type === 'SET_ALARMS') {
    self._alarms = d.alarms || [];
    checkAlarms(); // check immediately after update
  }
});

function showNotif(title, body, tag) {
  return self.registration.showNotification(title, {
    body, tag, requireInteraction: true, vibrate: [300, 100, 300, 100, 300],
    icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#1a3a1a"/><text y="78" x="8" font-size="80">🌿</text></svg>'),
    actions: [{ action: 'open', title: '📋 Open App' }, { action: 'dismiss', title: '✕ Dismiss' }]
  });
}
