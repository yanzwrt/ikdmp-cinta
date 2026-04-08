// No-cache mode for Agent PWA
self.addEventListener('install', function() {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  console.log('Agent Service Worker: Activate (no cache mode)');
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
  if (event.request.method !== 'GET') {
    return;
  }

  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') {
    return;
  }

  event.respondWith(fetch(event.request, { cache: 'no-store' }));
});

// Background sync for offline transactions
self.addEventListener('sync', function(event) {
  console.log('Agent Service Worker: Background sync', event.tag);

  if (event.tag === 'background-agent-sync') {
    event.waitUntil(syncOfflineAgentData());
  }
});

// Sync offline agent data when back online
function syncOfflineAgentData() {
  return new Promise(function(resolve, reject) {
    // Get offline data from IndexedDB
    const request = indexedDB.open('AgentOfflineDB', 1);

    request.onsuccess = function(event) {
      const db = event.target.result;
      const transaction = db.transaction(['vouchers', 'payments'], 'readonly');

      // Sync offline vouchers
      const voucherStore = transaction.objectStore('vouchers');
      const voucherRequest = voucherStore.getAll();

      voucherRequest.onsuccess = function() {
        const offlineVouchers = voucherRequest.result;

        if (offlineVouchers.length > 0) {
          console.log('Agent Service Worker: Syncing', offlineVouchers.length, 'offline vouchers');

          offlineVouchers.forEach(function(voucher) {
            fetch('/agent/api/vouchers', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(voucher)
            })
            .then(function(response) {
              if (response.ok) {
                // Remove from offline storage
                const deleteTransaction = db.transaction(['vouchers'], 'readwrite');
                const deleteStore = deleteTransaction.objectStore('vouchers');
                deleteStore.delete(voucher.id);
                console.log('Agent Service Worker: Voucher synced successfully');
              }
            })
            .catch(function(error) {
              console.log('Agent Service Worker: Voucher sync failed', error);
            });
          });
        }
      };

      // Sync offline payments
      const paymentStore = transaction.objectStore('payments');
      const paymentRequest = paymentStore.getAll();

      paymentRequest.onsuccess = function() {
        const offlinePayments = paymentRequest.result;

        if (offlinePayments.length > 0) {
          console.log('Agent Service Worker: Syncing', offlinePayments.length, 'offline payments');

          offlinePayments.forEach(function(payment) {
            fetch('/agent/api/payments', {
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
                console.log('Agent Service Worker: Payment synced successfully');
              }
            })
            .catch(function(error) {
              console.log('Agent Service Worker: Payment sync failed', error);
            });
          });
        }
      };

      resolve();
    };

    request.onerror = function() {
      reject(request.error);
    };
  });
}

// Push notification handling
self.addEventListener('push', function(event) {
  console.log('Agent Service Worker: Push received');

  const options = {
    body: event.data ? event.data.text() : 'Transaksi baru tersedia',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {
        action: 'view',
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
    self.registration.showNotification('GEMBOK-BILL Agent', options)
  );
});

// Notification click handling
self.addEventListener('notificationclick', function(event) {
  console.log('Agent Service Worker: Notification click received');

  event.notification.close();

  if (event.action === 'view') {
    event.waitUntil(
      clients.openWindow('/agent/transactions')
    );
  } else if (event.action === 'close') {
    // Just close the notification
  } else {
    // Default action - open dashboard
    event.waitUntil(
      clients.openWindow('/agent/dashboard')
    );
  }
});
