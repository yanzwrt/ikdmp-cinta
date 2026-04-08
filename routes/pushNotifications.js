const express = require('express');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { getVapidKeys, saveSubscription, removeSubscription } = require('../config/pushNotificationManager');

const router = express.Router();
const dbPath = path.join(__dirname, '../data/billing.db');
const db = new sqlite3.Database(dbPath);

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

async function resolveCurrentUser(req) {
    if (req.session?.isAdmin) {
        return { role: 'admin', userKey: String(req.session.adminUser || 'admin') };
    }

    if (req.session?.agentId) {
        return { role: 'agent', userKey: String(req.session.agentId) };
    }

    if (req.session?.customer_username || req.session?.customer_phone || req.session?.phone) {
        return { role: 'customer', userKey: String(req.session.customer_username || req.session.customer_phone || req.session.phone) };
    }

    if (req.session?.collectorToken) {
        try {
            const decoded = jwt.verify(req.session.collectorToken, process.env.JWT_SECRET || 'your-secret-key');
            return { role: 'collector', userKey: String(decoded.id) };
        } catch (error) {
            return null;
        }
    }

    if (req.session?.technicianSessionId) {
        const row = await dbGet(`
            SELECT technician_id
            FROM technician_sessions
            WHERE session_id = ? AND expires_at > datetime('now')
            LIMIT 1
        `, [req.session.technicianSessionId]);
        if (row?.technician_id) {
            return { role: 'technician', userKey: String(row.technician_id) };
        }
    }

    return null;
}

router.get('/public-key', async (req, res) => {
    const keys = getVapidKeys();
    res.json({
        success: true,
        publicKey: keys.publicKey || '',
        enabled: Boolean(keys.publicKey && keys.privateKey)
    });
});

router.post('/subscribe', async (req, res) => {
    try {
        const currentUser = await resolveCurrentUser(req);
        if (!currentUser) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { subscription } = req.body || {};
        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ success: false, message: 'Subscription tidak valid' });
        }

        await saveSubscription({
            role: currentUser.role,
            userKey: currentUser.userKey,
            subscription,
            userAgent: req.get('User-Agent') || ''
        });

        res.json({
            success: true,
            role: currentUser.role,
            userKey: currentUser.userKey
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/unsubscribe', async (req, res) => {
    try {
        const { endpoint } = req.body || {};
        if (!endpoint) {
            return res.status(400).json({ success: false, message: 'Endpoint wajib diisi' });
        }
        await removeSubscription(endpoint);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
