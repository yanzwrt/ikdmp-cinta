const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const AgentManager = require('../config/agentManager');
const AgentWhatsAppManager = require('../config/agentWhatsApp');
const { getSettingsWithCache, getSetting } = require('../config/settingsManager');
const logger = require('../config/logger');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Middleware to prevent caching of agent pages
const noCache = (req, res, next) => {
  res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  res.header('Expires', '-1');
  res.header('Pragma', 'no-cache');
  next();
};

// Helper function to format phone number for WhatsApp
function formatPhoneNumberForWhatsApp(phoneNumber) {
    if (!phoneNumber) return null;
    
    // Remove all non-digit characters
    let cleanPhone = phoneNumber.replace(/[^0-9+]/g, '');
    
    // Add country code if not present
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '62' + cleanPhone.substring(1);
    } else if (cleanPhone.startsWith('+')) {
        cleanPhone = cleanPhone.substring(1);
    } else if (!cleanPhone.startsWith('62')) {
        cleanPhone = '62' + cleanPhone;
    }
    
    return cleanPhone + '@s.whatsapp.net';
}

// Initialize AgentManager
const agentManager = new AgentManager();
// Initialize WhatsApp Manager
const whatsappManager = new AgentWhatsAppManager();

function slugifyProfileName(value, fallback = 'agent') {
    return String(value || fallback)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || fallback;
}

function deleteProfileFileIfExists(directory, filename) {
    if (!filename) return;
    const filePath = path.join(directory, filename);
    if (fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
        } catch (error) {
            logger.warn(`Gagal menghapus file lama ${filePath}: ${error.message}`);
        }
    }
}

const agentProfilePhotoUpload = multer({
    storage: multer.diskStorage({
        destination: function (req, file, cb) {
            const uploadPath = path.join(__dirname, '../public/img/agent-profiles');
            if (!fs.existsSync(uploadPath)) {
                fs.mkdirSync(uploadPath, { recursive: true });
            }
            cb(null, uploadPath);
        },
        filename: function (req, file, cb) {
            const ext = path.extname(file.originalname).toLowerCase();
            const baseName = req.session?.agentUsername || req.body?.username || req.session?.agentId;
            cb(null, `${slugifyProfileName(baseName, 'agent')}${ext}`);
        }
    }),
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'image/png' || file.mimetype === 'image/jpg' || file.mimetype === 'image/jpeg') {
            cb(null, true);
        } else {
            cb(new Error('Only PNG, JPG, and JPEG files are allowed'), false);
        }
    },
    limits: {
        fileSize: 3 * 1024 * 1024
    }
});

// Set WhatsApp socket when available
if (global.whatsappStatus && global.whatsappStatus.connected) {
    // Try to get socket from various sources
    let sock = null;
    
    // Check if there's a global whatsapp socket
    if (typeof global.getWhatsAppSocket === 'function') {
        sock = global.getWhatsAppSocket();
    } else if (global.whatsappSocket) {
        sock = global.whatsappSocket;
    } else if (global.whatsapp && typeof global.whatsapp.getSock === 'function') {
        sock = global.whatsapp.getSock();
    }
    
    if (sock) {
        whatsappManager.setSocket(sock);
        logger.info('WhatsApp socket set for AgentWhatsAppManager in agentAuth');
    } else {
        logger.warn('WhatsApp socket not available for AgentWhatsAppManager in agentAuth');
    }
}

// Middleware untuk check agent session
const requireAgentAuth = (req, res, next) => {
    if (req.session && req.session.agentId) {
        return next();
    } else {
        return res.redirect('/agent/login');
    }
};

// GET: Login page
router.get('/login', (req, res) => {
    try {
        const settings = getSettingsWithCache();
        res.render('agent/login', {
            error: null,
            success: null,
            appSettings: settings
        });
    } catch (error) {
        logger.error('Error rendering agent login:', error);
        res.status(500).send('Error loading login page');
    }
});

