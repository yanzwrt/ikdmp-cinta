const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('./logger');
const { getCompanyHeader } = require('./message-templates');
const { getSetting } = require('./settingsManager');
const { getActivePPPoEConnections, getOfflinePPPoEUsers, getPPPoEUserByUsername } = require('./mikrotik');
const whatsappNotifications = require('./whatsapp-notifications');

class WhatsAppMessageHandler {
    constructor() {
        this.dbPath = path.join(__dirname, '../data/billing.db');
        this.db = new sqlite3.Database(this.dbPath);
        this.whatsappGateway = null;

        this.responsePatterns = {
            // Confirmation patterns
            'TERIMA': { action: 'confirm_reception', status: 'assigned' },
            'OK': { action: 'confirm_reception', status: 'assigned' },
            'KONFIRM': { action: 'confirm_reception', status: 'assigned' },

            // Start installation patterns
            'MULAI': { action: 'start_installation', status: 'in_progress' },
            'START': { action: 'start_installation', status: 'in_progress' },
            'PROSES': { action: 'start_installation', status: 'in_progress' },

            // Complete installation patterns
            'SELESAI': { action: 'complete_installation', status: 'completed' },
            'DONE': { action: 'complete_installation', status: 'completed' },
            'FINISH': { action: 'complete_installation', status: 'completed' },

            // Help patterns
            'BANTU': { action: 'request_help', status: null },
            'HELP': { action: 'request_help', status: null },
            'TOLONG': { action: 'request_help', status: null },

            // Problem report patterns
            'MASALAH': { action: 'report_problem', status: null },
            'ISSUE': { action: 'report_problem', status: null },
            'KENDALA': { action: 'report_problem', status: null },

            // Additional report patterns
            'LAPOR': { action: 'additional_report', status: null },
            'REPORT': { action: 'additional_report', status: null },
            'TAMBAHAN': { action: 'additional_report', status: null },

            // Menu and PPPoE quick status
            'MENU': { action: 'show_menu', status: null },
            'TEKNISI': { action: 'show_menu', status: null },
            'PPPOE STATUS': { action: 'pppoe_status', status: null },
            'STATUS PPPOE': { action: 'pppoe_status', status: null }
        };
    }

    setWhatsAppGateway(gateway) {
        this.whatsappGateway = gateway || null;
    }

    async processTechnicianMessage(phone, message, technicianName = null, replyJid = null) {
        try {
            const cleanMessage = message.trim().toUpperCase();
            const pattern = this.findMatchingPattern(cleanMessage);

            if (!pattern) {
                logger.info(`No matching pattern found for message: "${message}" from ${phone}`);
                return this.sendUnrecognizedMessageResponse(phone, replyJid);
            }

            const technician = await this.getTechnicianByPhone(phone);
            if (!technician) {
                logger.warn(`Technician not found for phone: ${phone}`);
                return this.sendTechnicianNotFoundResponse(phone, replyJid);
            }

            if (cleanMessage.startsWith('CHECKPPPOE ') || cleanMessage.startsWith('CEKPPPOE ')) {
                const username = cleanMessage.split(/\s+/).slice(1).join(' ').trim();
                const result = await this.getPPPoEUserQuickStatus(username);
                await this.sendActionConfirmationResponse(phone, 'check_pppoe', null, result, replyJid);
                return result;
            }

            if (pattern.action === 'show_menu' || pattern.action === 'pppoe_status') {
                const result = await this.processAction(pattern.action, technician, null, cleanMessage);
                await this.sendActionConfirmationResponse(phone, pattern.action, null, result, replyJid);
                return result;
            }

            const activeJob = await this.getActiveInstallationJob(technician.id);
            if (!activeJob) {
                logger.info(`No active installation job found for technician: ${technician.name}`);
                return this.sendNoActiveJobResponse(phone, technician.name, replyJid);
            }

            const result = await this.processAction(pattern.action, technician, activeJob, cleanMessage);
            await this.sendActionConfirmationResponse(phone, pattern.action, activeJob, result, replyJid);

            return result;
        } catch (error) {
            logger.error('Error processing technician message:', error);
            return { success: false, error: error.message };
        }
    }

