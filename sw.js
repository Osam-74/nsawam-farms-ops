// ═══════════════════════════════════════════════════════════════
//  NSAWAM FARMS — Service Worker v4
//  Reliable background notifications using:
//  1. periodicsync (Chrome Android — best option)
//  2. push event (if server push ever added)
//  3. Self-scheduled via setTimeout chains on SW wake
//  4. IndexedDB stores alarms so they survive SW restarts
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME = 'nsawam-ops-v4';

// ── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(['index.html', 'manifest.json']))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // On activate, immediately schedule next alarm from IDB
        return scheduleNextFromIDB();
      })
  );
});

// ── FETCH ─────────────────────────────────────────────────────
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

// ── NOTIFICATION CLICK ────────────────────────────────────────
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

// ── PUSH (future server push) ─────────────────────────────────
self.addEventListener('push', event => {
  const d = event.data ? event.data.json() : { title: 'Nsawam Farms', body: 'Farm reminder.' };
  event.waitUntil(showNotif(d.title, d.body, d.tag || 'push'));
});

// ── PERIODIC SYNC (Chrome Android) ───────────────────────────
// Wakes the SW periodically even when app is closed
self.addEventListener('periodicsync', event => {
  if (event.tag === 'nsawam-alarms') {
    event.waitUntil(checkAlarmsFromIDB());
  }
});