// POST: Agent registration
router.post('/register', agentProfilePhotoUpload.single('profile_photo'), async (req, res) => {
    try {
        const { name, username, phone, email, password, confirmPassword, address } = req.body;
        
        // Validation
        if (!name || !username || !phone || !password || !confirmPassword || !address) {
            return res.json({ 
                success: false, 
                message: 'Semua field wajib diisi' 
            });
        }
        
        if (password !== confirmPassword) {
            return res.json({ 
                success: false, 
                message: 'Password dan konfirmasi password tidak sama' 
            });
        }
        
        if (password.length < 6) {
            return res.json({ 
                success: false, 
                message: 'Password minimal 6 karakter' 
            });
        }
        
        // Phone number validation
        const phoneRegex = /^08\d{8,11}$/;
        if (!phoneRegex.test(phone)) {
            return res.json({ 
                success: false, 
                message: 'Format nomor HP tidak valid. Gunakan format 08xxxxxxxxxx' 
            });
        }
        
        // Check if username already exists
        const existingAgent = await agentManager.getAgentByUsername(username);
        if (existingAgent) {
            return res.json({ 
                success: false, 
                message: 'Username sudah digunakan' 
            });
        }
        
        // Check if phone already exists
        const existingPhone = await agentManager.getAnyAgentByPhone(phone);
        if (existingPhone) {
            return res.json({ 
                success: false, 
                message: 'Nomor HP sudah terdaftar' 
            });
        }
        
        // Create agent with pending approval
        const agentData = {
            username: username,
            name: name,
            phone: phone,
            email: email || null,
            password: password,
            address: address,
            profile_photo: req.file ? req.file.filename : null,
            status: 'inactive',
            approval_status: 'pending'
        };
        
        const result = await agentManager.createAgent(agentData);
        
        if (result.success) {
            // Notifikasi ke admin
            await agentManager.createAdminNotification(
                'agent_registration',
                'Pendaftaran Agent Baru',
                `Agent baru mendaftar: ${name} (${username}) - ${phone}`,
                result.agentId
            );
            // Notifikasi ke agent
            await agentManager.createNotification(
                result.agentId,
                'registration_success',
                'Pendaftaran Berhasil',
                'Pendaftaran Anda berhasil dikirim dan sedang menunggu persetujuan admin.'
            );
            // WhatsApp ke admin
            const adminNumbers = [];
            let i = 0;
            while (true) {
                const adminNum = getSetting(`admins.${i}`);
                if (!adminNum) break;
                adminNumbers.push(adminNum);
                i++;
            }
            const uniqueAdminNumbers = [...new Set(adminNumbers)];
            const adminWAmsg = `*PENDAFTARAN AGENT BARU*

ID Agent: ${result.agentId}
Nama: ${name}
Username: ${username}
HP: ${phone}
Email: ${email || '-'}
Alamat: ${address}
Status: Menunggu Approval

Balas salah satu format berikut:
SETUJUI AGENT ${result.agentId}
TOLAK AGENT ${result.agentId} alasan`;
            
            // Log for debugging
            logger.info(`Sending admin notifications to ${uniqueAdminNumbers.length} admins`);
            
            for (const adminNum of uniqueAdminNumbers) {
                try {
                    const sendAdminResult = await whatsappManager.sendText(adminNum, adminWAmsg, 'admin notification');
                    if (sendAdminResult.success) {
                        logger.info(`Admin notification sent to ${adminNum}`);
                    } else {
                        logger.warn(`Admin notification failed for ${adminNum}: ${sendAdminResult.message}`);
                    }
                } catch (e) { 
                    logger.error(`WA admin notif error for ${adminNum}:`, e); 
                }
            }
            
            // WhatsApp ke agent
            const serverHost = getSetting('server_host', 'localhost');
            const serverPort = getSetting('server_port', '3001');
            const portalUrl = getSetting('portal_url', `http://${serverHost}:${serverPort}/agent/login`);
            const adminContact = getSetting('contact_whatsapp', getSetting('contact_phone', '-'));
            const agentWAmsg = `*PENDAFTARAN AGENT BERHASIL*

Halo ${name},

Pendaftaran Anda *berhasil dikirim* dan saat ini *sedang menunggu persetujuan admin*.

*Data Pendaftaran:*
- ID Agent: ${result.agentId}
- Nama: ${name}
- Username: ${username}
- No. HP: ${phone}
- Email: ${email || '-'}
- Alamat: ${address}
- Status: Menunggu Persetujuan

*Portal Login:*
${portalUrl}

Setelah admin menyetujui, Anda akan menerima pesan lanjutan berisi status persetujuan dan data akun Anda.

Jika butuh bantuan, hubungi admin: ${adminContact}

Terima kasih telah mendaftar di Portal Agent.`;
            
            try {
                const sendAgentResult = await whatsappManager.sendText(phone, agentWAmsg, 'agent notification');
                if (sendAgentResult.success) {
                    logger.info(`Agent pending notification sent to ${phone}`);
                } else {
                    logger.warn(`Agent pending notification failed for ${phone}: ${sendAgentResult.message}`);
                }
            } catch (e) { 
                logger.error(`WA agent notif error for ${phone}:`, e); 
            }
            
            logger.info(`New agent registration: ${name} (${username}) - ${phone}`);
            
            res.json({ 
                success: true, 
                message: 'Pendaftaran berhasil! Akun Anda sedang menunggu persetujuan admin.' 
            });
        } else {
            res.json({ 
                success: false, 
                message: 'Gagal mendaftar. Silakan coba lagi.' 
            });
        }
        
    } catch (error) {
        if (req.file?.filename) {
            deleteProfileFileIfExists(path.join(__dirname, '../public/img/agent-profiles'), req.file.filename);
        }
        logger.error('Agent registration error:', error);
        res.json({ 
            success: false, 
            message: 'Terjadi kesalahan saat mendaftar' 
        });
    }
});

