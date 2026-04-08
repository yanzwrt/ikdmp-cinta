(function () {
  let deferredPrompt = null;

  function getPwaRegistrationConfig() {
    const path = window.location.pathname || '/';

    if (path.startsWith('/admin/')) {
      return { script: '/sw-role-admin.js', scope: '/admin/', role: 'admin', notificationsEndpoint: '/admin/dashboard/notifications' };
    }

    if (path.startsWith('/technician/')) {
      return { script: '/sw-role-technician.js', scope: '/technician/', role: 'technician', notificationsEndpoint: '/technician/notifications/summary' };
    }

    if (path.startsWith('/agent/')) {
      return { script: '/sw-role-agent.js', scope: '/agent/', role: 'agent', notificationsEndpoint: '/agent/api/notifications/summary' };
    }

    if (path.startsWith('/collector/')) {
      return { script: '/sw-role-collector.js', scope: '/collector/', role: 'collector', notificationsEndpoint: '/collector/notifications/summary' };
    }

    if (
      path.startsWith('/customer/') ||
      path === '/' ||
      path === '/login' ||
      path.startsWith('/trouble-report')
    ) {
      return { script: '/sw-role-customer.js', scope: '/customer/', role: 'customer', notificationsEndpoint: '/customer/notifications/summary' };
    }

    return { script: '/sw.js', scope: '/', role: 'guest', notificationsEndpoint: '' };
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }

    return outputArray;
  }

  async function fetchJsonSafe(url, options) {
    try {
      const response = await fetch(url, options);
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  async function ensureNotificationPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      return Notification.permission;
    }

    const promptedKey = 'ikdmp-push-permission-prompted';
    const alreadyPrompted = localStorage.getItem(promptedKey) === '1';
    if (alreadyPrompted && !isStandalone()) {
      return Notification.permission;
    }

    localStorage.setItem(promptedKey, '1');

    try {
      return await Notification.requestPermission();
    } catch (error) {
      return Notification.permission;
    }
  }

  async function syncPushSubscription(registration, pwaConfig) {
    if (!registration || !('PushManager' in window)) return;

    const keyResponse = await fetchJsonSafe('/api/push/public-key', { credentials: 'same-origin' });
    if (!keyResponse || !keyResponse.enabled || !keyResponse.publicKey) return;

    try {
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyResponse.publicKey)
        });
      }

      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription, role: pwaConfig.role })
      });
    } catch (error) {
      console.warn('PWA push subscribe gagal', error);
    }
  }

  function getNotificationStoreKey(role) {
    return `ikdmp-system-notified:${role}`;
  }

  function getStoredNotificationMap(role) {
    try {
      return JSON.parse(localStorage.getItem(getNotificationStoreKey(role)) || '{}');
    } catch (error) {
      return {};
    }
  }

  function saveStoredNotificationMap(role, map) {
    localStorage.setItem(getNotificationStoreKey(role), JSON.stringify(map || {}));
  }

  async function showSystemNotifications(registration, pwaConfig) {
    if (!registration || !pwaConfig.notificationsEndpoint || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const payload = await fetchJsonSafe(pwaConfig.notificationsEndpoint, {
      credentials: 'same-origin',
      cache: 'no-store'
    });

    if (!payload || payload.success === false) return;

    const notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
    const shownMap = getStoredNotificationMap(pwaConfig.role);
    let changed = false;

    for (const item of notifications) {
      if (!item || !item.id) continue;
      const marker = item.updatedAt || item.createdAt || '';
      if (shownMap[item.id] && shownMap[item.id] === marker) continue;

      await registration.showNotification(item.title || 'Notifikasi Baru', {
        body: item.message || '',
        icon: '/img/logo.png',
        badge: '/img/logo.png',
        tag: `${pwaConfig.role}:${item.id}`,
        data: {
          url: item.link || window.location.pathname,
          notificationId: item.id,
          role: pwaConfig.role
        },
        vibrate: [180, 80, 180],
        silent: false,
        renotify: false
      });

      shownMap[item.id] = marker || new Date().toISOString();
      changed = true;
    }

    if (changed) {
      saveStoredNotificationMap(pwaConfig.role, shownMap);
    }
  }

  function startRoleNotificationPolling(registration, pwaConfig) {
    if (!pwaConfig.notificationsEndpoint) return;

    showSystemNotifications(registration, pwaConfig).catch(() => {});
    window.setInterval(() => {
      showSystemNotifications(registration, pwaConfig).catch(() => {});
    }, 30000);
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  function getInstallElements() {
    const container = document.getElementById('manual-install-container');
    const manualButton = document.getElementById('manual-install-btn');
    const dataButton = document.querySelector('[data-install-app]');
    const statusText = document.querySelector('[data-install-status]');

    return {
      container,
      button: manualButton || dataButton,
      statusText,
      isDataButton: !manualButton && !!dataButton
    };
  }

  function setInstallState(installed) {
    const { container, button, statusText, isDataButton } = getInstallElements();

    if (container) {
      container.style.display = 'block';
    }

    if (button) {
      button.style.display = 'inline-flex';
      button.dataset.installed = installed ? 'true' : 'false';

      if (installed) {
        button.textContent = 'Aplikasi Sudah Terinstall';
        button.classList.add('installed');
        button.disabled = false;
        if (isDataButton) {
          button.style.opacity = '0.92';
        }
      } else {
        button.textContent = 'Install Aplikasi';
        button.classList.remove('installed');
        button.disabled = false;
      }
    }

    if (statusText) {
      statusText.textContent = installed
        ? 'Aplikasi sudah terinstall di perangkat ini.'
        : 'Install aplikasi untuk akses lebih cepat.';
    }
  }

  function showButton() {
    if (isStandalone()) {
      setInstallState(true);
      return;
    }

    setInstallState(false);
  }

  function showPendingButton() {
    const { container, button, statusText } = getInstallElements();

    if (container) {
      container.style.display = 'block';
    }

    if (button) {
      button.style.display = 'inline-flex';
      button.textContent = 'Cek Install Aplikasi';
      button.classList.remove('installed');
      button.disabled = false;
      button.dataset.installed = 'false';
    }

    if (statusText) {
      statusText.textContent = 'Browser belum menyiapkan prompt install. Coba tunggu sebentar atau gunakan menu browser bila tombol install belum aktif.';
    }
  }

  function hideButton() {
    const { container, button, statusText, isDataButton } = getInstallElements();

    if (container) {
      container.style.display = 'none';
    }

    if (button && isDataButton) {
      button.style.display = 'none';
    }

    if (statusText) {
      statusText.textContent = '';
    }
  }

  async function installApp() {
    deferredPrompt = deferredPrompt || window.__deferredInstallPrompt || null;

    if (isStandalone()) {
      alert('Aplikasi sudah terinstall di perangkat ini.');
      setInstallState(true);
      return;
    }

    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      window.__deferredInstallPrompt = null;
      return;
    }

    // iOS tidak mendukung beforeinstallprompt
    if (isIos()) {
      alert('Untuk iPhone/iPad: tap Share lalu pilih Add to Home Screen.');
      return;
    }

    alert('Install aplikasi belum bisa dimunculkan otomatis di browser ini. Silakan buka menu browser lalu pilih "Tambahkan ke layar utama" atau "Install app".');
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    window.__deferredInstallPrompt = event;
    showButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    window.__deferredInstallPrompt = null;
    setInstallState(true);
    alert('Aplikasi berhasil terinstall.');
  });

  document.addEventListener('DOMContentLoaded', () => {
    const { container, button } = getInstallElements();
    const pwaConfig = getPwaRegistrationConfig();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(
          registrations
            .filter((registration) => {
              const scriptUrl = registration.active?.scriptURL || registration.installing?.scriptURL || registration.waiting?.scriptURL || '';
              return /\/sw-(agent|collector)\.js$/i.test(scriptUrl);
            })
            .map((registration) => registration.unregister())
        ))
        .catch((err) => {
          console.warn('PWA: Failed to cleanup legacy service workers', err);
        })
        .finally(() => {
          navigator.serviceWorker.register(pwaConfig.script, { scope: pwaConfig.scope })
            .then(async (registration) => {
              const permission = await ensureNotificationPermission();
              if (permission === 'granted') {
                await syncPushSubscription(registration, pwaConfig);
                startRoleNotificationPolling(registration, pwaConfig);
              }
            })
            .catch((err) => {
              console.error('PWA: Service Worker registration failed', err);
            });
        });
    }

    if (!container && !button) {
      return;
    }

    if (isStandalone()) {
      setInstallState(true);
      return;
    }

    if (button) {
      button.onclick = installApp;
    }

    if (window.__deferredInstallPrompt) {
      deferredPrompt = window.__deferredInstallPrompt;
      showButton();
    } else {
      hideButton();
    }

    setTimeout(() => {
      if (!isStandalone() && !window.__deferredInstallPrompt) {
        showPendingButton();
      }
    }, 3500);
  });
})();
