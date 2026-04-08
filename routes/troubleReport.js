const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getSetting } = require('../config/settingsManager');
const { getVersionInfo, getVersionBadge } = require('../config/version-utils');
const { findDeviceByTag } = require('../config/addWAN');
const billingManager = require('../config/billing');
const { 
  createTroubleReport, 
  getTroubleReportsByPhone, 
  updateTroubleReportStatus,
  getTroubleReportById
} = require('../config/troubleReport');
const { notifyAdmins, notifyTechnicians } = require('../config/pushEventNotifier');

const troubleAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      const uploadPath = path.join(__dirname, '../public/img/trouble-attachments');
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }
      cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase();
      const phone = getSessionPhone(req) || 'customer';
      const safePhone = String(phone).replace(/[^0-9a-z]/gi, '-');
      cb(null, `trouble-${safePhone}-${Date.now()}${ext}`);
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
    fileSize: 4 * 1024 * 1024
  }
});

// Middleware untuk memastikan pelanggan sudah login
function customerAuth(req, res, next) {
  console.log('🔍 customerAuth middleware - Session:', req.session);
  console.log('🔍 customerAuth middleware - Session phone:', req.session?.phone);
  console.log('🔍 customerAuth middleware - Session customer_username:', req.session?.customer_username);
  
  const phone = req.session && (req.session.phone || req.session.customer_phone);
  const username = req.session && req.session.customer_username;
  
  if (!phone && !username) {
    console.log('❌ customerAuth: No session phone or username, redirecting to login');
    return res.redirect('/customer/login');
  }
  
  // Set phone in session if not present but username is available
  if (!req.session.phone && username) {
    // Try to get phone from billing system
    billingManager.getCustomerByUsername(username).then(customer => {
      if (customer && customer.phone) {
        req.session.phone = customer.phone;
      }
    }).catch(err => {
      console.log('Warning: Could not get customer phone from username:', err.message);
    });
  }
  
  console.log('✅ customerAuth: Session valid, phone:', phone, 'username:', username);
  next();
}

function getSessionPhone(req) {
  if (!req.session) return '';
  return req.session.phone || req.session.customer_phone || req.session?.customer?.phone || '';
}

async function resolveCustomer(req) {
  const username = req.session && req.session.customer_username;
  const phone = getSessionPhone(req);
  const tempPhone = (typeof username === 'string' && username.startsWith('temp_')) ? username.replace('temp_', '') : '';

  try {
    if (username) {
      const byUsername = await billingManager.getCustomerByUsername(username);
      if (byUsername) return byUsername;
    }
    const phoneCandidates = [phone, tempPhone].filter(Boolean);
    for (const ph of phoneCandidates) {
      const byPhone = await billingManager.getCustomerByPhone(ph);
      if (byPhone) return byPhone;
    }
  } catch (err) {
    console.warn('resolveCustomer warning:', err.message);
  }

  return null;
}
// GET: Halaman form laporan gangguan
router.get('/report', customerAuth, async (req, res) => {
  const phone = getSessionPhone(req);
  const billingCustomer = await resolveCustomer(req);
  const effectivePhone = phone || billingCustomer?.phone || '';
  
  // Dapatkan data pelanggan dari GenieACS
  const device = await findDeviceByTag(effectivePhone);
  const customerName = billingCustomer?.name || req.session?.customer?.name || req.session?.customer_name || device?.Tags?.find(tag => tag !== effectivePhone) || '';
  const location = billingCustomer?.address || req.session?.customer?.address || req.session?.customer_address || device?.Tags?.join(', ') || '';
  
  // Dapatkan kategori gangguan dari settings
  const categoriesString = getSetting('trouble_report.categories', 'Internet Lambat,Tidak Bisa Browsing,WiFi Tidak Muncul,Koneksi Putus-Putus,Lainnya');
  const categories = categoriesString.split(',').map(cat => cat.trim());
  
  // Dapatkan laporan gangguan sebelumnya
  const previousReports = getTroubleReportsByPhone(effectivePhone);
  
  // Render halaman form laporan gangguan
  res.render('trouble-report-form', {
    customer: billingCustomer,
    phone: effectivePhone,
    customerName,
    location,
    categories,
    previousReports,
    companyHeader: getSetting('company_header', 'ISP Monitor'),
    footerInfo: getSetting('footer_info', ''),
    versionInfo: getVersionInfo(),
    versionBadge: getVersionBadge()
  });
});