// POST: Login process
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.render('agent/login', {
                error: 'Username dan password harus diisi',
                success: null,
                appSettings: getSettingsWithCache()
            });
        }

        const result = await agentManager.authenticateAgent(username, password);
        
        if (result.success) {
            req.session.agentId = result.agent.id;
            req.session.agentName = result.agent.name;
            req.session.agentUsername = result.agent.username;
            req.session.cookie.maxAge = THIRTY_DAYS_MS;
            
            logger.info(`Agent ${result.agent.username} logged in successfully`);
            res.redirect('/agent/dashboard');
        } else {
            res.render('agent/login', {
                error: result.message,
                success: null,
                appSettings: getSettingsWithCache()
            });
        }
    } catch (error) {
        logger.error('Agent login error:', error);
        res.render('agent/login', {
            error: 'Terjadi kesalahan saat login',
            success: null,
            appSettings: getSettingsWithCache()
        });
    }
});

// GET: Logout
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            logger.error('Session destroy error:', err);
        }
        res.redirect('/agent/login');
    });
});

// GET: Dashboard
router.get('/dashboard', requireAgentAuth, noCache, async (req, res) => {
    try {
        const agentId = req.session.agentId;
        
        // Get agent info and balance
        const agent = await agentManager.getAgentById(agentId);
        const balance = await agentManager.getAgentBalance(agentId);
        const stats = await agentManager.getAgentStats(agentId);
        const notifications = await agentManager.getAgentNotifications(agentId, 10);
        
        // Get recent transactions
        const recentTransactionsResult = await agentManager.getAgentTransactions(agentId, 1, 10, 'all');
        const recentTransactions = recentTransactionsResult.data || [];
        
        res.render('agent/dashboard', {
            agent,
            balance,
            stats,
            notifications,
            recentTransactions,
            appSettings: getSettingsWithCache()
        });
    } catch (error) {
        logger.error('Agent dashboard error:', error);
        res.status(500).send('Error loading dashboard');
    }
});

// GET: Mobile Dashboard
router.get('/mobile', requireAgentAuth, noCache, async (req, res) => {
    try {
        const agentId = req.session.agentId;
        
        // Get agent info and balance
        const agent = await agentManager.getAgentById(agentId);
        const balance = await agentManager.getAgentBalance(agentId);
        const stats = await agentManager.getAgentStats(agentId);
        const notifications = await agentManager.getAgentNotifications(agentId, 10);
        
        // Get recent transactions
        const recentTransactionsResult = await agentManager.getAgentTransactions(agentId, 1, 10, 'all');
        const recentTransactions = recentTransactionsResult.data || [];
        
        res.render('agent/mobile-dashboard', {
            agent,
            balance,
            stats,
            notifications,
            recentTransactions,
            appSettings: getSettingsWithCache()
        });
    } catch (error) {
        logger.error('Agent mobile dashboard error:', error);
        res.status(500).send('Error loading mobile dashboard');
    }
});

