self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Portal v1', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Portal v1';
  const options = {
    body: data.body || '',
    icon: data.icon || '/logo.png',
    badge: data.badge || '/logo.png',
    data: { url: data.url || '/' },
    tag: data.tag || 'portal-status',
    renotify: true
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = new URL(url, self.location.origin).href;

    for (const client of allClients) {
      if (client.url === target && 'focus' in client) return client.focus();
    }

    if (clients.openWindow) return clients.openWindow(target);
  })());
});

