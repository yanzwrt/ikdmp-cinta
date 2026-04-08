const express = require('express');
const router = express.Router();
const { adminAuth } = require('./adminAuth');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const { getDevices } = require('../config/genieacs');
const {
  getActivePPPoEConnections,
  getInactivePPPoEUsers,
  getActiveHotspotUsers
} = require('../config/mikrotik');
const { getSettingsWithCache } = require('../config/settingsManager');
const { getVersionInfo, getVersionBadge } = require('../config/version-utils');
const { getAllTroubleReports } = require('../config/troubleReport');

const dbPath = path.join(__dirname, '../data/billing.db');
const db = new sqlite3.Database(dbPath);

async function getDashboardStatusSnapshot() {
  let genieacsTotal = 0;
  let genieacsOnline = 0;
  let genieacsOffline = 0;
  let mikrotikTotal = 0;
  let mikrotikAktif = 0;
  let mikrotikOffline = 0;
  let hotspotAktif = 0;
  let settings = {};

  try {
    settings = getSettingsWithCache();

    try {
      const devices = await Promise.race([
        getDevices(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('GenieACS timeout')), 10000))
      ]);

      genieacsTotal = devices.length;
      const now = Date.now();
      genieacsOnline = devices.filter(dev => dev._lastInform && (now - new Date(dev._lastInform).getTime()) < 3600 * 1000).length;
      genieacsOffline = genieacsTotal - genieacsOnline;
    } catch (genieacsError) {
      console.warn('[DASHBOARD] GenieACS tidak dapat diakses - menggunakan data default:', genieacsError.message);
    }

    try {
      const aktifResult = await Promise.race([
        getActivePPPoEConnections(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Mikrotik timeout')), 5000))
      ]);
      mikrotikAktif = aktifResult.success ? aktifResult.data.length : 0;

      const offlineResult = await Promise.race([
        getInactivePPPoEUsers(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Mikrotik timeout')), 5000))
      ]);
      mikrotikOffline = offlineResult.success ? offlineResult.totalInactive : 0;
      mikrotikTotal = offlineResult.success ? offlineResult.totalSecrets : 0;

      const hotspotResult = await Promise.race([
        getActiveHotspotUsers(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Mikrotik timeout')), 10000))
      ]);
      hotspotAktif = hotspotResult.success ? hotspotResult.data.length : 0;
    } catch (mikrotikError) {
      console.warn('[DASHBOARD] Mikrotik tidak dapat diakses - menggunakan data default:', mikrotikError.message);
    }
  } catch (error) {
    console.error('[DASHBOARD] Error in dashboard snapshot:', error);
  }

  return {
    genieacsTotal,
    genieacsOnline,
    genieacsOffline,
    mikrotikTotal,
    mikrotikAktif,
    mikrotikOffline,
    hotspotAktif,
    settings
  };
}

async function buildDashboardNotifications({ genieacsOffline = 0, mikrotikOffline = 0 } = {}) {
  const dashboardNotifications = [];

  try {
    const allTroubleReports = getAllTroubleReports();
    const activeTroubleReports = allTroubleReports
      .filter(report => ['open', 'in_progress'].includes(report.status))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

    if (activeTroubleReports.length > 0) {
      const latestTrouble = activeTroubleReports[0];
      dashboardNotifications.push({
        id: 'trouble-reports',
        type: 'danger',
        icon: 'bi-exclamation-triangle-fill',
        title: 'Laporan Gangguan Masuk',
        message: `${activeTroubleReports.length} laporan aktif. Terbaru: ${latestTrouble.name || 'Pelanggan'} - ${latestTrouble.category || 'Gangguan jaringan'}`,
        meta: latestTrouble.id || 'Perlu tindak lanjut',
        link: '/admin/trouble'
      });
    }
  } catch (troubleError) {
    console.warn('[DASHBOARD] Gagal memuat notifikasi trouble report:', troubleError.message);
  }

  if (genieacsOffline > 0) {
    dashboardNotifications.push({
      id: 'genieacs-offline',
      type: 'warning',
      icon: 'bi-wifi-off',
      title: 'Perangkat Offline',
      message: `${genieacsOffline} perangkat GenieACS sedang offline atau lost signal.`,
      meta: 'Monitor perangkat',
      link: '/admin/genieacs'
    });
  }

  if (mikrotikOffline > 0) {
    dashboardNotifications.push({
      id: 'pppoe-logout',
      type: 'info',
      icon: 'bi-person-x-fill',
      title: 'PPPoE Logout',
      message: `${mikrotikOffline} user PPPoE sedang disconnected atau logout.`,
      meta: 'Cek user PPPoE',
      link: '/admin/mikrotik'
    });
  }

  try {
    const unreadChats = await new Promise((resolve, reject) => {
      db.all(`
        SELECT
          t.id,
          t.name,
          COUNT(m.id) as unread_count,
          MAX(m.created_at) as last_message_at
        FROM technician_chat_messages m
        JOIN technicians t ON t.id = m.technician_id
        WHERE m.sender_role = 'technician' AND m.is_read = 0
        GROUP BY t.id, t.name
        ORDER BY datetime(last_message_at) DESC
        LIMIT 5
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    unreadChats.forEach((chatRow) => {
      dashboardNotifications.unshift({
        id: `technician-chat-${chatRow.id}`,
        type: 'primary',
        icon: 'bi-chat-dots-fill',
        title: 'Chat Teknisi',
        message: `${chatRow.name} mengirim ${chatRow.unread_count} pesan yang belum dibaca.`,
        meta: 'Buka percakapan teknisi',
        link: `/admin/technicians/${chatRow.id}/chat`
      });
    });
  } catch (chatError) {
    console.warn('[DASHBOARD] Gagal memuat notifikasi chat teknisi:', chatError.message);
  }

  return dashboardNotifications;
}

router.get('/dashboard', adminAuth, async (req, res) => {
  const {
    genieacsTotal,
    genieacsOnline,
    genieacsOffline,
    mikrotikTotal,
    mikrotikAktif,
    mikrotikOffline,
    hotspotAktif,
    settings
  } = await getDashboardStatusSnapshot();

  const shouldRevalidate = !req.session.configValidation ||
    !req.session.configValidation.hasValidationRun ||
    req.session.configValidation.lastValidationTime < (Date.now() - 30000);

  if (shouldRevalidate) {
    setImmediate(async () => {
      try {
        const {
          validateConfiguration,
          getValidationSummary,
          checkForDefaultSettings
        } = require('../config/configValidator');

        const validationResults = await validateConfiguration();
        const summary = getValidationSummary();
        const defaultSettingsWarnings = checkForDefaultSettings();

        req.session.configValidation = {
          hasValidationRun: true,
          results: validationResults,
          summary,
          defaultSettingsWarnings,
          lastValidationTime: Date.now()
        };
      } catch (error) {
        console.error('[DASHBOARD] Error saat validasi konfigurasi ulang:', error);
      }
    });
  }

  const dashboardNotifications = await buildDashboardNotifications({
    genieacsOffline,
    mikrotikOffline
  });

  res.render('adminDashboard', {
    title: 'Dashboard Admin',
    page: 'dashboard',
    genieacsTotal,
    genieacsOnline,
    genieacsOffline,
    mikrotikTotal,
    mikrotikAktif,
    mikrotikOffline,
    hotspotAktif,
    settings,
    versionInfo: getVersionInfo(),
    versionBadge: getVersionBadge(),
    configValidation: req.session.configValidation || null,
    dashboardNotifications,
    dashboardNotificationCount: dashboardNotifications.length
  });
});

router.get('/dashboard/notifications', adminAuth, async (req, res) => {
  const {
    genieacsOffline,
    mikrotikOffline
  } = await getDashboardStatusSnapshot();

  const dashboardNotifications = await buildDashboardNotifications({
    genieacsOffline,
    mikrotikOffline
  });

  res.json({
    success: true,
    notifications: dashboardNotifications,
    count: dashboardNotifications.length,
    generatedAt: new Date().toISOString()
  });
});

module.exports = router;