// GET: Profile
router.get('/profile', requireAgentAuth, noCache, async (req, res) => {
    try {
        const agentId = req.session.agentId;
        const agent = await agentManager.getAgentById(agentId);
        
        res.render('agent/profile', {
            agent,
            appSettings: getSettingsWithCache()
        });
    } catch (error) {
        logger.error('Agent profile error:', error);
        res.status(500).send('Error loading profile');
    }
});

// POST: Update profile
router.post('/profile', requireAgentAuth, async (req, res) => {
    try {
        const agentId = req.session.agentId;
        const { name, email, address, phone } = req.body;
        
        // Update agent profile
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data/billing.db');
        
        const updateSql = `
            UPDATE agents 
            SET name = ?, email = ?, address = ?, phone = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `;
        
        db.run(updateSql, [name, email, address, phone, agentId], function(err) {
            db.close();
            
            if (err) {
                logger.error('Profile update error:', err);
                return res.json({ success: false, message: 'Gagal mengupdate profil' });
            }
            
            res.json({ success: true, message: 'Profil berhasil diupdate' });
        });
    } catch (error) {
        logger.error('Profile update error:', error);
        res.json({ success: false, message: 'Terjadi kesalahan saat mengupdate profil' });
    }
});

router.post('/profile/photo', requireAgentAuth, agentProfilePhotoUpload.single('profile_photo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Tidak ada file foto yang diupload' });
        }

        const agentId = req.session.agentId;
        const uploadDir = path.join(__dirname, '../public/img/agent-profiles');
        const existingAgent = await agentManager.getAgentById(agentId);
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data/billing.db');

        db.run(
            'UPDATE agents SET profile_photo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [req.file.filename, agentId],
            function (err) {
                db.close();

                if (err) {
                    deleteProfileFileIfExists(uploadDir, req.file.filename);
                    logger.error('Agent profile photo update error:', err);
                    return res.status(500).json({ success: false, message: 'Gagal menyimpan foto profil' });
                }
                if (existingAgent?.profile_photo && existingAgent.profile_photo !== req.file.filename) {
                    deleteProfileFileIfExists(uploadDir, existingAgent.profile_photo);
                }

                res.json({
                    success: true,
                    message: 'Foto profil agent berhasil diperbarui',
                    filename: req.file.filename,
                    path: `/img/agent-profiles/${req.file.filename}`
                });
            }
        );
    } catch (error) {
        logger.error('Agent profile photo upload error:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan saat upload foto profil' });
    }
});

// GET: Change password page
router.get('/change-password', requireAgentAuth, noCache, (req, res) => {
    res.render('agent/change-password', {
        appSettings: getSettingsWithCache()
    });
});

// POST: Change password
router.post('/change-password', requireAgentAuth, async (req, res) => {
    try {
        const agentId = req.session.agentId;
        const { currentPassword, newPassword, confirmPassword } = req.body;
        
        if (newPassword !== confirmPassword) {
            return res.json({ success: false, message: 'Password baru dan konfirmasi tidak sama' });
        }
        
        if (newPassword.length < 6) {
            return res.json({ success: false, message: 'Password minimal 6 karakter' });
        }
        
        // Verify current password
        const agent = await agentManager.getAgentById(agentId);
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data/billing.db');
        
        const getPasswordSql = 'SELECT password FROM agents WHERE id = ?';
        db.get(getPasswordSql, [agentId], async (err, row) => {
            if (err) {
                db.close();
                return res.json({ success: false, message: 'Terjadi kesalahan' });
            }
            
            const bcrypt = require('bcrypt');
            const isValid = await bcrypt.compare(currentPassword, row.password);
            
            if (!isValid) {
                db.close();
                return res.json({ success: false, message: 'Password lama salah' });
            }
            
            // Update password
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            const updateSql = 'UPDATE agents SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
            
            db.run(updateSql, [hashedPassword, agentId], function(err) {
                db.close();
                
                if (err) {
                    return res.json({ success: false, message: 'Gagal mengupdate password' });
                }
                
                res.json({ success: true, message: 'Password berhasil diubah' });
            });
        });
    } catch (error) {
        logger.error('Change password error:', error);
        res.json({ success: false, message: 'Terjadi kesalahan saat mengubah password' });
    }
});

module.exports = { router, requireAgentAuth };
