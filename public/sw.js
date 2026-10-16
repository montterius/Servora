// Service Worker - ruleaza "in fundal", separat de pagina. Primeste
// notificarea push (pe telefoanele care o accepta) chiar daca pagina
// nu mai e pe ecran. Sunetul + vibratia principale vin din pagina insasi.

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: '🔔 Servora', body: event.data ? event.data.text() : 'Comanda ta e gata!' }; }

  event.waitUntil(self.registration.showNotification(data.title || '🔔 Comanda ta e gata!', {
    body: data.body || 'Te așteaptă la tejghea.',
    vibrate: [400, 150, 400, 150, 700],
    tag: data.orderId ? ('order-' + data.orderId) : undefined,
    renotify: true,
    requireInteraction: true,
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf('/r') !== -1 && 'focus' in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/r');
    })
  );
});
