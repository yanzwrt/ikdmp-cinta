const express = require('express');
const router = express.Router();

const billingManager = require('../config/billing');
const { getSetting } = require('../config/settingsManager');

function toWhatsAppLink(phone = '') {
  const normalized = String(phone).replace(/\D/g, '');
  return normalized ? `https://wa.me/${normalized}` : '#';
}

function formatPrice(value) {
  return new Intl.NumberFormat('id-ID').format(Number(value || 0));
}

router.get('/', async (req, res) => {
  let packages = [];
  const preferredPackages = ['IKDMP-10 Mbps', 'IKDMP-15 Mbps', 'IKDMP-20 Mbps'];
  const normalizePackageName = (value = '') => String(value).replace(/\s+/g, ' ').trim().toLowerCase();

  try {
    const packageRows = await billingManager.getAllPackages();
    const validPackages = (packageRows || []).filter((pkg) => Number(pkg.price || 0) > 0);

    const preferredResults = preferredPackages
      .map((name) => validPackages.find((pkg) => normalizePackageName(pkg.name) === normalizePackageName(name)))
      .filter(Boolean);

    const fallbackResults = validPackages
      .filter((pkg) => !preferredResults.some((picked) => picked.id === pkg.id))
      .sort((a, b) => Number(a.price || 0) - Number(b.price || 0));

    packages = [...preferredResults, ...fallbackResults]
      .slice(0, 3)
      .map((pkg, index) => ({
        ...pkg,
        isPopular: index === 1,
        formattedPrice: formatPrice(pkg.price),
        speedLabel: pkg.speed || pkg.bandwidth || pkg.profile_name || 'Fiber Optic'
      }));
  } catch (error) {
    packages = [];
  }

  res.render('landing', {
    appName: getSetting('app_name', 'IKDMP-CINTA'),
    companySlogan: getSetting('company_slogan', 'Solusi Internet Murah Berkualitas'),
    heroTitle: getSetting('landing.hero_title', 'Internet Cepat Tanpa Batas'),
    heroDescription: getSetting(
      'landing.hero_description',
      'Nikmati koneksi internet fiber optic yang murah, stabil, cepat, dan siap mendukung aktivitas harian Anda.'
    ),
    contactPhone: getSetting('contact_phone', '082130077713'),
    contactEmail: getSetting('contact_email', 'info@example.com'),
    contactAddress: getSetting('contact_address', 'Indonesia'),
    companyWebsite: getSetting('company_website', '#'),
    footerInfo: getSetting(
      'footer_info',
      'Penyedia layanan internet terpercaya dengan jaringan fiber optic berkualitas.'
    ),
    logoFilename: getSetting('logo_filename', 'logo.png'),
    heroWhatsappLink: toWhatsAppLink(getSetting('contact_phone', '082130077713')),
    features: [
      {
        icon: 'bi-lightning-charge-fill',
        title: getSetting('landing.feature_1_title', 'Kecepatan Tinggi'),
        description: getSetting(
          'landing.feature_1_description',
          'Koneksi fiber optic dengan performa stabil untuk streaming, meeting, dan kerja harian.'
        )
      },
      {
        icon: 'bi-wifi',
        title: getSetting('landing.feature_2_title', 'Jaringan Stabil'),
        description: getSetting(
          'landing.feature_2_description',
          'Monitoring jaringan aktif dan penanganan gangguan yang lebih cepat.'
        )
      },
      {
        icon: 'bi-headset',
        title: getSetting('landing.feature_3_title', 'Support Responsif'),
        description: getSetting(
          'landing.feature_3_description',
          'Tim support siap membantu ketika Anda membutuhkan bantuan atau penyesuaian layanan.'
        )
      }
    ],
    packages
  });
});

module.exports = router;
