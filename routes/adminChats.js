const express = require('express');
const router = express.Router();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { adminAuth } = require('./adminAuth');
const { getSetting } = require('../config/settingsManager');
const { getVersionInfo, getVersionBadge } = require('../config/version-utils');
const {
    getAdminInboxConversations,
    getParticipant,
    getMessages,
    sendMessageToConversation,
    markConversationReadByAdmin,
    deleteConversation
} = require('../config/roleChatManager');
const { notifyCustomer, notifyAgents, notifyCollectors, notifyTechnicians } = require('../config/pushEventNotifier');

const db = new sqlite3.Database(path.join(__dirname, '../data/billing.db'));

function getTechnicianConversations() {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT t.id, t.name, t.phone, t.role, t.profile_photo,
                   MAX(m.id) AS latest_id,
                   SUM(CASE WHEN m.sender_role = 'technician' AND m.is_read = 0 THEN 1 ELSE 0 END) AS unread_count
            FROM technicians t
            LEFT JOIN technician_chat_messages m ON m.technician_id = t.id
            GROUP BY t.id
            HAVING latest_id IS NOT NULL
            ORDER BY latest_id DESC
        `, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function getLatestTechnicianMessage(latestId) {
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT message, sender_role, created_at
            FROM technician_chat_messages
            WHERE id = ?
        `, [latestId], (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
        });
    });
}

function formatTechnicianConversationLink(technicianId) {
    return `/admin/technicians/${technicianId}/chat`;
}