// Alias: /customer/trouble/simple -> redirect ke /customer/trouble/report
router.get('/simple', (req, res) => {
  return res.redirect('/customer/trouble/report');
});

// POST: Submit laporan gangguan
router.post('/report', customerAuth, troubleAttachmentUpload.single('device_photo'), async (req, res) => {
  const phone = getSessionPhone(req);
  const { name, location, category, description } = req.body;
  const billingCustomer = await resolveCustomer(req);
  const effectivePhone = phone || billingCustomer?.phone || '';
  
  console.log('📝 POST /trouble/report - Session phone:', phone);
  console.log('📋 Request body:', req.body);
  
  // Validasi input
  if (!category || !description) {
    console.log('❌ Validation failed: missing category or description');
    return res.status(400).json({
      success: false,
      message: 'Kategori dan deskripsi masalah wajib diisi'
    });
  }
  
  // Buat laporan gangguan baru
  const report = createTroubleReport({
    phone: effectivePhone,
    name: (name || '').trim() || billingCustomer?.name || 'Pelanggan',
    location: (location || '').trim() || billingCustomer?.address || '-',
    category,
    description,
    device_photo: req.file ? req.file.filename : null
  });
  
  if (!report) {
    console.log('❌ Failed to create trouble report');
    return res.status(500).json({
      success: false,
      message: 'Gagal membuat laporan gangguan'
    });
  }
  
  console.log('✅ Trouble report created successfully:', report.id);
  
  console.log('✅ Sending JSON response:', {
    success: true,
    message: 'Laporan gangguan berhasil dibuat',
    reportId: report.id
  });
  
  // Redirect ke halaman detail laporan
  res.json({
    success: true,
    message: 'Laporan gangguan berhasil dibuat',
    reportId: report.id
  });

  setImmediate(async () => {
    const notification = {
      title: 'Laporan gangguan baru',
      message: `${report.name || 'Pelanggan'} melaporkan ${report.category || 'gangguan baru'}.`,
      url: `/admin/trouble/detail/${report.id}`,
      tag: `trouble-new-${report.id}`
    };

    await Promise.allSettled([
      notifyAdmins(notification),
      notifyTechnicians({
        ...notification,
        url: `/technician/troubletickets/detail/${report.id}`
      })
    ]);
  });
});

// GET: Test route untuk debugging (tanpa session)
router.get('/test', async (req, res) => {
  console.log('🧪 GET /trouble/test - Query params:', req.query);
  
  const { name, phone, location, category, description } = req.query;
  
  // Validasi input
  if (!category || !description) {
    return res.status(400).json({
      success: false,
      message: 'Kategori dan deskripsi masalah wajib diisi'
    });
  }
  
  // Buat laporan gangguan baru
  const report = createTroubleReport({
    phone: phone || '081321960111',
    name: name || 'Test Customer',
    location: location || 'Test Location',
    category,
    description
  });
  
  if (!report) {
    return res.status(500).json({
      success: false,
      message: 'Gagal membuat laporan gangguan'
    });
  }
  
  console.log('✅ Test trouble report created successfully:', report.id);
  
  res.json({
    success: true,
    message: 'Laporan gangguan berhasil dibuat (test)',
    reportId: report.id
  });
});

// POST: Test route untuk debugging (tanpa session)
router.post('/test', async (req, res) => {
  console.log('🧪 POST /trouble/test - Body:', req.body);
  
  const { name, phone, location, category, description } = req.body;
  
  // Validasi input
  if (!category || !description) {
    return res.status(400).json({
      success: false,
      message: 'Kategori dan deskripsi masalah wajib diisi'
    });
  }
  
  // Buat laporan gangguan baru
  const report = createTroubleReport({
    phone: phone || '081321960111',
    name: name || 'Test Customer',
    location: location || 'Test Location',
    category,
    description
  });
  
  if (!report) {
    return res.status(500).json({
      success: false,
      message: 'Gagal membuat laporan gangguan'
    });
  }
  
  console.log('✅ Test trouble report created successfully:', report.id);
  
  res.json({
    success: true,
    message: 'Laporan gangguan berhasil dibuat (test POST)',
    reportId: report.id
  });
});

