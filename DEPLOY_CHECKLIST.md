
# 📋 CHECKLIST DEPLOY VIA GITHUB

## ✅ Pre-Deploy Checklist

### 1. File & Direktori
- [ ] Semua file source code sudah di-commit ke GitHub
- [ ] File settings.json sudah dikonfigurasi untuk server
- [ ] File .gitignore sudah mengabaikan file sensitif (database, logs, session)

### 2. Dependencies
- [ ] package.json sudah lengkap dengan semua dependencies
- [ ] Node.js version >= 14.0.0 (direkomendasikan v18+)
- [ ] npm atau yarn tersedia di server

### 3. Database
- [ ] Database akan dibuat otomatis saat pertama kali run
- [ ] Atau upload database backup ke server
- [ ] Pastikan direktori data/ ada dan writable

### 4. Konfigurasi Server
- [ ] settings.json sudah disesuaikan dengan server
- [ ] IP address, port, dan credentials sudah benar
- [ ] WhatsApp session akan dibuat otomatis

## 🚀 Deploy Steps

### 1. Clone dari GitHub
```bash
git clone https://github.com/alijayanet/gembok-bill
cd gembok-bill
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Konfigurasi
```bash
# Edit settings.json sesuai server
nano settings.json
```

### 4. Setup Database (jika belum ada)
```bash
# Database akan dibuat otomatis saat pertama kali run
# Atau restore dari backup:
# cp backup/billing.db data/billing.db
```

### 5. Jalankan Aplikasi
```bash
# Development
npm run dev

# Production
npm start

# Atau dengan PM2
pm2 start app.js --name gembok-bill
```

## 🔧 Post-Deploy Verification

### 1. Cek Aplikasi
- [ ] Aplikasi berjalan tanpa error
- [ ] Web interface bisa diakses
- [ ] Database terhubung dengan baik

### 2. Cek Fitur Backup/Restore
- [ ] Halaman admin settings bisa diakses
- [ ] Fitur backup database berfungsi
- [ ] Fitur restore database berfungsi

### 3. Cek Fitur Export
- [ ] Export customers ke Excel berfungsi
- [ ] Export financial report berfungsi
- [ ] File Excel bisa didownload

### 4. Cek WhatsApp Bot
- [ ] WhatsApp bot terhubung
- [ ] QR code bisa di-scan
- [ ] Commands berfungsi

## ⚠️ Troubleshooting

### Database Error
- Cek permissions direktori data/
- Restore dari backup jika perlu
- Cek log aplikasi untuk error detail

### Dependencies Error
- Jalankan npm install --force
- Cek Node.js version
- Update npm jika perlu

### WhatsApp Error
- Hapus folder whatsapp-session/
- Restart aplikasi
- Scan QR code ulang

### Backup/Restore Error
- Cek permissions direktori backup/
- Cek disk space
- Cek log aplikasi