    findMatchingPattern(message) {
        for (const [pattern, action] of Object.entries(this.responsePatterns)) {
            if (message.includes(pattern)) {
                return action;
            }
        }
        return null;
    }

    async getTechnicianByPhone(phone) {
        return new Promise((resolve, reject) => {
            const rawPhone = String(phone || '').replace(/\D/g, '');
            let normalized62 = rawPhone;

            if (normalized62.startsWith('0')) {
                normalized62 = '62' + normalized62.slice(1);
            } else if (!normalized62.startsWith('62')) {
                normalized62 = '62' + normalized62;
            }

            const local0 = normalized62.replace(/^62/, '0');
            const plus62 = `+${normalized62}`;
            const variants = Array.from(new Set([normalized62, local0, plus62, rawPhone]));
            const placeholders = variants.map(() => '?').join(', ');

            this.db.get(
                `SELECT id, name, phone, role
                 FROM technicians
                 WHERE is_active = 1 AND phone IN (${placeholders})
                 ORDER BY CASE
                    WHEN phone = ? THEN 0
                    WHEN phone = ? THEN 1
                    WHEN phone = ? THEN 2
                    ELSE 3
                 END
                 LIMIT 1`,
                [...variants, normalized62, local0, plus62],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    async getActiveInstallationJob(technicianId) {
        return new Promise((resolve, reject) => {
            this.db.get(`
                SELECT * FROM installation_jobs
                WHERE assigned_technician_id = ?
                AND status IN ('assigned', 'in_progress')
                ORDER BY created_at DESC
                LIMIT 1
            `, [technicianId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    async getJobCustomerNotificationData(job) {
        return new Promise((resolve, reject) => {
            const rawPhone = String(job?.customer_phone || '').replace(/\D/g, '');
            if (!rawPhone) {
                resolve(null);
                return;
            }

            let normalized62 = rawPhone;
            if (normalized62.startsWith('0')) {
                normalized62 = '62' + normalized62.slice(1);
            } else if (!normalized62.startsWith('62')) {
                normalized62 = '62' + normalized62;
            }

            const local0 = normalized62.replace(/^62/, '0');
            const plus62 = `+${normalized62}`;
            const variants = Array.from(new Set([normalized62, local0, plus62, rawPhone]));
            const placeholders = variants.map(() => '?').join(', ');

            this.db.get(
                `SELECT c.id, c.name, c.username, c.phone, c.email,
                        COALESCE(p.name, 'N/A') AS package_name,
                        COALESCE(p.speed, 'N/A') AS package_speed
                 FROM customers c
                 LEFT JOIN packages p ON p.id = COALESCE(c.package_id, ?)
                 WHERE c.phone IN (${placeholders})
                 ORDER BY CASE
                    WHEN c.phone = ? THEN 0
                    WHEN c.phone = ? THEN 1
                    WHEN c.phone = ? THEN 2
                    ELSE 3
                 END
                 LIMIT 1`,
                [job?.package_id || null, ...variants, normalized62, local0, plus62],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                }
            );
        });
    }

    async notifyCustomerInstallationProgress(job, technician, phase) {
        try {
            const customer = await this.getJobCustomerNotificationData(job);
            if (!customer || !customer.phone) {
                logger.warn(`[TECHNICIAN] Skip notify progress ${phase} for job ${job?.job_number || '-'}: customer phone not found`);
                return { success: false, skipped: true, reason: 'Customer phone not found' };
            }

            const technicianName = technician?.name || 'Tim Teknisi';
            const messages = {
                accepted: `*UPDATE JADWAL INSTALASI*\n\nHalo ${customer.name},\n\nTugas instalasi Anda sudah diterima oleh teknisi *${technicianName}* dan akan segera diproses.\n\nNo. Job: ${job.job_number}\nPaket: ${customer.package_name}\n\nTerima kasih sudah menunggu.\n\n*${getCompanyHeader()}*`,
                in_progress: `*PROSES INSTALASI DIMULAI*\n\nHalo ${customer.name},\n\nTeknisi *${technicianName}* sedang mengerjakan instalasi internet Anda sekarang.\n\nNo. Job: ${job.job_number}\nPaket: ${customer.package_name}\n\nMohon tunggu sampai proses selesai.\n\n*${getCompanyHeader()}*`
            };

            const message = messages[phase];
            if (!message) {
                return { success: false, skipped: true, reason: 'Unsupported phase' };
            }

            const sent = await this.sendWhatsAppMessage(customer.phone, message);
            logger.info(`[TECHNICIAN] Customer progress notification phase=${phase} job=${job?.job_number || '-'} customer=${customer.phone} sent=${sent}`);
            return { success: sent };
        } catch (error) {
            logger.error(`[TECHNICIAN] Failed notify customer installation progress: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async sendCustomerWelcomeAfterInstallation(job) {
        try {
            const customer = await this.getJobCustomerNotificationData(job);
            if (!customer || !customer.phone) {
                logger.warn(`[TECHNICIAN] Skip welcome after installation for job ${job?.job_number || '-'}: customer phone not found`);
                return { success: false, skipped: true, reason: 'Customer phone not found' };
            }

            const notificationResult = await whatsappNotifications.sendWelcomeMessage({
                ...customer,
                phone: customer.phone,
                name: customer.name || job?.customer_name || 'Pelanggan',
                package_name: customer.package_name || 'N/A',
                package_speed: customer.package_speed || 'N/A'
            });

            const sent = !!(notificationResult && notificationResult.success);
            logger.info(`[TECHNICIAN] Welcome after installation job=${job?.job_number || '-'} customer=${customer.phone} sent=${sent}`);
            return { success: sent, result: notificationResult };
        } catch (error) {
            logger.error(`[TECHNICIAN] Failed send welcome after installation: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async processAction(action, technician, job, message) {
        try {
            switch (action) {
                case 'confirm_reception':
                    return await this.confirmJobReception(technician, job);

                case 'start_installation':
                    return await this.startInstallation(technician, job);

                case 'complete_installation':
                    return await this.completeInstallation(technician, job, message);

                case 'request_help':
                    return await this.requestHelp(technician, job, message);

                case 'report_problem':
                    return await this.reportProblem(technician, job, message);

                case 'additional_report':
                    return await this.additionalReport(technician, job, message);

                case 'show_menu':
                    return await this.showTechnicianMenu(technician);

                case 'pppoe_status':
                    return await this.getPPPoEQuickStatus();

                default:
                    return { success: false, error: 'Unknown action' };
            }
        } catch (error) {
            logger.error(`Error processing action ${action}:`, error);
            return { success: false, error: error.message };
        }
    }

    async confirmJobReception(technician, job) {
        try {
            await new Promise((resolve, reject) => {
                this.db.run(`
                    UPDATE installation_jobs
                    SET status = 'assigned',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [job.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO installation_job_status_history (
                        job_id, old_status, new_status, changed_by_type, changed_by_id, notes
                    ) VALUES (?, ?, 'assigned', 'technician', ?, 'Konfirmasi penerimaan tugas via WhatsApp')
                `, [job.id, job.status, technician.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            await this.notifyCustomerInstallationProgress(job, technician, 'accepted');

            logger.info(`Technician ${technician.name} confirmed reception of job ${job.job_number}`);
            return { success: true, action: 'reception_confirmed', message: 'Penerimaan tugas dikonfirmasi' };
        } catch (error) {
            logger.error('Error confirming job reception:', error);
            return { success: false, error: error.message };
        }
    }

    async startInstallation(technician, job) {
        try {
            await new Promise((resolve, reject) => {
                this.db.run(`
                    UPDATE installation_jobs
                    SET status = 'in_progress',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [job.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO installation_job_status_history (
                        job_id, old_status, new_status, changed_by_type, changed_by_id, notes
                    ) VALUES (?, ?, 'in_progress', 'technician', ?, 'Mulai instalasi via WhatsApp')
                `, [job.id, job.status, technician.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            await this.notifyCustomerInstallationProgress(job, technician, 'in_progress');

            logger.info(`Technician ${technician.name} started installation for job ${job.job_number}`);
            return { success: true, action: 'installation_started', message: 'Instalasi dimulai' };
        } catch (error) {
            logger.error('Error starting installation:', error);
            return { success: false, error: error.message };
        }
    }

    async completeInstallation(technician, job, message) {
        try {
            const completionNotes = this.extractNotesFromMessage(message);

            await new Promise((resolve, reject) => {
                this.db.run(`
                    UPDATE installation_jobs
                    SET status = 'completed',
                        notes = COALESCE(?, notes),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [completionNotes, job.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO installation_job_status_history (
                        job_id, old_status, new_status, changed_by_type, changed_by_id, notes
                    ) VALUES (?, ?, 'completed', 'technician', ?, 'Instalasi selesai via WhatsApp: ${completionNotes}')
                `, [job.id, job.status, technician.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            await this.sendCustomerWelcomeAfterInstallation(job);

            logger.info(`Technician ${technician.name} completed installation for job ${job.job_number}`);
            return { success: true, action: 'installation_completed', message: 'Instalasi selesai', notes: completionNotes };
        } catch (error) {
            logger.error('Error completing installation:', error);
            return { success: false, error: error.message };
        }
    }

    async requestHelp(technician, job, message) {
        try {
            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO installation_job_status_history (
                        job_id, old_status, new_status, changed_by_type, changed_by_id, notes
                    ) VALUES (?, ?, ?, 'technician', ?, 'Minta bantuan via WhatsApp: ${message}')
                `, [job.id, job.status, job.status, technician.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            logger.info(`Technician ${technician.name} requested help for job ${job.job_number}`);
            return { success: true, action: 'help_requested', message: 'Permintaan bantuan diterima' };
        } catch (error) {
            logger.error('Error requesting help:', error);
            return { success: false, error: error.message };
        }
    }

    async reportProblem(technician, job, message) {
        try {
            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO installation_job_status_history (
                        job_id, old_status, new_status, changed_by_type, changed_by_id, notes
                    ) VALUES (?, ?, ?, 'technician', ?, 'Laporkan masalah via WhatsApp: ${message}')
                `, [job.id, job.status, job.status, technician.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            logger.info(`Technician ${technician.name} reported problem for job ${job.job_number}`);
            return { success: true, action: 'problem_reported', message: 'Laporan masalah diterima' };
        } catch (error) {
            logger.error('Error reporting problem:', error);
            return { success: false, error: error.message };
        }
    }

    async additionalReport(technician, job, message) {
        try {
            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO installation_job_status_history (
                        job_id, old_status, new_status, changed_by_type, changed_by_id, notes
                    ) VALUES (?, ?, ?, 'technician', ?, 'Laporan tambahan via WhatsApp: ${message}')
                `, [job.id, job.status, job.status, technician.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            logger.info(`Technician ${technician.name} sent additional report for job ${job.job_number}`);
            return { success: true, action: 'additional_reported', message: 'Laporan tambahan diterima' };
        } catch (error) {
            logger.error('Error processing additional report:', error);
            return { success: false, error: error.message };
        }
    }

    extractNotesFromMessage(message) {
        const commandWords = ['SELESAI', 'DONE', 'FINISH', 'LAPOR', 'REPORT', 'TAMBAHAN'];
        let notes = message;

        commandWords.forEach(word => {
            notes = notes.replace(new RegExp(word, 'gi'), '').trim();
        });

        return notes || 'Instalasi selesai';
    }

    normalizePhone(phone = '') {
        let cleanPhone = String(phone).replace(/\D/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
        if (!cleanPhone.startsWith('62')) cleanPhone = '62' + cleanPhone;
        return cleanPhone;
    }

    getLatestWhatsAppSocket() {
        const globalSock = typeof global.getWhatsAppSocket === 'function'
            ? global.getWhatsAppSocket()
            : global.whatsappSocket;

        const gatewaySock = this.whatsappGateway && this.whatsappGateway.sock
            ? this.whatsappGateway.sock
            : null;

        return globalSock || gatewaySock || null;
    }

    isSocketConnected(sock) {
        if (!sock || typeof sock.sendMessage !== 'function') {
            return false;
        }

        if (global.whatsappStatus && global.whatsappStatus.connected === false) {
            return false;
        }

        return true;
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async sendWhatsAppMessage(phone, messageText, replyJid = null) {
        const normalizedPhone = this.normalizePhone(phone);
        const jid = replyJid && String(replyJid).includes('@')
            ? String(replyJid)
            : `${normalizedPhone}@s.whatsapp.net`;
        const maxAttempts = 2;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const sock = this.getLatestWhatsAppSocket();

                if (!this.isSocketConnected(sock)) {
                    lastError = new Error('WhatsApp socket not connected');
                    logger.warn(`[TECHNICIAN] WhatsApp socket not ready for ${jid} (attempt ${attempt}/${maxAttempts})`);

                    if (attempt < maxAttempts) {
                        await this.delay(1500);
                        continue;
                    }
                    break;
                }

                await sock.sendMessage(jid, { text: messageText });
                return true;
            } catch (error) {
                lastError = error;
                logger.error(`[TECHNICIAN] Failed send message to ${replyJid || normalizedPhone} (attempt ${attempt}/${maxAttempts}): ${error.message}`);

                if (attempt < maxAttempts) {
                    await this.delay(1500);
                }
            }
        }

        logger.warn(`[TECHNICIAN] Giving up send message to ${jid}: ${lastError ? lastError.message : 'Unknown error'}`);
        return false;
    }

    async getPPPoEQuickStatus() {
        try {
            const [activeRes, offlineUsers] = await Promise.all([
                getActivePPPoEConnections(),
                getOfflinePPPoEUsers()
            ]);

            const onlineCount = activeRes && activeRes.success && Array.isArray(activeRes.data)
                ? activeRes.data.length
                : 0;
            const offlineCount = Array.isArray(offlineUsers) ? offlineUsers.length : 0;

            return { success: true, onlineCount, offlineCount };
        } catch (error) {
            logger.error(`[TECHNICIAN] Error reading PPPoE quick status: ${error.message}`);
            return { success: false, onlineCount: 0, offlineCount: 0, error: error.message };
        }
    }

    async getPPPoEUserQuickStatus(username) {
        try {
            const cleanUsername = String(username || '').trim();
            if (!cleanUsername) {
                return { success: false, error: 'Format salah', needsExample: true };
            }

            const [secret, activeRes] = await Promise.all([
                getPPPoEUserByUsername(cleanUsername),
                getActivePPPoEConnections()
            ]);

            if (!secret) {
                return { success: false, error: 'User PPPoE tidak ditemukan', username: cleanUsername };
            }

            const activeConnections = activeRes && activeRes.success && Array.isArray(activeRes.data)
                ? activeRes.data
                : [];
            const activeSession = activeConnections.find(item => String(item.name || '').trim() === cleanUsername);

            return {
                success: true,
                username: cleanUsername,
                profile: secret.profile || 'default',
                secretStatus: secret.disabled === 'true' ? 'disabled' : 'active',
                connected: !!activeSession,
                ip: activeSession ? (activeSession.address || activeSession['remote-address'] || '-') : '-',
                uptime: activeSession ? (activeSession.uptime || '-') : '-',
                callerId: secret['caller-id'] || '-',
                service: secret.service || 'pppoe'
            };
        } catch (error) {
            logger.error(`[TECHNICIAN] Error reading PPPoE user status: ${error.message}`);
            return { success: false, error: error.message, username: String(username || '').trim() };
        }
    }

    async showTechnicianMenu(technician) {
        const pppoe = await this.getPPPoEQuickStatus();
        return {
            success: true,
            action: 'show_menu',
            technicianName: technician && technician.name ? technician.name : 'Teknisi',
            pppoe
        };
    }

    async sendUnrecognizedMessageResponse(phone, replyJid = null) {
        const message = `*PESAN TIDAK DIKENALI*

Maaf, pesan Anda tidak dapat diproses oleh sistem.

Contoh perintah yang bisa Anda kirim:
- MENU
- TERIMA
- MULAI
- SELESAI
- BANTU
- MASALAH
- PPPOE STATUS
- CHECKPPPOE namauser

Contoh:
CHECKPPPOE rakha

*${getCompanyHeader()}*`;

        const sent = await this.sendWhatsAppMessage(phone, message, replyJid);
        logger.info(`Sending unrecognized message response to ${phone}, sent=${sent}`);
        return { success: sent, message: sent ? 'Response sent' : 'Failed to send response' };
    }

    async sendTechnicianNotFoundResponse(phone, replyJid = null) {
        const message = `*TEKNISI TIDAK DITEMUKAN*

Maaf, nomor telepon Anda tidak terdaftar sebagai teknisi aktif.

Silakan hubungi admin untuk verifikasi status teknisi Anda.

*${getCompanyHeader()}*`;

        const sent = await this.sendWhatsAppMessage(phone, message, replyJid);
        logger.info(`Sending technician not found response to ${phone}, sent=${sent}`);
        return { success: sent, message: sent ? 'Response sent' : 'Failed to send response' };
    }

    async sendNoActiveJobResponse(phone, technicianName, replyJid = null) {
        const message = `*TIDAK ADA TUGAS AKTIF*

Halo ${technicianName},

Saat ini tidak ada tugas instalasi aktif yang ditugaskan kepada Anda.

Silakan tunggu penugasan dari admin atau hubungi admin jika ada pertanyaan.

*${getCompanyHeader()}*`;

        const sent = await this.sendWhatsAppMessage(phone, message, replyJid);
        logger.info(`Sending no active job response to ${phone}, sent=${sent}`);
        return { success: sent, message: sent ? 'Response sent' : 'Failed to send response' };
    }

    async sendActionConfirmationResponse(phone, action, job, result, replyJid = null) {
        let message = '';

        switch (action) {
            case 'confirm_reception':
                message = `*TUGAS BERHASIL DITERIMA*

Anda sudah menerima tugas instalasi baru.

Detail Job:
- No. Job: ${job.job_number}
- Pelanggan: ${job.customer_name}
- Status: Ditugaskan

Silakan siapkan peralatan. Jika sudah mulai bekerja, balas *MULAI*.

*${getCompanyHeader()}*`;
                break;

            case 'start_installation':
                message = `*PEKERJAAN SEDANG DIPROSES*

Selamat mengerjakan, pekerjaan instalasi sudah ditandai mulai.

Detail Job:
- No. Job: ${job.job_number}
- Pelanggan: ${job.customer_name}
- Status: Sedang Berlangsung

Setelah selesai, balas *SELESAI*.

*${getCompanyHeader()}*`;
                break;

            case 'complete_installation':
                message = `*INSTALASI BERHASIL DISELESAIKAN*

Terima kasih, tugas instalasi sudah ditandai selesai.

Detail Job:
- No. Job: ${job.job_number}
- Pelanggan: ${job.customer_name}
- Status: Selesai
- Catatan: ${result.notes || 'Tidak ada catatan'}

Pelanggan akan menerima notifikasi penyelesaian dari sistem.

*${getCompanyHeader()}*`;
                break;

            case 'help_requested':
                message = `*PERMINTAAN BANTUAN DITERIMA*

Permintaan bantuan Anda telah diterima:

Detail Job:
- No. Job: ${job.job_number}
- Pelanggan: ${job.customer_name}

Tim support akan segera menghubungi Anda.

Support: ${getSetting('contact_whatsapp', '082130077713')}

*${getCompanyHeader()}*`;
                break;

            case 'problem_reported':
                message = `*LAPORAN MASALAH DITERIMA*

Laporan masalah Anda telah diterima:

Detail Job:
- No. Job: ${job.job_number}
- Pelanggan: ${job.customer_name}

Tim support akan segera menindaklanjuti.

Support: ${getSetting('contact_whatsapp', '082130077713')}

*${getCompanyHeader()}*`;
                break;

            case 'additional_reported':
                message = `*LAPORAN TAMBAHAN DITERIMA*

Laporan tambahan Anda telah diterima:

Detail Job:
- No. Job: ${job.job_number}
- Pelanggan: ${job.customer_name}

Terima kasih atas informasi tambahan.

*${getCompanyHeader()}*`;
                break;

            case 'show_menu': {
                const onlineCount = result && result.pppoe ? result.pppoe.onlineCount : 0;
                const offlineCount = result && result.pppoe ? result.pppoe.offlineCount : 0;
                const techName = result && result.technicianName ? result.technicianName : 'Teknisi';

                message = `*MENU TEKNISI*

Halo ${techName},

Status PPPoE Saat Ini:
- Online: ${onlineCount}
- Offline: ${offlineCount}

Perintah Utama:
- MENU / TEKNISI
- PPPOE STATUS (cek online/offline)
- CHECKPPPOE [username]
- TERIMA / MULAI / SELESAI
- BANTU / MASALAH / LAPOR

Contoh:
- CHECKPPPOE rakha
- PPPOE STATUS

*${getCompanyHeader()}*`;
                break;
            }

            case 'pppoe_status': {
                const onlineCount = result ? result.onlineCount : 0;
                const offlineCount = result ? result.offlineCount : 0;

                message = `*STATUS PPPoE*

- Online: ${onlineCount}
- Offline: ${offlineCount}

Ketik:
- CHECKPPPOE [username]
untuk cek user tertentu.

*${getCompanyHeader()}*`;
                break;
            }

            case 'check_pppoe': {
                if (!result || result.needsExample) {
                    message = `*FORMAT CEK PPPoE*

Gunakan format:
- CHECKPPPOE [username]

Contoh:
- CHECKPPPOE rakha

*${getCompanyHeader()}*`;
                    break;
                }

                if (!result.success) {
                    message = `*USER PPPoE TIDAK DITEMUKAN*

Username: ${result.username || '-'}

Gunakan format:
- CHECKPPPOE [username]

Contoh:
- CHECKPPPOE rakha

*${getCompanyHeader()}*`;
                    break;
                }

                const statusAkun = result.secretStatus === 'active' ? 'Aktif' : 'Disabled';
                const statusKoneksi = result.connected ? 'Online' : 'Offline';

                message = `*DETAIL STATUS PPPoE*

- Username: ${result.username}
- Profile: ${result.profile}
- Status Akun: ${statusAkun}
- Status Koneksi: ${statusKoneksi}
- IP Address: ${result.ip}
- Uptime: ${result.uptime}
- Caller ID: ${result.callerId}

Perintah lain:
- PPPOE STATUS
- MENU

*${getCompanyHeader()}*`;
                break;
            }

            default:
                message = `*AKSI BERHASIL DIPROSES*

Aksi Anda telah berhasil diproses oleh sistem.

*${getCompanyHeader()}*`;
        }

        const sent = await this.sendWhatsAppMessage(phone, message, replyJid);
        logger.info(`Sending action confirmation response to ${phone} for action: ${action}, sent=${sent}`);
        return { success: sent, message: sent ? 'Response sent' : 'Failed to send response' };
    }
}

module.exports = new WhatsAppMessageHandler();