// ── MESSAGES FROM MAIN THREAD ─────────────────────────────────
self.addEventListener('message', event => {
  const d = event.data;
  if (!d) return;

  if (d.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (d.type === 'SHOW_NOTIFICATION') {
    showNotif(d.title, d.body, d.tag || ('n-' + Date.now()));
  }

  // Main thread sends full alarm list whenever app opens or alarms change
  if (d.type === 'SET_ALARMS') {
    event.waitUntil(
      saveAlarmsToIDB(d.alarms || []).then(() => {
        checkAlarmsFromIDB();      // check immediately
        scheduleNextFromIDB();     // set a setTimeout for the next one
      })
    );
  }
});

// ═══════════════════════════════════════════════════════════════
//  INDEXEDDB HELPERS
//  Stores alarms so they persist across SW restarts
// ═══════════════════════════════════════════════════════════════

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nsawam-alarms', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('alarms')) {
        db.createObjectStore('alarms', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('fired')) {
        db.createObjectStore('fired', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function saveAlarmsToIDB(alarms) {
  const db = await openIDB();
  const tx = db.transaction('alarms', 'readwrite');
  const store = tx.objectStore('alarms');
  // Clear old, write new
  store.clear();
  alarms.forEach(a => store.put(a));
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

async function getAlarmsFromIDB() {
  const db = await openIDB();
  const tx = db.transaction('alarms', 'readonly');
  const store = tx.objectStore('alarms');
  return new Promise((res, rej) => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = rej;
  });
}

async function hasFiredToday(key) {
  const db = await openIDB();
  const todayKey = new Date().toISOString().split('T')[0];
  const fullKey = key + '_' + todayKey;
  const tx = db.transaction('fired', 'readonly');
  const store = tx.objectStore('fired');
  return new Promise((res, rej) => {
    const req = store.get(fullKey);
    req.onsuccess = () => res(!!req.result);
    req.onerror = rej;
  });
}

async function markFiredToday(key) {
  const db = await openIDB();
  const todayKey = new Date().toISOString().split('T')[0];
  const fullKey = key + '_' + todayKey;
  const tx = db.transaction('fired', 'readwrite');
  tx.objectStore('fired').put({ key: fullKey, ts: Date.now() });
  // Also clean up keys older than 2 days to prevent bloat
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

// ═══════════════════════════════════════════════════════════════
//  ALARM CHECK — runs from IDB, safe even after SW restart
// ═══════════════════════════════════════════════════════════════

async function checkAlarmsFromIDB() {
  try {
    const alarms = await getAlarmsFromIDB();
    if (!alarms.length) return;

    const now = new Date();
    const nowM = now.getHours() * 60 + now.getMinutes();
    const day = now.getDay(); // 0=Sun,1=Mon...5=Fri,6=Sat

    for (const alarm of alarms) {
      // Skip Friday-only alarms if not Friday
      if (alarm.fridayOnly && day !== 5) continue;
      // Skip day-specific alarms
      if (alarm.dayOnly !== undefined && alarm.dayOnly !== day) continue;

      const alarmM = parseInt(alarm.h) * 60 + parseInt(alarm.m);
      const diff = nowM - alarmM;

      // Fire if we're within a 3-minute window of the alarm (accounts for SW wake delay)
      if (diff >= 0 && diff < 3) {
        const alreadyFired = await hasFiredToday(alarm.id);
        if (!alreadyFired) {
          await markFiredToday(alarm.id);
          await showNotif(alarm.title || 'Nsawam Farms', alarm.body, 'alarm-' + alarm.id);
          // Notify all open clients to update log
          const clientList = await self.clients.matchAll();
          clientList.forEach(c => c.postMessage({ type: 'ALARM_FIRED', alarm }));
        }
      }
    }
  } catch(e) {
    console.warn('[SW] checkAlarmsFromIDB error:', e);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SELF-SCHEDULING — keeps SW alive by scheduling next alarm
//  This is the KEY trick: instead of setInterval (which dies),
//  we use a setTimeout that re-fires checkAlarms, which in turn
//  schedules the NEXT one. The SW stays alive for each setTimeout.
// ═══════════════════════════════════════════════════════════════

let _scheduleTimer = null;

async function scheduleNextFromIDB() {
  try {
    const alarms = await getAlarmsFromIDB();
    if (!alarms.length) return;

    const now = new Date();
    const nowM = now.getHours() * 60 + now.getMinutes();
    const day = now.getDay();

    // Find the next alarm that hasn't fired today and is in the future
    let soonestMs = null;

    for (const alarm of alarms) {
      if (alarm.fridayOnly && day !== 5) continue;
      if (alarm.dayOnly !== undefined && alarm.dayOnly !== day) continue;

      const alarmM = parseInt(alarm.h) * 60 + parseInt(alarm.m);
      const msUntil = (alarmM - nowM) * 60 * 1000;

      if (msUntil > 0) {
        const alreadyFired = await hasFiredToday(alarm.id);
        if (!alreadyFired) {
          if (soonestMs === null || msUntil < soonestMs) {
            soonestMs = msUntil;
          }
        }
      }
    }

    if (soonestMs !== null) {
      // Fire slightly early then check (accounts for JS timer drift)
      const fireAt = Math.max(soonestMs - 5000, 1000);
      if (_scheduleTimer) clearTimeout(_scheduleTimer);
      _scheduleTimer = setTimeout(async () => {
        await checkAlarmsFromIDB();
        await scheduleNextFromIDB(); // chain to next alarm
      }, fireAt);
    }
  } catch(e) {
    console.warn('[SW] scheduleNextFromIDB error:', e);
  }
}

// ── SHOW NOTIFICATION ─────────────────────────────────────────
function showNotif(title, body, tag) {
  return self.registration.showNotification(title, {
    body,
    tag: tag || ('n-' + Date.now()),
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 300],
    icon: 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<rect width="100" height="100" rx="20" fill="#1a3a1a"/>' +
      '<text y="78" x="8" font-size="80">🌿</text></svg>'
    ),
    badge: 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
      '<rect width="96" height="96" rx="16" fill="#1a3a1a"/>' +
      '<text y="72" x="6" font-size="76">🌿</text></svg>'
    ),
    actions: [
      { action: 'open', title: '📋 Open App' },
      { action: 'dismiss', title: '✕ Dismiss' }
    ]
  });
}

// ── BOOT: run check immediately when SW starts ────────────────
// This handles the case where the SW was dormant and just woke up
checkAlarmsFromIDB().then(() => scheduleNextFromIDB());
