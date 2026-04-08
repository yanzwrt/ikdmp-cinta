const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const billingManager = require('../config/billing');
const whatsappNotifications = require('../config/whatsapp-notifications');
const logger = require('../config/logger');
const { getAdmins } = require('../config/adminControl');

const router = express.Router();
const dbPath = path.join(__dirname, '../data/billing.db');
const db = new sqlite3.Database(dbPath);

const ALLOWED_SPEEDS = ['10', '15', '20'];

const publicHousePhotoStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, '../public/img/customer-houses');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `public-register-house-${uniqueSuffix}${ext}`);
    }
});

const imageFileFilter = (req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpg' || file.mimetype === 'image/jpeg') {
        cb(null, true);
    } else {
        cb(new Error('Hanya file PNG, JPG, dan JPEG yang diizinkan'), false);
    }
};

const uploadPublicHousePhoto = multer({
    storage: publicHousePhotoStorage,
    fileFilter: imageFileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

function handlePublicHousePhotoUpload(req, res, next) {
    uploadPublicHousePhoto.single('house_photo')(req, res, (err) => {
        if (!err) {
            return next();
        }

        logger.error('Public registration photo upload error:', err);

        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({
                    success: false,
                    message: 'Ukuran foto rumah terlalu besar. Maksimal 10 MB.'
                });
            }

            return res.status(400).json({
                success: false,
                message: `Upload foto gagal: ${err.message}`
            });
        }

        return res.status(400).json({
            success: false,
            message: err.message || 'Upload foto rumah gagal'
        });
    });
}

function normalizePhoneToLocal(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('0')) return digits;
    if (digits.startsWith('62')) return '0' + digits.slice(2);
    if (digits.startsWith('8')) return '0' + digits;
    return digits;
}

function slugifyName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '') || 'pelanggan';
}

function pad2(v) {
    return String(v).padStart(2, '0');
}

function formatDateYYYYMMDD(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTimeHHMM(d = new Date()) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function makeUsername(name) {
    const d = new Date();
    const datePart = `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${String(d.getFullYear()).slice(-2)}`;
    const rand = Math.floor(Math.random() * 900 + 100);
    return `${slugifyName(name)}_${datePart}${rand}`;
}

function makePublicPPPoEUsername(name) {
    const slug = slugifyName(name);
    const firstName = String(slug || 'pelanggan')
        .split('_')
        .filter(Boolean)[0] || 'pelanggan';

    return `ikdmp@${firstName}`;
}

function isAllowedPackage(pkg) {
    const source = `${pkg?.name || ''} ${pkg?.speed || ''}`.toLowerCase();
    return ALLOWED_SPEEDS.some(speed => new RegExp(`(^|[^0-9])${speed}([^0-9]|$)`).test(source));
}

function getAllowedPackages() {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT id, name, speed, price FROM packages WHERE is_active = 1 ORDER BY id ASC',
            (err, rows) => {
                if (err) return reject(err);
                const filtered = (rows || []).filter(isAllowedPackage);
                resolve(filtered);
            }
        );
    });
}

function getLeastBusyTechnician() {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT t.id, t.name, t.phone, COALESCE(j.active_jobs, 0) AS active_jobs
            FROM technicians t
            LEFT JOIN (
                SELECT assigned_technician_id, COUNT(*) AS active_jobs
                FROM installation_jobs
                WHERE status IN ('assigned', 'in_progress')
                GROUP BY assigned_technician_id
            ) j ON j.assigned_technician_id = t.id
            WHERE t.is_active = 1
            ORDER BY active_jobs ASC, t.id ASC
            LIMIT 1
        `;

        db.get(sql, [], (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function normalizePhoneToWhatsApp(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('62')) return digits;
    if (digits.startsWith('0')) return `62${digits.slice(1)}`;
    if (digits.startsWith('8')) return `62${digits}`;
    return digits;
}

function getActiveTechnicians() {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT id, name, phone, role
             FROM technicians
             WHERE is_active = 1
             ORDER BY name ASC, id ASC`,
            [],
            (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            }
        );
    });
}

function getAdminRecipients() {
    const admins = Array.isArray(getAdmins()) ? getAdmins() : [];
    const normalized = admins
        .map(normalizePhoneToWhatsApp)
        .filter(Boolean);

    return [...new Set(normalized)];
}

function generateInstallationJobNumber() {
    return new Promise((resolve, reject) => {
        const now = new Date();
        const prefix = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;

        db.get(
            'SELECT job_number FROM installation_jobs WHERE job_number LIKE ? ORDER BY job_number DESC LIMIT 1',
            [`INS-${prefix}-%`],
            (err, row) => {
                if (err) return reject(err);

                let next = 1;
                if (row && row.job_number) {
                    const last = parseInt(row.job_number.split('-').pop(), 10);
                    if (Number.isFinite(last)) next = last + 1;
                }

                resolve(`INS-${prefix}-${String(next).padStart(3, '0')}`);
            }
        );
    });
}

