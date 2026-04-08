 
  # Ikdmp-Cinta
  **Integrated ISP Management System**
  
  [![Node.js](https://img.shields.io/badge/Node.js-18.x-green?style=for-the-badge&logo=node.js)](https://nodejs.org/)
  [![License](https://img.shields.io/badge/license-ISC-blue?style=for-the-badge)](LICENSE)
  [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=for-the-badge)](https://github.com/yanzwrt/ikdmp-cinta/pulls)
  [![GitHub Stars](https://img.shields.io/github/stars/alijayanet/gembok-bill?style=for-the-badge)](https://github.com/yanzwrt/ikdmp-cinta/stargazers)


## 🌐 About Ikdmp-Cinta

**Ikdmp Cinta** is an integrated ISP management system designed to manage billing, customer service, and network operations through WhatsApp integration. This system provides end-to-end solutions for Internet Service Provider management with advanced features.

### 🚀 Main Features

- **📱 WhatsApp Gateway**: Customer interaction, voucher delivery, trouble reporting, and automated notifications
- **📡 GenieACS Integration**: Centralized CPE (Customer Premises Equipment) management
- **🔗 Mikrotik PPPoE & Hotspot Management**: User authentication and real-time bandwidth control
- **💳 Billing System**: Automated invoice generation payment tracking, and remittance
- **👥 Agent & Technician Management**: Flexible roles, access control, and job assignment
- **📂 Database Migration**: SQL-based schema updates for continuous development
- **🗺️ Cable Network Mapping**: Visual management of ODP, poles, and cable layouts

### 💬 WhatsApp Commands

The system supports WhatsApp LID (Lidded ID) registration for enhanced security and customer identification.

#### For Customers

| Command | Format | Description |
|---------|--------|-------------|
| **REG** | `REG [nama/nomor]` | Link WhatsApp LID to existing customer account |
| **DAFTAR** | `DAFTAR [Nama]#[NoHP]#[Alamat]#[ID_Paket]` | Register as new customer with complete data |
| **STATUS** | `STATUS` | Check billing and service status |
| **MENU** | `MENU` | Display available customer commands |

**Examples:**
```
REG Budi Santoso
REG 081234567890
DAFTAR Agus Setiawan#08123456789#Jl. Melati No 5#1
```

#### For Admins

| Command | Format | Description |
|---------|--------|-------------|
| **SETLID** | `SETLID [password]`[nomer admin]| Save admin WhatsApp LID to settings (requires admin password) |
| **MENU** | `MENU` or `ADMIN` | Display admin menu |

**Examples:**
```
SETLID admin123
```

> **Note:** Admin password is configured in `settings.json` as `admin_password`

> **Security:** WhatsApp LID ensures secure identification even if phone numbers change format

## 🛠️ Technologies Used

| Category | Technology |
|----------|-----------|
| **Backend** | Node.js, Express |
| **Database** | SQLite (development), MySQL (production) |
| **Frontend** | EJS, HTML5, CSS3, JavaScript |
| **WhatsApp** | [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) |
| **Network** | Node-routeros for Mikrotik |
| **Payment** | Midtrans, Xendit |
| **Logging** | Winston, Pino |

## 📋 System Prerequisites

- **Node.js** >= 20.0.0
- **npm** >= 6.0.0
- **Database** SQLite (for development) or MySQL (for production)
- **WhatsApp Business Access** (for WhatsApp Gateway features)

## 🚀 Quick Installation

### 1. Clone Repository
```bash
git clone https://github.com/yanzwrt/ikdmp-cinta.git
```
```bash
cd ikdmp-cinta
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Initialize Database
```bash
npm run setup
```

### 4. Run Database Migration (Important for New Servers)
To ensure all required tables and columns exist in the database, run migration commands:

```bash
# Run all database migrations
node scripts/run-all-migrations.js

# Verify database structure
node scripts/verify-production-database.js
```

### 5. Access the Application

After starting the application, you can access different portals through these URLs:

#### 🔐 Login Portals

| Portal | URL | Default Credentials |
|--------|-----|-------------------|
| **Customer Portal** | `http://localhost:4555/customer/login` | Use customer username & phone |
| **Admin Portal** | `http://localhost:4555/admin/login` | Username: `admin` / Password: `admin` |
| **Admin Mobile** | `http://localhost:4555/admin/login/mobile` | Same as admin portal |
| **Agent Portal** | `http://localhost:4555/agent/login` | Register agent first via admin |
| **Technician Portal** | `http://localhost:4555/technician/login` | Register technician via admin |
| **Technician (ID)** | `http://localhost:4555/teknisi/login` | Same as technician portal |
| **Collector Portal** | `http://localhost:4555/collector/login` | Register collector via admin |

#### 📱 Public Features

| Feature | URL | Description |
|---------|-----|-------------|
| **Voucher Purchase** | `http://localhost:4555/voucher` | Public voucher purchase page |
| **Trouble Report** | `http://localhost:4555/customer/trouble` | Customer trouble reporting |
| **WhatsApp Status** | `http://localhost:4555/whatsapp/status` | Check WhatsApp connection status |
| **API Health Check** | `http://localhost:4555/health` | Server health status |

> **Note:** Replace `localhost:4555` with your server IP/domain. Port `4555` can be changed in `settings.json`

> **Security:** Change default admin credentials immediately after first login via Settings menu

### 6. Run Application
```bash
# For production
npm start
```
# For development
```bash
npm run dev
```

## 📁 Project Structure

```
gembok-bill/
├── app.js                  # Application entry point
├── package.json            # Dependencies and scripts
├── config/                 # Configuration files
├── data/                   # Database files and backups
├── migrations/             # Database migration files
├── public/                 # Static files (CSS, JS, images)
├── routes/                 # API endpoints
├── scripts/                # Utility scripts
├── utils/                  # Utility functions
└── views/                  # EJS templates
```

## 📖 Complete Documentation

| Document | Description |
|---------|-----------|
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | Complete guide for deployment on new servers |
| [DATA_README.md](DATA_README.md) | Information about data management |
| [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md) | WhatsApp Gateway configuration |
| [WHATSAPP_FIX_SUMMARY.md](WHATSAPP_FIX_SUMMARY.md) | WhatsApp fixes summary |
| [DATABASE_MIGRATION_SUMMARY.md](DATABASE_MIGRATION_SUMMARY.md) | Database migration summary |

## 🎯 How to Contribute

We welcome contributions from the community! Here's how to contribute:

1. **Fork** this repository
2. Create a **feature branch** (`git checkout -b feature/AmazingFeature`)
3. **Commit** your changes (`git commit -m 'Add some AmazingFeature'`)
4. **Push** to the branch (`git push origin feature/AmazingFeature`)
5. Open a **Pull Request**

### Contribution Guidelines
- Follow the existing code style
- Add documentation for new features
- Ensure all tests pass
- Update README if necessary

## 📞 Support

If you need assistance:

- Create an **issue** at [GitHub Issues](https://github.com/yanzwrt/ikdmp-cinta/issues)
- Contact the development team via email
- Join the Discord community (if available)

## 📄 License

This project is licensed under the ISC license - see the [LICENSE](LICENSE) file for more details.

## 👥 Development Team

- **RAKHA PUTRA ANDRIAN Team** - [@yanzwrt](https://github.com/yanzwrt)

## 🙏 Acknowledgments

- Thanks to all contributors who have helped develop this project
- The open source community for inspiration and support

---

  
  💻 Developed with ❤️ for the ISP community
  
  [Report Bug](https://github.com/yanzwrt/ikdmp-cinta/issues) · [Request Feature](https://github.com/yanzwrt/ikdmp-cinta/issues) · [Documentation](DEPLOYMENT_GUIDE.md)
  