router.get('/chats/targets/:role', adminAuth, async (req, res) => {
    try {
        const role = String(req.params.role || '').toLowerCase();
        const q = `%${String(req.query.q || '').trim()}%`;
        let rows = [];

        if (role === 'customer') {
            rows = await new Promise((resolve, reject) => {
                db.all(`
                    SELECT id, name, username, phone, profile_photo
                    FROM customers
                    WHERE name LIKE ? OR username LIKE ? OR phone LIKE ?
                    ORDER BY name ASC
                    LIMIT 40
                `, [q, q, q], (err, result) => err ? reject(err) : resolve(result || []));
            });
        } else if (role === 'agent') {
            rows = await new Promise((resolve, reject) => {
                db.all(`
                    SELECT id, name, username, phone, profile_photo
                    FROM agents
                    WHERE name LIKE ? OR username LIKE ? OR phone LIKE ?
                    ORDER BY name ASC
                    LIMIT 40
                `, [q, q, q], (err, result) => err ? reject(err) : resolve(result || []));
            });
        } else if (role === 'collector') {
            rows = await new Promise((resolve, reject) => {
                db.all(`
                    SELECT id, name, phone, profile_photo
                    FROM collectors
                    WHERE name LIKE ? OR phone LIKE ?
                    ORDER BY name ASC
                    LIMIT 40
                `, [q, q], (err, result) => err ? reject(err) : resolve(result || []));
            });
        } else if (role === 'technician') {
            rows = await new Promise((resolve, reject) => {
                db.all(`
                    SELECT id, name, phone, profile_photo
                    FROM technicians
                    WHERE name LIKE ? OR phone LIKE ?
                    ORDER BY name ASC
                    LIMIT 40
                `, [q, q], (err, result) => err ? reject(err) : resolve(result || []));
            });
        } else {
            return res.status(400).json({ success: false, message: 'Role tidak valid' });
        }

        res.json({
            success: true,
            targets: rows.map((row) => ({
                id: String(row.id),
                name: row.name || role,
                subtitle: row.username || row.phone || '',
                profile_photo: row.profile_photo || '',
                link: role === 'technician' ? formatTechnicianConversationLink(row.id) : `/admin/chats/${role}/${row.id}`
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/chats', adminAuth, async (req, res) => {
    try {
        const roleConversations = await getAdminInboxConversations();
        const technicianRows = await getTechnicianConversations();
        const technicianConversations = await Promise.all(technicianRows.map(async (row) => {
            const latest = await getLatestTechnicianMessage(row.latest_id);
            return {
                role: 'technician',
                userId: String(row.id),
                participant: {
                    id: String(row.id),
                    name: row.name || 'Teknisi',
                    subtitle: row.phone || '',
                    profile_photo: row.profile_photo || '',
                    role: 'technician'
                },
                lastMessage: latest?.message || '',
                lastSenderRole: latest?.sender_role || 'technician',
                createdAt: latest?.created_at || null,
                unreadCount: Number(row.unread_count || 0),
                link: `/admin/technicians/${row.id}/chat`
            };
        }));

        const conversations = [...roleConversations, ...technicianConversations]
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

        res.render('admin/chat-center', {
            title: 'Chat Center',
            page: 'chats',
            conversations,
            settings: {
                logo_filename: getSetting('logo_filename', 'logo.png'),
                company_header: getSetting('company_header', 'GEMBOK')
            },
            versionInfo: getVersionInfo(),
            versionBadge: getVersionBadge()
        });
    } catch (error) {
        res.status(500).send(`Gagal memuat chat center: ${error.message}`);
    }
});

router.get('/chats/:role/:id', adminAuth, async (req, res) => {
    try {
        const role = String(req.params.role || '').toLowerCase();
        const userId = String(req.params.id || '');

        if (!['customer', 'agent', 'collector'].includes(role)) {
            return res.redirect('/admin/chats');
        }

        const participant = await getParticipant(role, userId);
        if (!participant) {
            return res.status(404).send('Percakapan tidak ditemukan');
        }

        res.render('admin/role-chat', {
            title: `Chat ${participant.name}`,
            page: 'chats',
            role,
            participant,
            settings: {
                logo_filename: getSetting('logo_filename', 'logo.png'),
                company_header: getSetting('company_header', 'GEMBOK')
            },
            versionInfo: getVersionInfo(),
            versionBadge: getVersionBadge()
        });
    } catch (error) {
        res.status(500).send(`Gagal memuat chat: ${error.message}`);
    }
});

router.get('/chats/:role/:id/messages', adminAuth, async (req, res) => {
    try {
        const role = String(req.params.role || '').toLowerCase();
        const userId = String(req.params.id || '');
        await markConversationReadByAdmin(role, userId);
        const messages = await getMessages(role, userId, 200);
        res.json({ success: true, messages });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.delete('/chats/:role/:id', adminAuth, async (req, res) => {
    try {
        const role = String(req.params.role || '').toLowerCase();
        const userId = String(req.params.id || '');

        if (role === 'technician') {
            await new Promise((resolve, reject) => {
                db.run('DELETE FROM technician_chat_messages WHERE technician_id = ?', [userId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            return res.json({ success: true });
        }

        if (!['customer', 'agent', 'collector'].includes(role)) {
            return res.status(400).json({ success: false, message: 'Role tidak valid' });
        }

        await deleteConversation(role, userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/chats/:role/:id/messages', adminAuth, async (req, res) => {
    try {
        const role = String(req.params.role || '').toLowerCase();
        const userId = String(req.params.id || '');
        const message = String(req.body?.message || '').trim();

        if (!message) {
            return res.status(400).json({ success: false, message: 'Pesan tidak boleh kosong' });
        }

        await sendMessageToConversation({
            targetRole: role,
            targetUserId: userId,
            senderRole: 'admin',
            senderUserId: req.session?.adminUser || 'admin',
            message
        });

        const participant = await getParticipant(role, userId);
        const notification = {
            title: 'Pesan baru dari admin',
            message: `${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`,
            link: `/${role}/chat`,
            type: 'chat'
        };

        if (role === 'customer' && participant) {
            await Promise.allSettled([
                notifyCustomer(notification, {
                    username: participant.subtitle,
                    phone: participant.subtitle
                }),
                notifyTechnicians({
                    title: 'Percakapan customer diperbarui',
                    message: `${participant.name || 'Pelanggan'} menerima balasan admin.`,
                    link: `/technician/chat/customer/${userId}`,
                    type: 'chat'
                })
            ]);
        } else if (role === 'agent') {
            await notifyAgents(notification, [userId]);
        } else if (role === 'collector') {
            await notifyCollectors(notification, [userId]);
        }

        const messages = await getMessages(role, userId, 200);
        res.json({ success: true, messages });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
