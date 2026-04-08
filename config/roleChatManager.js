const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../data/billing.db');
const db = new sqlite3.Database(dbPath);

db.run(`
    CREATE TABLE IF NOT EXISTS role_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_role TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        sender_user_id TEXT,
        message TEXT NOT NULL,
        is_read_by_admin INTEGER DEFAULT 0,
        is_read_by_target INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        read_by_admin_at DATETIME,
        read_by_target_at DATETIME
    )
`);

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function normalizeRole(role = '') {
    return String(role || '').trim().toLowerCase();
}

async function getParticipant(role, userId) {
    const normalizedRole = normalizeRole(role);
    const id = String(userId);

    if (normalizedRole === 'customer') {
        const row = await get(`
            SELECT id, name, username, phone, profile_photo
            FROM customers
            WHERE CAST(id AS TEXT) = ? OR username = ? OR phone = ?
            LIMIT 1
        `, [id, id, id]);
        return row ? {
            id: String(row.id),
            name: row.name || 'Pelanggan',
            subtitle: row.username || row.phone || '',
            profile_photo: row.profile_photo || '',
            role: 'customer'
        } : null;
    }

    if (normalizedRole === 'agent') {
        const row = await get(`
            SELECT id, name, username, phone, profile_photo
            FROM agents
            WHERE CAST(id AS TEXT) = ? OR username = ? OR phone = ?
            LIMIT 1
        `, [id, id, id]);
        return row ? {
            id: String(row.id),
            name: row.name || 'Agent',
            subtitle: row.username || row.phone || '',
            profile_photo: row.profile_photo || '',
            role: 'agent'
        } : null;
    }

    if (normalizedRole === 'collector') {
        const row = await get(`
            SELECT id, name, phone, profile_photo
            FROM collectors
            WHERE CAST(id AS TEXT) = ? OR phone = ?
            LIMIT 1
        `, [id, id]);
        return row ? {
            id: String(row.id),
            name: row.name || 'Collector',
            subtitle: row.phone || '',
            profile_photo: row.profile_photo || '',
            role: 'collector'
        } : null;
    }

    return null;
}

async function getMessages(targetRole, targetUserId, limit = 100) {
    return all(`
        SELECT id, target_role, target_user_id, sender_role, sender_user_id, message,
               is_read_by_admin, is_read_by_target, created_at, read_by_admin_at, read_by_target_at
        FROM role_chat_messages
        WHERE target_role = ? AND target_user_id = ?
        ORDER BY datetime(created_at) ASC, id ASC
        LIMIT ?
    `, [normalizeRole(targetRole), String(targetUserId), limit]);
}

async function sendMessageToConversation({ targetRole, targetUserId, senderRole, senderUserId, message }) {
    const normalizedTargetRole = normalizeRole(targetRole);
    const normalizedSenderRole = normalizeRole(senderRole);
    const cleanMessage = String(message || '').trim();

    if (!normalizedTargetRole || !String(targetUserId || '').trim() || !normalizedSenderRole || !cleanMessage) {
        throw new Error('Data chat tidak lengkap');
    }

    const isAdminMessage = normalizedSenderRole === 'admin';

    const result = await run(`
        INSERT INTO role_chat_messages (
            target_role, target_user_id, sender_role, sender_user_id, message,
            is_read_by_admin, is_read_by_target
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
        normalizedTargetRole,
        String(targetUserId),
        normalizedSenderRole,
        senderUserId ? String(senderUserId) : null,
        cleanMessage,
        isAdminMessage ? 1 : 0,
        isAdminMessage ? 0 : 1
    ]);

    return { id: result.lastID };
}

async function markConversationReadByAdmin(targetRole, targetUserId) {
    return run(`
        UPDATE role_chat_messages
        SET is_read_by_admin = 1,
            read_by_admin_at = CURRENT_TIMESTAMP
        WHERE target_role = ? AND target_user_id = ? AND sender_role != 'admin' AND is_read_by_admin = 0
    `, [normalizeRole(targetRole), String(targetUserId)]);
}

async function markConversationReadByTarget(targetRole, targetUserId) {
    return run(`
        UPDATE role_chat_messages
        SET is_read_by_target = 1,
            read_by_target_at = CURRENT_TIMESTAMP
        WHERE target_role = ? AND target_user_id = ? AND sender_role != ? AND is_read_by_target = 0
    `, [normalizeRole(targetRole), String(targetUserId), normalizeRole(targetRole)]);
}

async function deleteConversation(targetRole, targetUserId) {
    return run(`
        DELETE FROM role_chat_messages
        WHERE target_role = ? AND target_user_id = ?
    `, [normalizeRole(targetRole), String(targetUserId)]);
}

async function getUnreadCountForTarget(targetRole, targetUserId) {
    const row = await getUnreadSummaryForTarget(targetRole, targetUserId);
    return Number(row?.unread_count || 0);
}

async function getUnreadSummaryForTarget(targetRole, targetUserId) {
    const row = await get(`
        SELECT COUNT(*) AS unread_count, MAX(created_at) AS latest_unread_at
        FROM role_chat_messages
        WHERE target_role = ? AND target_user_id = ? AND sender_role != ? AND is_read_by_target = 0
    `, [normalizeRole(targetRole), String(targetUserId), normalizeRole(targetRole)]);
    return row || { unread_count: 0, latest_unread_at: null };
}

async function getUnreadSummaryForAdmin() {
    return all(`
        SELECT target_role, target_user_id, COUNT(*) AS unread_count
        FROM role_chat_messages
        WHERE sender_role != 'admin' AND is_read_by_admin = 0
        GROUP BY target_role, target_user_id
    `);
}

async function getAdminInboxConversations() {
    const genericRows = await all(`
        SELECT target_role, target_user_id, MAX(id) AS latest_id
        FROM role_chat_messages
        GROUP BY target_role, target_user_id
        ORDER BY latest_id DESC
    `);

    const unreadSummary = await getUnreadSummaryForAdmin();
    const unreadMap = new Map(
        unreadSummary.map((item) => [`${item.target_role}:${item.target_user_id}`, Number(item.unread_count || 0)])
    );

    const conversations = [];
    for (const row of genericRows) {
        const latest = await get(`
            SELECT id, target_role, target_user_id, sender_role, sender_user_id, message, created_at
            FROM role_chat_messages
            WHERE id = ?
        `, [row.latest_id]);

        if (!latest) continue;
        const participant = await getParticipant(latest.target_role, latest.target_user_id);
        if (!participant) continue;

        conversations.push({
            role: latest.target_role,
            userId: String(latest.target_user_id),
            participant,
            lastMessage: latest.message || '',
            lastSenderRole: latest.sender_role,
            createdAt: latest.created_at,
            unreadCount: unreadMap.get(`${latest.target_role}:${latest.target_user_id}`) || 0
        });
    }

    return conversations;
}

module.exports = {
    getParticipant,
    getMessages,
    sendMessageToConversation,
    markConversationReadByAdmin,
    markConversationReadByTarget,
    deleteConversation,
    getUnreadCountForTarget,
    getUnreadSummaryForTarget,
    getUnreadSummaryForAdmin,
    getAdminInboxConversations
};
