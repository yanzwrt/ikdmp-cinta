# 🚀 GEMBOK-BILL - Deploy Guide

## 📋 Quick Deploy

### 1. Clone Repository
```bash
git clone https://github.com/alijayanet/gembok-bill
cd gembok-bill
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Settings
```bash
# Copy template settings
cp settings.server.template.json settings.json

# Edit settings sesuai server
nano settings.json
```

### 4. Setup Database
```bash
# Database akan dibuat otomatis saat pertama kali run
# Atau restore dari backup:
# cp backup/billing.db data/billing.db
```

### 5. Run Application
```bash
# Development
npm run dev

# Production
npm start

# Atau dengan PM2
pm2 start app.js --name gembok-bill
pm2 save
pm2 startup
```

## 🔧 Configuration

### Server Settings
Edit `settings.json` dengan konfigurasi server Anda:

- **server_host**: IP server Anda
- **server_port**: Port aplikasi (default: 3003)
- **genieacs_url**: URL GenieACS server
- **mikrotik_host**: IP Mikrotik router
- **admin_password**: Password admin (ubah dari default)

### Database
- Database SQLite akan dibuat otomatis di `data/billing.db`
- Backup database tersimpan di `data/backup/`
- Restore database via admin panel

### WhatsApp Bot
- WhatsApp session akan dibuat otomatis
- Scan QR code saat pertama kali run
- Session tersimpan di `whatsapp-session/`

## 📊 Features

### ✅ Backup & Restore
- Database backup otomatis
- Manual backup via admin panel
- Restore database dengan mudah
- Export data ke Excel

### ✅ Export Excel
- Export customers lengkap
- Export financial reports
- Export dengan styling dan summary

### ✅ WhatsApp Bot
- Admin commands
- Technician commands
- Customer commands
- Auto-notifications

### ✅ Network Mapping
- ODP management
- Cable routing
- Real-time device status
- Technician access

## 🔧 Troubleshooting

### Database Error
```bash
# Cek permissions
chmod 755 data/
chmod 644 data/billing.db

# Restore dari backup
cp data/backup/latest.db data/billing.db
```

### Dependencies Error
```bash
# Clear cache dan install ulang
rm -rf node_modules package-lock.json
npm install
```

### WhatsApp Error
```bash
# Hapus session dan restart
rm -rf whatsapp-session/
pm2 restart gembok-bill
```

## 📞 Support

- **Documentation**: README.md
- **Issues**: GitHub Issues
- **Contact**: 081947215703

---

**GEMBOK-BILL v2.1.1** - WhatsApp Modular + Role System + Network Mapping
