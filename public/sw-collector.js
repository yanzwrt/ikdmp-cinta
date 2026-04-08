// No-cache mode for Collector PWA
self.addEventListener('install', function() {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  console.log('Service Worker: Activate (no cache mode)');
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(cacheNames.map(function(cacheName) {
        return caches.delete(cacheName);
      }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;

  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

  event.respondWith(fetch(event.request, { cache: 'no-store' }));
});

// Background sync for offline payments
self.addEventListener('sync', function(event) {
  console.log('Service Worker: Background sync', event.tag);

  if (event.tag === 'background-payment-sync') {
    event.waitUntil(syncOfflinePayments());
  }
});

// Sync offline payments when back online
function syncOfflinePayments() {
  return new Promise(function(resolve, reject) {
    // Get offline payments from IndexedDB
    const request = indexedDB.open('CollectorOfflineDB', 1);

    request.onsuccess = function(event) {
      const db = event.target.result;
      const transaction = db.transaction(['payments'], 'readonly');
      const store = transaction.objectStore('payments');
      const getAllRequest = store.getAll();

      getAllRequest.onsuccess = function() {
        const offlinePayments = getAllRequest.result;

        if (offlinePayments.length > 0) {
          console.log('Service Worker: Syncing', offlinePayments.length, 'offline payments');

          // Sync each payment
          offlinePayments.forEach(function(payment) {
            fetch('/collector/api/payment', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payment)
            })
            .then(function(response) {
              if (response.ok) {
                // Remove from offline storage
                const deleteTransaction = db.transaction(['payments'], 'readwrite');
                const deleteStore = deleteTransaction.objectStore('payments');
                deleteStore.delete(payment.id);
                console.log('Service Worker: Payment synced successfully');
              }
            })
            .catch(function(error) {
              console.log('Service Worker: Payment sync failed', error);
            });
          });
        }

        resolve();
      };

      getAllRequest.onerror = function() {
        reject(getAllRequest.error);
      };
    };

    request.onerror = function() {
      reject(request.error);
    };
  });
}

// Push notification handling
self.addEventListener('push', function(event) {
  console.log('Service Worker: Push received');

  const options = {
    body: event.data ? event.data.text() : 'Pembayaran baru diterima',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {
        action: 'explore',
        title: 'Lihat Detail',
        icon: '/icons/icon-72x72.png'
      },
      {
        action: 'close',
        title: 'Tutup',
        icon: '/icons/icon-72x72.png'
      }
    ]
  };

  event.waitUntil(
    self.registration.showNotification('GEMBOK-BILL Collector', options)
  );
});

// Notification click handling
self.addEventListener('notificationclick', function(event) {
  console.log('Service Worker: Notification click received');

  event.notification.close();

  if (event.action === 'explore') {
    event.waitUntil(
      clients.openWindow('/collector/payments')
    );
  } else if (event.action === 'close') {
    // Just close the notification
  } else {
    // Default action - open dashboard
    event.waitUntil(
      clients.openWindow('/collector/dashboard')
    );
  }
});
