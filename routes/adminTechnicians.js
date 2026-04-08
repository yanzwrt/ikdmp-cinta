const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { getSetting } = require('../config/settingsManager');
const { getVersionInfo, getVersionBadge } = require('../config/version-utils');
const { adminAuth } = require('./adminAuth');
const logger = require('../config/logger');
const { notifyTechnicians } = require('../config/pushEventNotifier');

function normalizePhone(phone = '') {
    let p = String(phone).replace(/\D/g, '');

    if (p.startsWith('0')) {
        p = '62' + p.slice(1);
    } else if (!p.startsWith('62')) {
        p = '62' + p;
    }

    return p;
}

// Database connection
const dbPath = path.join(__dirname, '../data/billing.db');
const db = new sqlite3.Database(dbPath);

db.run(`
    CREATE TABLE IF NOT EXISTS technician_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        technician_id INTEGER NOT NULL,
        sender_role TEXT NOT NULL,
        sender_id TEXT,
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        read_at DATETIME
    )
`);

/**
 * GET /admin/technicians - Halaman manajemen teknisi
 */
router.get('/', adminAuth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const offset = (page - 1) * limit;
        const statusFilter = (req.query.status || '').toLowerCase() === 'all' ? 'all' : 'active';

        const technicians = await new Promise((resolve, reject) => {
            const query = `
                SELECT id, name, phone, role, is_active, created_at, last_login, area_coverage, join_date, whatsapp_group_id
                FROM technicians
                ${statusFilter === 'active' ? 'WHERE is_active = 1' : ''}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
            `;
            const params = [limit, offset];
            db.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        const totalTechnicians = await new Promise((resolve, reject) => {
            const sql = statusFilter === 'active'
                ? 'SELECT COUNT(*) as count FROM technicians WHERE is_active = 1'
                : 'SELECT COUNT(*) as count FROM technicians';
            db.get(sql, [], (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        const stats = await new Promise((resolve, reject) => {
            db.all(`
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
                    SUM(CASE WHEN role = 'technician' THEN 1 ELSE 0 END) as technician,
                    SUM(CASE WHEN role = 'field_officer' THEN 1 ELSE 0 END) as field_officer,
                    SUM(CASE WHEN role = 'collector' THEN 1 ELSE 0 END) as collector
                FROM technicians
            `, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows[0] || {});
            });
        });

        const unreadChatRows = await new Promise((resolve, reject) => {
            db.all(`
                SELECT technician_id, COUNT(*) as unread_count
                FROM technician_chat_messages
                WHERE sender_role = 'technician' AND is_read = 0
                GROUP BY technician_id
            `, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const unreadMap = new Map(
            unreadChatRows.map((row) => [String(row.technician_id), Number(row.unread_count || 0)])
        );

        const techniciansWithUnread = technicians.map((technician) => ({
            ...technician,
            unread_chat_count: unreadMap.get(String(technician.id)) || 0
        }));

        const totalUnreadChats = techniciansWithUnread.reduce(
            (sum, technician) => sum + Number(technician.unread_chat_count || 0),
            0
        );

        const totalPages = Math.ceil(totalTechnicians / limit);

        res.render('admin/technicians', {
            title: 'Kelola Teknisi - Admin Panel',
            page: 'technicians',
            technicians: techniciansWithUnread,
            stats,
            totalUnreadChats,
            pagination: {
                currentPage: page,
                totalPages,
                totalTechnicians,
                hasNext: page < totalPages,
                hasPrev: page > 1
            },
            filterStatus: statusFilter,
            settings: {
                logo_filename: getSetting('logo_filename', 'logo.png'),
                company_header: getSetting('company_header', 'GEMBOK')
            },
            versionInfo: getVersionInfo(),
            versionBadge: getVersionBadge()
        });

    } catch (error) {
        logger.error('Error loading technicians page:', error);
        res.status(500).send('Internal Server Error');
    }
});

/**
 * POST /admin/technicians/add - Tambah teknisi baru
 */
router.post('/add', adminAuth, async (req, res) => {
    try {
        const { name, phone, role, notes, whatsapp_group_id } = req.body;

        if (!name || !phone || !role) {
            return res.status(400).json({
                success: false,
                message: 'Nama, nomor telepon, dan role wajib diisi'
            });
        }

        const validRoles = ['technician', 'field_officer', 'collector'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({
                success: false,
                message: 'Role tidak valid'
            });
        }

        const cleanPhone = normalizePhone(phone);

        const existingTechnician = await new Promise((resolve, reject) => {
            db.get('SELECT id FROM technicians WHERE phone = ?', [cleanPhone], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (existingTechnician) {
            return res.status(400).json({
                success: false,
                message: 'Nomor telepon sudah terdaftar'
            });
        }

        const result = await new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO technicians (name, phone, role, area_coverage, whatsapp_group_id, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `;

            db.run(sql, [name, cleanPhone, role, notes || 'Area Default', whatsapp_group_id || null], function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, changes: this.changes });
            });
        });

        if (result.changes > 0) {
            logger.info(`New technician added: ${name} (${cleanPhone}) with role: ${role}`);

            res.json({
                success: true,
                message: 'Teknisi berhasil ditambahkan',
                technician: {
                    id: result.id,
                    name,
                    phone: cleanPhone,
                    role,
                    area_coverage: notes || 'Area Default'
                }
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Gagal menambahkan teknisi'
            });
        }

    } catch (error) {
        logger.error('Error adding technician:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server: ' + error.message
        });
    }
});

/**
 * GET /admin/technicians/:id - Get technician details
 */
router.get('/:id', adminAuth, async (req, res) => {
    try {
        const technicianId = req.params.id;

        const technician = await new Promise((resolve, reject) => {
            db.get('SELECT *, whatsapp_group_id FROM technicians WHERE id = ?', [technicianId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!technician) {
            return res.status(404).json({
                success: false,
                message: 'Teknisi tidak ditemukan'
            });
        }

        res.json({
            success: true,
            technician
        });

    } catch (error) {
        logger.error('Error getting technician details:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server'
        });
    }
});

router.get('/:id/chat/messages', adminAuth, async (req, res) => {
    try {
        const technicianId = req.params.id;
        const messages = await new Promise((resolve, reject) => {
            db.all(
                `
                    SELECT id, technician_id, sender_role, sender_id, message, is_read, created_at, read_at
                    FROM technician_chat_messages
                    WHERE technician_id = ?
                    ORDER BY datetime(created_at) ASC, id ASC
                `,
                [technicianId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });

        await new Promise((resolve, reject) => {
            db.run(
                `
                    UPDATE technician_chat_messages
                    SET is_read = 1, read_at = CURRENT_TIMESTAMP
                    WHERE technician_id = ? AND sender_role = 'technician' AND is_read = 0
                `,
                [technicianId],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });

        res.json({ success: true, messages });
    } catch (error) {
        logger.error('Error loading admin technician chat:', error);
        res.status(500).json({ success: false, message: 'Gagal memuat chat teknisi' });
    }
});

router.get('/:id/chat', adminAuth, async (req, res) => {
    try {
        const technicianId = req.params.id;
        const technician = await new Promise((resolve, reject) => {
            db.get(
                'SELECT id, name, phone, role, is_active FROM technicians WHERE id = ?',
                [technicianId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });

        if (!technician) {
            return res.status(404).send('Teknisi tidak ditemukan');
        }

        res.render('admin/technician-chat', {
            title: `Chat Teknisi - ${technician.name}`,
            page: 'technicians',
            technician,
            settings: {
                logo_filename: getSetting('logo_filename', 'logo.png'),
                company_header: getSetting('company_header', 'GEMBOK')
            },
            versionInfo: getVersionInfo(),
            versionBadge: getVersionBadge()
        });
    } catch (error) {
        logger.error('Error loading admin technician chat page:', error);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/:id/chat/messages', adminAuth, async (req, res) => {
    try {
        const technicianId = req.params.id;
        const message = String(req.body.message || '').trim();
        if (!message) {
            return res.status(400).json({ success: false, message: 'Pesan wajib diisi' });
        }

        const technician = await new Promise((resolve, reject) => {
            db.get('SELECT id, name FROM technicians WHERE id = ?', [technicianId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!technician) {
            return res.status(404).json({ success: false, message: 'Teknisi tidak ditemukan' });
        }

        const result = await new Promise((resolve, reject) => {
            db.run(
                `
                    INSERT INTO technician_chat_messages (technician_id, sender_role, sender_id, message, is_read)
                    VALUES (?, 'admin', ?, ?, 0)
                `,
                [technicianId, String(req.session.adminId || req.session.adminUser || 'admin'), message],
                function(err) {
                    if (err) reject(err);
                    else resolve({ id: this.lastID });
                }
            );
        });

        const created = await new Promise((resolve, reject) => {
            db.get(
                `
                    SELECT id, technician_id, sender_role, sender_id, message, is_read, created_at, read_at
                    FROM technician_chat_messages
                    WHERE id = ?
                `,
                [result.id],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });

        setImmediate(() => {
            notifyTechnicians({
                title: 'Chat dari Admin',
                message: `${message.slice(0, 110)}${message.length > 110 ? '...' : ''}`,
                type: 'chat',
                link: '/technician/chat'
            }, [technicianId]).catch((error) => {
                logger.warn(`Push chat teknisi gagal: ${error.message}`);
            });
        });

        res.json({ success: true, message: 'Pesan berhasil dikirim', chat: created });
    } catch (error) {
        logger.error('Error sending admin technician chat:', error);
        res.status(500).json({ success: false, message: 'Gagal mengirim pesan ke teknisi' });
    }
});

/**
 * PUT /admin/technicians/:id/update - Update technician
 */
router.put('/:id/update', adminAuth, async (req, res) => {
    try {
        const technicianId = req.params.id;
        const { name, phone, role, notes, whatsapp_group_id } = req.body;

        if (!name || !phone || !role) {
            return res.status(400).json({
                success: false,
                message: 'Nama, nomor telepon, dan role wajib diisi'
            });
        }

        const validRoles = ['technician', 'field_officer', 'collector'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({
                success: false,
                message: 'Role tidak valid'
            });
        }

        const cleanPhone = normalizePhone(phone);

        const existingTechnician = await new Promise((resolve, reject) => {
            db.get('SELECT id FROM technicians WHERE phone = ? AND id != ?', [cleanPhone, technicianId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (existingTechnician) {
            return res.status(400).json({
                success: false,
                message: 'Nomor telepon sudah terdaftar oleh teknisi lain'
            });
        }

        const result = await new Promise((resolve, reject) => {
            const sql = `
                UPDATE technicians
                SET name = ?, phone = ?, role = ?, area_coverage = ?, whatsapp_group_id = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `;

            db.run(sql, [name, cleanPhone, role, notes || 'Area Default', whatsapp_group_id || null, technicianId], function(err) {
                if (err) reject(err);
                else resolve({ changes: this.changes });
            });
        });

        if (result.changes > 0) {
            logger.info(`Technician updated: ${name} (${cleanPhone}) with role: ${role}`);

            res.json({
                success: true,
                message: 'Teknisi berhasil diperbarui'
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'Teknisi tidak ditemukan'
            });
        }

    } catch (error) {
        logger.error('Error updating technician:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server: ' + error.message
        });
    }
});

/**
 * POST /admin/technicians/:id/toggle-status - Toggle technician active status
 */
router.post('/:id/toggle-status', adminAuth, async (req, res) => {
    try {
        const technicianId = req.params.id;
        const { is_active } = req.body;

        if (typeof is_active !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'Status harus berupa boolean'
            });
        }

        const result = await new Promise((resolve, reject) => {
            const sql = `
                UPDATE technicians 
                SET is_active = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `;

            db.run(sql, [is_active ? 1 : 0, technicianId], function(err) {
                if (err) reject(err);
                else resolve({ changes: this.changes });
            });
        });

        if (result.changes > 0) {
            const statusText = is_active ? 'diaktifkan' : 'dinonaktifkan';
            logger.info(`Technician ${technicianId} status ${statusText}`);

            res.json({
                success: true,
                message: `Teknisi berhasil ${statusText}`,
                is_active: is_active
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'Teknisi tidak ditemukan'
            });
        }

    } catch (error) {
        logger.error('Error toggling technician status:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server: ' + error.message
        });
    }
});

router.post('/bulk/activate', adminAuth, async (req, res) => {
    try {
        const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
        if (ids.length === 0) return res.status(400).json({ success: false, message: 'Tidak ada ID yang dipilih' });

        const placeholders = ids.map(() => '?').join(',');
        const sql = `UPDATE technicians SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`;
        const result = await new Promise((resolve, reject) => {
            db.run(sql, ids, function(err){ if (err) reject(err); else resolve({ changes: this.changes }); });
        });
        return res.json({ success: true, message: `Berhasil mengaktifkan ${result.changes} teknisi` });
    } catch (error) {
        logger.error('Bulk activate technicians error:', error);
        return res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
    }
});

router.post('/bulk/deactivate', adminAuth, async (req, res) => {
    try {
        const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
        if (ids.length === 0) return res.status(400).json({ success: false, message: 'Tidak ada ID yang dipilih' });

        const placeholders = ids.map(() => '?').join(',');
        const sql = `UPDATE technicians SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`;
        const result = await new Promise((resolve, reject) => {
            db.run(sql, ids, function(err){ if (err) reject(err); else resolve({ changes: this.changes }); });
        });
        return res.json({ success: true, message: `Berhasil menonaktifkan ${result.changes} teknisi` });
    } catch (error) {
        logger.error('Bulk deactivate technicians error:', error);
        return res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
    }
});

router.post('/bulk/delete', adminAuth, async (req, res) => {
    try {
        const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
        if (ids.length === 0) return res.status(400).json({ success: false, message: 'Tidak ada ID yang dipilih' });

        const canDelete = [];
        const blocked = [];
        for (const id of ids) {
            const activeJobs = await new Promise((resolve, reject) => {
                db.get(`SELECT COUNT(*) as count FROM installation_jobs WHERE assigned_technician_id = ? AND status IN ('assigned','in_progress')`, [id], (err, row) => {
                    if (err) reject(err); else resolve(row.count);
                });
            });
            if (activeJobs > 0) blocked.push(id); else canDelete.push(id);
        }

        let changes = 0;
        if (canDelete.length) {
            const placeholders = canDelete.map(() => '?').join(',');
            const sql = `UPDATE technicians SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`;
            const result = await new Promise((resolve, reject) => {
                db.run(sql, canDelete, function(err){ if (err) reject(err); else resolve({ changes: this.changes }); });
            });
            changes = result.changes;
        }

        const msgParts = [];
        if (changes) msgParts.push(`dihapus: ${changes}`);
        if (blocked.length) msgParts.push(`gagal (punya job aktif): ${blocked.length}`);
        return res.json({ success: true, message: `Bulk delete selesai (${msgParts.join(', ')})`, deleted: changes, blocked });
    } catch (error) {
        logger.error('Bulk delete technicians error:', error);
        return res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
    }
});

router.delete('/:id', adminAuth, async (req, res) => {
    try {
        const technicianId = req.params.id;

        const totalJobs = await new Promise((resolve, reject) => {
            db.get(`
                SELECT COUNT(*) as count 
                FROM installation_jobs 
                WHERE assigned_technician_id = ?
            `, [technicianId], (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        const activeJobs = await new Promise((resolve, reject) => {
            db.get(`
                SELECT COUNT(*) as count 
                FROM installation_jobs 
                WHERE assigned_technician_id = ? AND status IN ('assigned', 'in_progress')
            `, [technicianId], (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        if (activeJobs > 0) {
            return res.status(400).json({
                success: false,
                message: 'Tidak dapat menghapus teknisi yang memiliki tugas aktif'
            });
        }

        if (totalJobs === 0) {
            const hardResult = await new Promise((resolve, reject) => {
                const delSql = `DELETE FROM technicians WHERE id = ?`;
                db.run(delSql, [technicianId], function(err) {
                    if (err) reject(err);
                    else resolve({ changes: this.changes });
                });
            });

            if (hardResult.changes > 0) {
                logger.info(`Technician ${technicianId} hard deleted (no related jobs)`);
                return res.json({
                    success: true,
                    message: 'Teknisi berhasil dihapus permanen'
                });
            }
        }

        const result = await new Promise((resolve, reject) => {
            const sql = `
                UPDATE technicians 
                SET is_active = 0, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `;
            db.run(sql, [technicianId], function(err) {
                if (err) reject(err);
                else resolve({ changes: this.changes });
            });
        });

        if (result.changes > 0) {
            logger.info(`Technician ${technicianId} soft deleted (has historical jobs)`);

            res.json({
                success: true,
                message: 'Teknisi berhasil dihapus'
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'Teknisi tidak ditemukan'
            });
        }

    } catch (error) {
        logger.error('Error deleting technician:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server: ' + error.message
        });
    }
});

module.exports = router;