// GET: Halaman daftar laporan gangguan pelanggan
router.get('/list', customerAuth, async (req, res) => {
  const phone = getSessionPhone(req);
  const customer = await resolveCustomer(req);
  
  // Dapatkan semua laporan gangguan pelanggan
  const reports = getTroubleReportsByPhone(phone);
  
  // Render halaman daftar laporan
  res.render('trouble-report-list', {
    customer,
    phone,
    reports,
    companyHeader: getSetting('company_header', 'ISP Monitor'),
    footerInfo: getSetting('footer_info', ''),
    versionInfo: getVersionInfo(),
    versionBadge: getVersionBadge()
  });
});

// GET: Halaman detail laporan gangguan
router.get('/detail/:id', customerAuth, async (req, res) => {
  const phone = getSessionPhone(req);
  const reportId = req.params.id;
  const customer = await resolveCustomer(req);
  
  // Dapatkan detail laporan
  const report = getTroubleReportById(reportId);
  
  // Validasi laporan ditemukan dan milik pelanggan yang login
  if (!report || report.phone !== phone) {
    return res.redirect('/customer/trouble/list');
  }
  
  // Render halaman detail laporan
  res.render('trouble-report-detail', {
    customer,
    phone,
    report,
    companyHeader: getSetting('company_header', 'ISP Monitor'),
    footerInfo: getSetting('footer_info', ''),
    versionInfo: getVersionInfo(),
    versionBadge: getVersionBadge()
  });
});

// POST: Tambah komentar pada laporan
router.post('/comment/:id', customerAuth, (req, res) => {
  const phone = getSessionPhone(req);
  const reportId = req.params.id;
  const { comment } = req.body;
  const cleanComment = String(comment || '').trim();
  
  // Dapatkan detail laporan
  const report = getTroubleReportById(reportId);
  
  // Validasi laporan ditemukan dan milik pelanggan yang login
  if (!report || report.phone !== phone) {
    return res.status(403).json({
      success: false,
      message: 'Laporan tidak ditemukan atau Anda tidak memiliki akses'
    });
  }

  if (!cleanComment) {
    return res.status(400).json({
      success: false,
      message: 'Balasan tidak boleh kosong'
    });
  }
  
  // Update laporan dengan balasan baru
  const updatedReport = updateTroubleReportStatus(reportId, report.status, `[Pelanggan]: ${cleanComment}`);
  
  if (!updatedReport) {
    return res.status(500).json({
      success: false,
      message: 'Gagal mengirim balasan'
    });
  }
  
  res.json({
    success: true,
    message: 'Balasan berhasil dikirim'
  });

  setImmediate(async () => {
    const notification = {
      title: `Balasan pelanggan ${updatedReport.id}`,
      message: cleanComment,
      url: `/admin/trouble/detail/${updatedReport.id}`,
      tag: `trouble-customer-reply-${updatedReport.id}`
    };

    await Promise.allSettled([
      notifyAdmins(notification),
      notifyTechnicians({
        ...notification,
        url: `/technician/troubletickets/detail/${updatedReport.id}`
      })
    ]);
  });
});

// POST: Tutup laporan (hanya jika status resolved)
router.post('/close/:id', customerAuth, (req, res) => {
  const phone = getSessionPhone(req);
  const reportId = req.params.id;
  
  // Dapatkan detail laporan
  const report = getTroubleReportById(reportId);
  
  // Validasi laporan ditemukan dan milik pelanggan yang login
  if (!report || report.phone !== phone) {
    return res.status(403).json({
      success: false,
      message: 'Laporan tidak ditemukan atau Anda tidak memiliki akses'
    });
  }
  
  // Hanya bisa menutup laporan jika status resolved
  if (report.status !== 'resolved') {
    return res.status(400).json({
      success: false,
      message: 'Hanya laporan dengan status "Terselesaikan" yang dapat ditutup'
    });
  }
  
  // Update status laporan menjadi closed
  const updatedReport = updateTroubleReportStatus(reportId, 'closed', '[Pelanggan]: Laporan ditutup oleh pelanggan');
  
  if (!updatedReport) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menutup laporan'
    });
  }
  
  res.json({
    success: true,
    message: 'Laporan berhasil ditutup'
  });
});

module.exports = router;

