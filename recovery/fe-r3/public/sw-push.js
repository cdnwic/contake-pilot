/* Contake web-push service worker (PR-4, spec §4-§6). Shared by Control Tower
 * (minimal push-only registration) and the Focus PWA (push + click handling).
 * - push: display the dispatcher payload as-is (title/body rendered server-side
 *   from the existing allowlisted templates — the SW never interpolates).
 * - notificationclick: open/focus the app and navigate by payload.data.url HINT
 *   (PR-3 mapping). Graph state arrives via the app's normal versioned resync
 *   (RT-PIN-3/5) — payload data is never trusted for state.
 * - pushsubscriptionchange: silent re-register (spec §2) using the context the
 *   page mirrored into IndexedDB (SWs cannot read localStorage); without a
 *   session, ask open pages to re-register instead.
 */
'use strict';

var IDB_NAME = 'contake-push';

function idbGet(key) {
  return new Promise(function (res) {
    try {
      var r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains('kv')) { db.close(); res(undefined); return; }
        var g = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        g.onsuccess = function () { res(g.result); };
        g.onerror = function () { db.close(); res(undefined); };
        g.onsuccess = function () { db.close(); res(g.result); };
      };
      r.onerror = function () { res(undefined); };
    } catch (e) { res(undefined); }
  });
}

function urlBase64ToUint8Array(base64) {
  var padding = '='.repeat((4 - (base64.length % 4)) % 4);
  var b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  var raw = atob(b64);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

self.addEventListener('push', function (event) {
  var p = {};
  try { p = event.data ? event.data.json() : {}; }
  catch (e) { p = { title: 'Contake', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(p.title || 'Contake', {
    body: p.body || '',
    icon: p.icon || '/icons/push-192.png',
    badge: p.badge || '/icons/badge-96.png',
    dir: 'rtl',
    lang: 'he',
    data: p.data || {},
  }));
});

/* payload.data.url is a navigation HINT only: same-origin relative paths, else
 * fall back to the Control Tower default. Never navigate to an absolute URL. */
function safeUrl(u) {
  if (typeof u !== 'string' || !u) return './#/tower';
  if (u.charAt(0) === '#' ) return './' + u;
  if (u.indexOf('./') === 0) return u;
  if (u.charAt(0) === '/' && u.charAt(1) !== '/') return '.' + u;
  return './#/tower';
}

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async function () {
    var all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    var focusTarget = target.indexOf('focus.html') !== -1;
    var match = null;
    for (var i = 0; i < all.length; i++) {
      var path = new URL(all[i].url).pathname;
      if ((path.indexOf('focus.html') !== -1) === focusTarget) { match = all[i]; break; }
    }
    if (match) {
      await match.focus();
      match.postMessage({ type: 'push-navigate', url: target });
    } else {
      await clients.openWindow(target);
    }
  })());
});

self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil((async function () {
    var token = await idbGet('token');
    var vapid = await idbGet('vapidPublicKey');
    if (!token || !vapid) {
      // No session context (signed out / cleared): an open page re-registers after login.
      var pages = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      pages.forEach(function (c) { c.postMessage({ type: 'push-resubscribe' }); });
      return;
    }
    var apiBase = (await idbGet('apiBase')) || '';
    var sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid),
    });
    await fetch(apiBase + '/v1/push/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.toJSON().keys }),
    });
  })());
});