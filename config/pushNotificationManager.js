const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const logger = require('./logger');
const { getSetting } = require('./settingsManager');

let webPush = null;
try {
    webPush = require('web-push');
} catch (error) {
    logger.warn(`web-push belum tersedia: ${error.message}`);
}

const dbPath = path.join(__dirname, '../data/billing.db');
const db = new sqlite3.Database(dbPath);

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function ensurePushSubscriptionTable() {
    return dbRun(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            user_key TEXT NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            subscription_json TEXT NOT NULL,
            user_agent TEXT,
            last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).catch((error) => {
        logger.error(`Gagal memastikan tabel push_subscriptions: ${error.message}`);
    });
}

function getVapidKeys() {
    const publicKey = process.env.VAPID_PUBLIC_KEY || getSetting('push_vapid_public_key', '');
    const privateKey = process.env.VAPID_PRIVATE_KEY || getSetting('push_vapid_private_key', '');
    const subject = process.env.VAPID_SUBJECT || getSetting('push_vapid_subject', 'mailto:admin@example.com');

    return {
        publicKey: String(publicKey || '').trim(),
        privateKey: String(privateKey || '').trim(),
        subject: String(subject || 'mailto:admin@example.com').trim()
    };
}

function configureWebPush() {
    if (!webPush) return false;

    const { publicKey, privateKey, subject } = getVapidKeys();
    if (!publicKey || !privateKey) return false;

    try {
        webPush.setVapidDetails(subject, publicKey, privateKey);
        return true;
    } catch (error) {
        logger.error(`Gagal set VAPID details: ${error.message}`);
        return false;
    }
}

async function saveSubscription({ role, userKey, subscription, userAgent = '' }) {
    await ensurePushSubscriptionTable();

    if (!role || !userKey || !subscription || !subscription.endpoint) {
        throw new Error('Data subscription tidak lengkap');
    }

    const payload = JSON.stringify(subscription);

    await dbRun(`
        INSERT INTO push_subscriptions (role, user_key, endpoint, subscription_json, user_agent, last_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(endpoint) DO UPDATE SET
            role = excluded.role,
            user_key = excluded.user_key,
            subscription_json = excluded.subscription_json,
            user_agent = excluded.user_agent,
            last_seen_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
    `, [role, userKey, subscription.endpoint, payload, userAgent || '']);
}

async function removeSubscription(endpoint) {
    if (!endpoint) return;
    await ensurePushSubscriptionTable();
    await dbRun('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

async function getSubscriptionsByRole(role, userKey = null) {
    await ensurePushSubscriptionTable();
    if (userKey) {
        return dbAll('SELECT * FROM push_subscriptions WHERE role = ? AND user_key = ?', [role, userKey]);
    }
    return dbAll('SELECT * FROM push_subscriptions WHERE role = ?', [role]);
}

async function sendPushToSubscriptions(subscriptions = [], notification = {}) {
    if (!configureWebPush()) {
        return { success: false, message: 'VAPID key belum dikonfigurasi', sent: 0 };
    }

    const payload = JSON.stringify({
        title: notification.title || 'Notifikasi Baru',
        body: notification.body || notification.message || '',
        url: notification.url || notification.link || '/',
        tag: notification.tag || notification.id || `notif-${Date.now()}`,
        icon: notification.icon || '/img/logo.png',
        badge: notification.badge || '/img/logo.png',
        role: notification.role || '',
        data: notification.data || {}
    });

    let sent = 0;
    for (const row of subscriptions) {
        try {
            const subscription = JSON.parse(row.subscription_json);
            await webPush.sendNotification(subscription, payload);
            sent += 1;
        } catch (error) {
            logger.warn(`Push gagal ke ${row.endpoint}: ${error.message}`);
            if (error?.statusCode === 404 || error?.statusCode === 410) {
                await removeSubscription(row.endpoint).catch(() => {});
            }
        }
    }

    return { success: sent > 0, sent };
}

module.exports = {
    ensurePushSubscriptionTable,
    getVapidKeys,
    saveSubscription,
    removeSubscription,
    getSubscriptionsByRole,
    sendPushToSubscriptions
};