function insertInstallationJob(payload) {
    return new Promise((resolve, reject) => {
        const sql = `
            INSERT INTO installation_jobs (
                job_number, customer_name, customer_phone, customer_address,
                package_id, installation_date, installation_time, assigned_technician_id,
                status, priority, notes, equipment_needed, estimated_duration,
                customer_latitude, customer_longitude, created_by_admin_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(
            sql,
            [
                payload.job_number,
                payload.customer_name,
                payload.customer_phone,
                payload.customer_address,
                payload.package_id,
                payload.installation_date,
                payload.installation_time,
                payload.assigned_technician_id,
                payload.status,
                payload.priority,
                payload.notes,
                payload.equipment_needed,
                payload.estimated_duration,
                payload.customer_latitude,
                payload.customer_longitude,
                payload.created_by_admin_id
            ],
            function onRun(err) {
                if (err) return reject(err);
                resolve(this.lastID);
            }
        );
    });
}

function insertInstallationHistory(jobId, status, note) {
    return new Promise((resolve, reject) => {
        const sql = `
            INSERT INTO installation_job_status_history (
                job_id, old_status, new_status, changed_by_type, changed_by_id, notes
            ) VALUES (?, NULL, ?, 'admin', ?, ?)
        `;

        db.run(sql, [jobId, status, 'public_registration_form', note], (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

router.get('/register', async (req, res) => {
    try {
        const packages = await getAllowedPackages();
        res.render('customer/public-register', {
            title: 'Pendaftaran Pelanggan Baru',
            packages,
            selectedPackageId: req.query.package_id || '',
            success: req.query.success || '',
            message: req.query.message || '',
            jobNumber: req.query.job || ''
        });
    } catch (error) {
        logger.error('Error loading public register form:', error);
        res.status(500).send('Gagal memuat form pendaftaran');
    }
});

router.get('/', (req, res) => {
    res.redirect('/customer/register');
});

router.post('/register', handlePublicHousePhotoUpload, async (req, res) => {
    try {
        const { name, phone, email, address, latitude, longitude, package_id, requested_ssid, requested_wifi_password } = req.body;

        if (!name || !phone || !package_id) {
            return res.status(400).json({ success: false, message: 'Nama, No HP, dan Paket wajib diisi' });
        }

        if (latitude === undefined || longitude === undefined || latitude === '' || longitude === '') {
            return res.status(400).json({ success: false, message: 'Lokasi GPS wajib diambil terlebih dahulu' });
        }

        const allowedPackages = await getAllowedPackages();
        const selectedPackage = allowedPackages.find(p => String(p.id) === String(package_id));
        if (!selectedPackage) {
            return res.status(400).json({ success: false, message: 'Paket tidak valid. Pilih 10/15/20 Mbps.' });
        }

        const normalizedPhone = normalizePhoneToLocal(phone);
        const username = makeUsername(name);
        const pppoeUsername = makePublicPPPoEUsername(name);

        const customerData = {
            name: String(name).trim(),
            username,
            phone: normalizedPhone,
            pppoe_username: pppoeUsername,
            email: email && String(email).trim() ? String(email).trim() : `${slugifyName(name)}@pelanggan.local`,
            address: String(address || 'Alamat belum diisi').trim(),
            package_id: selectedPackage.id,
            pppoe_profile: 'default',
            status: 'active',
            auto_suspension: 1,
            billing_day: 15,
            house_photo: req.file ? req.file.filename : null,
            requested_ssid: String(requested_ssid || '').trim(),
            requested_wifi_password: String(requested_wifi_password || '').trim(),
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude)
        };

        const customer = await billingManager.createCustomer(customerData);

        const activeTechnicians = await getActiveTechnicians();
        const jobNumber = await generateInstallationJobNumber();
        const installationDate = formatDateYYYYMMDD(new Date());
        const installationTime = formatTimeHHMM(new Date());
        const initialStatus = 'scheduled';

        const requestedWifiText = customerData.requested_ssid || customerData.requested_wifi_password
            ? [
                'Permintaan WiFi Pelanggan:',
                `- SSID: ${customerData.requested_ssid || '-'}`,
                `- Password: ${customerData.requested_wifi_password || '-'}`
            ].join('\n')
            : 'Permintaan WiFi Pelanggan:\n- SSID: -\n- Password: -';

        const detailedRegistrationNote = [
            'Pendaftaran otomatis dari form pelanggan baru',
            requestedWifiText,
            `Email: ${customerData.email || '-'}`,
            `Latitude: ${customerData.latitude}`,
            `Longitude: ${customerData.longitude}`,
            `Foto Rumah: ${customerData.house_photo ? 'Ada' : 'Tidak ada'}`
        ].join('\n');

        const jobId = await insertInstallationJob({
            job_number: jobNumber,
            customer_name: customerData.name,
            customer_phone: customerData.phone,
            customer_address: customerData.address,
            package_id: selectedPackage.id,
            installation_date: installationDate,
            installation_time: installationTime,
            assigned_technician_id: null,
            status: initialStatus,
            priority: 'normal',
            notes: detailedRegistrationNote,
            equipment_needed: 'Standard equipment',
            estimated_duration: 120,
            customer_latitude: customerData.latitude,
            customer_longitude: customerData.longitude,
            created_by_admin_id: 'public_registration_form'
        });

        await insertInstallationHistory(jobId, initialStatus, `Job instalasi dibuat dari pendaftaran publik: ${jobNumber}`);

        if (activeTechnicians.length > 0) {
            const installationDateLabel = new Date(installationDate).toLocaleDateString('id-ID');
            const broadcastMessage = [
                '*FORM PENDAFTARAN PELANGGAN BARU MASUK*',
                '',
                `No. Job: ${jobNumber}`,
                `Pelanggan: ${customerData.name}`,
                `No HP: ${customerData.phone}`,
                `Email: ${customerData.email || '-'}`,
                `Alamat: ${customerData.address}`,
                `Paket: ${selectedPackage.name || 'N/A'}`,
                `PPPoE Username: ${customerData.pppoe_username || '-'}`,
                `SSID Diminta: ${customerData.requested_ssid || '-'}`,
                `Password WiFi Diminta: ${customerData.requested_wifi_password || '-'}`,
                `Latitude: ${customerData.latitude}`,
                `Longitude: ${customerData.longitude}`,
                `Foto Rumah: ${customerData.house_photo ? 'Ada' : 'Tidak ada'}`,
                `Tanggal: ${installationDateLabel}`,
                `Jam: ${installationTime}`,
                'PIC Saat Ini: Belum ditentukan',
                '',
                'Notifikasi ini dikirim ke semua teknisi agar seluruh tim langsung mengetahui isi pendaftaran pelanggan baru.',
                'Admin akan menunjuk PIC setelah review job di dashboard / WhatsApp.'
            ].join('\n');

            for (const tech of activeTechnicians) {
                const techPhone = String(tech.phone || '');
                if (!techPhone) {
                    continue;
                }

                try {
                    await whatsappNotifications.sendNotification(techPhone, broadcastMessage);
                } catch (broadcastError) {
                    logger.error(`Error broadcasting installation schedule to technician ${tech.name}:`, broadcastError);
                }
            }
        }

        const adminRecipients = getAdminRecipients();
        if (adminRecipients.length > 0) {
            const installationDateLabel = new Date(installationDate).toLocaleDateString('id-ID');
            const adminMessage = [
                '*FORM PENDAFTARAN BARU MASUK KE ADMIN*',
                '',
                `No. Job: ${jobNumber}`,
                `Pelanggan: ${customerData.name}`,
                `No HP: ${customerData.phone}`,
                `Email: ${customerData.email || '-'}`,
                `Alamat: ${customerData.address}`,
                `Paket: ${selectedPackage.name || 'N/A'}`,
                `PPPoE Username: ${customerData.pppoe_username || '-'}`,
                `SSID Diminta: ${customerData.requested_ssid || '-'}`,
                `Password WiFi Diminta: ${customerData.requested_wifi_password || '-'}`,
                `Latitude: ${customerData.latitude}`,
                `Longitude: ${customerData.longitude}`,
                `Foto Rumah: ${customerData.house_photo ? 'Ada' : 'Tidak ada'}`,
                `Tanggal: ${installationDateLabel}`,
                `Jam: ${installationTime}`,
                'PIC Saat Ini: Belum ditentukan',
                '',
                'Data form lengkap ini dikirim otomatis dari pendaftaran pelanggan baru.',
                '',
                'Untuk menunjuk PIC lewat WhatsApp admin:',
                `PIC ${jobNumber} Nama Teknisi`,
                '',
                `Contoh: PIC ${jobNumber} Akmaludin`
            ].join('\n');

            for (const adminPhone of adminRecipients) {
                try {
                    await whatsappNotifications.sendNotification(adminPhone, adminMessage);
                } catch (adminNotifyError) {
                    logger.error(`Error sending public registration form to admin ${adminPhone}:`, adminNotifyError);
                }
            }
        }

        return res.json({
            success: true,
            message: 'Pendaftaran berhasil. Data masuk ke pelanggan dan jadwal instalasi.',
            customerId: customer.id,
            jobId,
            jobNumber,
            assignedTechnician: null
        });
    } catch (error) {
        logger.error('Error creating public registration:', error);

        let message = 'Gagal memproses pendaftaran';
        if (error.message && error.message.includes('UNIQUE constraint failed')) {
            if (error.message.includes('customers.phone')) {
                message = 'Nomor HP sudah terdaftar sebagai pelanggan';
            } else if (error.message.includes('customers.username')) {
                message = 'Username pelanggan bentrok, silakan coba ulang';
            }
        }

        return res.status(500).json({ success: false, message, error: error.message });
    }
});

module.exports = router;


