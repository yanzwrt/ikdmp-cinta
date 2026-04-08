const AgentManager = require('./agentManager');
const AgentWhatsAppManager = require('./agentWhatsApp');
const billingManager = require('./billing');

function normalizePhone(phone = '') {
    let p = String(phone).replace(/\D/g, '');

    if (p.startsWith('0')) {
        p = '62' + p.slice(1);
    } else if (!p.startsWith('62')) {
        p = '62' + p;
    }

    return p;
}

function formatWhatsAppJid(phone = '') {
    const clean = normalizePhone(phone);
    return `${clean}@s.whatsapp.net`;
}

class AgentWhatsAppCommands {
    constructor() {
        this.agentManager = new AgentManager();
        this.whatsappManager = new AgentWhatsAppManager();
        this.billingManager = billingManager;

        // Set WhatsApp socket when available
        if (typeof global !== 'undefined' && global.whatsappStatus && global.whatsappStatus.connected) {
            let sock = null;

            if (typeof global.getWhatsAppSocket === 'function') {
                sock = global.getWhatsAppSocket();
            } else if (global.whatsappSocket) {
                sock = global.whatsappSocket;
            } else if (global.whatsapp && typeof global.whatsapp.getSock === 'function') {
                sock = global.whatsapp.getSock();
            }

            if (sock) {
                this.whatsappManager.setSocket(sock);
                console.log('WhatsApp socket set for AgentWhatsAppManager in AgentWhatsAppCommands');
            } else {
                console.warn('WhatsApp socket not available for AgentWhatsAppManager in AgentWhatsAppCommands');
            }
        }
    }

    // Handle incoming message
    async handleMessage(from, message) {
        try {
            let phoneNumber = from;

            if (from.includes('@s.whatsapp.net')) {
                phoneNumber = from.replace('@s.whatsapp.net', '');
            } else if (from.includes('@lid')) {
                phoneNumber = from.replace('@lid', '');
            }

            phoneNumber = normalizePhone(phoneNumber);

            const agent = await this.agentManager.getAgentByPhone(phoneNumber);
            if (!agent) {
                console.log(`Agent tidak dikenali: ${from}`);
                return null;
            }

            const command = this.parseCommand(message);

            if (!command) {
                console.log(`Command tidak dikenali: ${message}`);
                return null;
            }

            switch (command.type) {
                case 'help':
                    return await this.handleHelp(phoneNumber);
                case 'saldo':
                    return await this.handleCheckBalance(phoneNumber, agent);
                case 'cek_tagihan':
                    return await this.handleCheckBill(phoneNumber, agent, command.params);
                case 'bayar_tagihan':
                    return await this.handlePayBill(phoneNumber, agent, command.params);
                case 'beli_voucher':
                    return await this.handleBuyVoucher(phoneNumber, agent, command.params);
                case 'jual':
                    return await this.handleSellVoucher(phoneNumber, agent, command.params);
                case 'bayar':
                    return await this.handleProcessPayment(phoneNumber, agent, command.params);
                case 'list_tagihan':
                    return await this.handleListTagihan(phoneNumber, agent);
                case 'list_bayar':
                    return await this.handleListBayar(phoneNumber, agent);
                case 'riwayat':
                    return await this.handleTransactionHistory(phoneNumber, agent);
                case 'request':
                    return await this.handleRequestBalance(phoneNumber, agent, command.params);
                default:
                    console.log(`Command tidak dikenali: ${command.type}`);
                    return null;
            }
        } catch (error) {
            console.error('Error handling WhatsApp message:', error);
            return null;
        }
    }

    // Parse command from message
    parseCommand(message) {
        const text = String(message || '').toLowerCase().trim();

        if (text === 'menu' || text === 'agent' || text === 'agen') {
            return { type: 'help' };
        }

        if (text.includes('help') || text.includes('bantuan')) {
            return { type: 'help' };
        }

        if (text.includes('saldo') || text.includes('balance')) {
            return { type: 'saldo' };
        }

        if (text.includes('cek tagihan') || text.includes('cek_tagihan')) {
            const params = this.parseCheckBillParams(text);
            return { type: 'cek_tagihan', params };
        }

        if (text.includes('bayar tagihan') || text.includes('bayar_tagihan')) {
            const params = this.parsePayBillParams(text);
            return { type: 'bayar_tagihan', params };
        }

        if (text.includes('beli voucher') || text.includes('beli_voucher')) {
            const params = this.parseBuyVoucherParams(text);
            return { type: 'beli_voucher', params };
        }

        if (text.includes('jual') || text.includes('sell')) {
            const params = this.parseSellParams(text);
            return { type: 'jual', params };
        }

        if (text.includes('bayar') || text.includes('payment')) {
            const params = this.parsePaymentParams(text);
            return { type: 'bayar', params };
        }

        if (text.includes('request') || text.includes('minta')) {
            const params = this.parseRequestParams(text);
            return { type: 'request', params };
        }

        if (text.includes('list tagihan') || text.includes('list_tagihan')) {
            return { type: 'list_tagihan' };
        }

        if (text.includes('list bayar') || text.includes('list_bayar')) {
            return { type: 'list_bayar' };
        }

        if (text.includes('riwayat') || text.includes('history')) {
            return { type: 'riwayat' };
        }

        return null;
    }

    parsePaymentParams(text) {
        const parts = text.split(' ');
        const bayarIndex = parts.findIndex(p => p.includes('bayar'));

        if (bayarIndex === -1 || parts.length < bayarIndex + 4) {
            return null;
        }

        return {
            customerName: parts[bayarIndex + 1],
            customerPhone: parts[bayarIndex + 2],
            amount: parseFloat(parts[bayarIndex + 3]),
            sendWhatsApp: parts[bayarIndex + 4] === 'ya' || parts[bayarIndex + 4] === 'yes'
        };
    }

    parseRequestParams(text) {
        const parts = text.split(' ');
        const requestIndex = parts.findIndex(p => p.includes('request') || p.includes('minta'));

        if (requestIndex === -1 || parts.length < requestIndex + 2) {
            return null;
        }

        return {
            amount: parseFloat(parts[requestIndex + 1]),
            notes: parts.slice(requestIndex + 2).join(' ')
        };
    }

    parseBuyVoucherParams(text) {
        const parts = text.split(' ');
        const beliIndex = parts.findIndex(p => p.includes('beli'));

        if (beliIndex === -1 || parts.length < beliIndex + 3) {
            return null;
        }

        return {
            package: parts[beliIndex + 2],
            customerPhone: parts[beliIndex + 3] || null
        };
    }

    parseSellParams(text) {
        const parts = text.split(' ');
        const jualIndex = parts.findIndex(p => p.includes('jual'));

        if (jualIndex === -1 || parts.length < jualIndex + 2) {
            return null;
        }

        return {
            package: parts[jualIndex + 1],
            customerPhone: parts[jualIndex + 2] || null
        };
    }

    parseCheckBillParams(text) {
        const parts = text.split(' ');
        const cekIndex = parts.findIndex(p => p.includes('cek'));

        if (cekIndex === -1 || parts.length < cekIndex + 3) {
            return null;
        }

        return {
            customerName: parts.slice(cekIndex + 2).join(' ')
        };
    }

    parsePayBillParams(text) {
        const parts = text.split(' ');
        const bayarIndex = parts.findIndex(p => p.includes('bayar'));

        if (bayarIndex === -1 || parts.length < bayarIndex + 3) {
            return null;
        }

        return {
            customerName: parts.slice(bayarIndex + 2).join(' ')
        };
    }

    async handleHelp(from) {
        const helpText = `🤖 *COMMAND AGENT WHATSAPP*

📋 *Daftar Command:*

📋 *CEK TAGIHAN [NAMA_PELANGGAN]* - Cek tagihan pelanggan
💰 *BAYAR TAGIHAN [NAMA_PELANGGAN]* - Bayar tagihan pelanggan
📋 *LIST TAGIHAN* - Lihat semua pelanggan yang belum bayar
💰 *LIST BAYAR* - Lihat semua pelanggan yang sudah bayar
🛒 *BELI VOUCHER [PAKET]* - Beli voucher (hanya untuk agent)
🛒 *BELI VOUCHER [PAKET] [NOMOR_HP]* - Beli voucher dan kirim ke pelanggan
📱 *JUAL [PAKET]* - Jual voucher (tanpa kirim ke konsumen)
📱 *JUAL [PAKET] [NOMOR_HP]* - Jual voucher + kirim ke konsumen
💰 *BAYAR [NAMA] [HP] [JUMLAH] [YA/TIDAK]* - Terima pembayaran
📤 *REQUEST [JUMLAH] [CATATAN]* - Request saldo ke admin
📊 *RIWAYAT* - Lihat riwayat transaksi

Contoh:
• SALDO
• CEK TAGIHAN Rakha Putra
• BAYAR TAGIHAN Rakha Putra
• LIST TAGIHAN
• LIST BAYAR
• BELI VOUCHER 3K
• BELI VOUCHER 10K 081234567890
• JUAL 3K
• JUAL 10K 081234567890
• BAYAR Jane 081234567891 50000 YA
• REQUEST 100000 Top up saldo
• RIWAYAT

❓ Ketik *HELP* untuk melihat menu ini lagi.`;

        return await this.sendMessage(from, helpText);
    }

    async handleCheckBalance(from, agent) {
        try {
            const balance = await this.agentManager.getAgentBalance(agent.id);
            const message = `💰 *SALDO AGENT*

👤 Agent: ${agent.name}
📱 Phone: ${agent.phone}
💰 Saldo: Rp ${balance.toLocaleString('id-ID')}

📅 Terakhir update: ${new Date().toLocaleString('id-ID')}`;

            return await this.sendMessage(from, message);
        } catch (error) {
            return await this.sendMessage(from, '❌ Gagal mengambil data saldo.');
        }
    }

    async handleSellVoucher(from, agent, params) {
        if (!params) {
            return await this.sendMessage(from, '❌ Format salah. Gunakan: *JUAL [PAKET]* atau *JUAL [PAKET] [NOMOR_HP]*');
        }

        try {
            const packages = await this.agentManager.getAvailablePackages();
            const selectedPackage = packages.find(p => p.name.toLowerCase().includes(params.package.toLowerCase()));

            if (!selectedPackage) {
                return await this.sendMessage(from, `❌ Paket tidak ditemukan. Paket tersedia: ${packages.map(p => p.name).join(', ')}`);
            }

            const voucherCode = this.agentManager.generateVoucherCode(selectedPackage);

            const result = await this.agentManager.sellVoucher(
                agent.id,
                voucherCode,
                selectedPackage.id,
                params.customerName || 'Customer',
                params.customerPhone || ''
            );

            if (result.success) {
                let message = `🎉 *VOUCHER BERHASIL DIJUAL*

🎫 Kode Voucher: *${result.voucherCode}*
📦 Paket: ${result.packageName}
💰 Harga Jual: Rp ${result.customerPrice.toLocaleString('id-ID')}
💳 Harga Agent: Rp ${result.agentPrice.toLocaleString('id-ID')}
💵 Komisi: Rp ${result.commissionAmount.toLocaleString('id-ID')}

💰 Saldo tersisa: Rp ${result.newBalance.toLocaleString('id-ID')}`;

                if (params.customerPhone) {
                    const agentInfo = {
                        name: agent.name,
                        phone: agent.phone
                    };

                    await this.whatsappManager.sendVoucherToCustomer(
                        params.customerPhone,
                        params.customerName || 'Customer',
                        result.voucherCode,
                        result.packageName,
                        result.customerPrice,
                        agentInfo
                    );
                    message += `\n\n📱 Notifikasi telah dikirim ke pelanggan (${params.customerPhone}).`;
                } else {
                    message += '\n\nℹ️ Voucher siap diberikan ke pelanggan secara langsung.';
                }

                return await this.sendMessage(from, message);
            } else {
                return await this.sendMessage(from, `❌ Gagal menjual voucher: ${result.message}`);
            }
        } catch (error) {
            return await this.sendMessage(from, '❌ Terjadi kesalahan saat menjual voucher.');
        }
    }

    async handleProcessPayment(from, agent, params) {
        if (!params) {
            return await this.sendMessage(from, '❌ Format salah. Gunakan: *BAYAR [NAMA] [HP] [JUMLAH] [YA/TIDAK]*');
        }

        try {
            const result = await this.agentManager.processPayment(
                agent.id,
                params.customerName,
                params.customerPhone,
                params.amount
            );

            if (result.success) {
                let message = `✅ *PEMBAYARAN BERHASIL DIPROSES*

👤 Pelanggan: ${params.customerName}
📱 Phone: ${params.customerPhone}
💰 Jumlah: Rp ${params.amount.toLocaleString('id-ID')}
👤 Agent: ${agent.name}
📅 Tanggal: ${new Date().toLocaleString('id-ID')}

💰 Saldo agent: Rp ${result.newBalance.toLocaleString('id-ID')}`;

                if (params.sendWhatsApp) {
                    const customer = {
                        name: params.customerName,
                        phone: params.customerPhone
                    };

                    const paymentData = {
                        amount: params.amount,
                        method: 'WhatsApp',
                        commission: 0
                    };

                    await this.whatsappManager.sendPaymentNotification(agent, customer, paymentData);
                    message += '\n\n📱 Konfirmasi telah dikirim ke pelanggan.';
                }

                return await this.sendMessage(from, message);
            } else {
                return await this.sendMessage(from, `❌ Gagal memproses pembayaran: ${result.message}`);
            }
        } catch (error) {
            return await this.sendMessage(from, '❌ Terjadi kesalahan saat memproses pembayaran.');
        }
    }

    async handleRequestBalance(from, agent, params) {
        if (!params) {
            return await this.sendMessage(from, '❌ Format salah. Gunakan: *REQUEST [JUMLAH] [CATATAN]*');
        }

        try {
            const result = await this.agentManager.requestBalance(
                agent.id,
                params.amount,
                params.notes
            );

            if (result.success) {
                await this.agentManager.createNotification(
                    agent.id,
                    'balance_updated',
                    'Request Saldo Dikirim',
                    `Request saldo sebesar Rp ${params.amount.toLocaleString()} telah dikirim ke admin`
                );

                try {
                    const settings = require('./settingsManager').getSettingsWithCache();
                    const adminPhone = settings.admin_phone || settings.contact_phone;

                    if (adminPhone && this.whatsappManager.sock) {
                        const adminMessage = `🔔 *REQUEST SALDO AGENT*

👤 Agent: ${agent.name}
📱 HP: ${agent.phone}
💰 Jumlah: Rp ${params.amount.toLocaleString()}
📅 Tanggal: ${new Date().toLocaleString('id-ID')}

Silakan login ke admin panel untuk memproses request ini.`;

                        const formattedAdminPhone = formatWhatsAppJid(adminPhone);
                        await this.whatsappManager.sock.sendMessage(formattedAdminPhone, { text: adminMessage });
                    }
                } catch (whatsappError) {
                    console.error('WhatsApp admin notification error:', whatsappError);
                }

                let message = `📤 *REQUEST SALDO BERHASIL*

💰 Jumlah: Rp ${params.amount.toLocaleString('id-ID')}
📝 Catatan: ${params.notes}
📅 Tanggal: ${new Date().toLocaleString('id-ID')}

⏳ Menunggu persetujuan admin...`;

                message += '\n\n📢 Request saldo telah diajukan dan akan diproses oleh admin.';

                return await this.sendMessage(from, message);
            } else {
                return await this.sendMessage(from, `❌ Gagal mengajukan request: ${result.message}`);
            }
        } catch (error) {
            return await this.sendMessage(from, '❌ Terjadi kesalahan saat mengajukan request.');
        }
    }

    async handleListTagihan(from, agent) {
        try {
            const unpaidInvoices = await this.billingManager.getUnpaidInvoices();

            if (unpaidInvoices.length === 0) {
                return await this.sendMessage(from, '✅ *LIST TAGIHAN*\n\n📝 Tidak ada pelanggan yang memiliki tagihan belum dibayar.');
            }

            let message = `📋 *LIST TAGIHAN BELUM DIBAYAR*\n\n`;
            message += `📊 Total pelanggan: ${unpaidInvoices.length}\n\n`;

            const customerGroups = {};
            unpaidInvoices.forEach(invoice => {
                if (!customerGroups[invoice.customer_id]) {
                    customerGroups[invoice.customer_id] = {
                        customer: invoice.customer_name,
                        phone: invoice.customer_phone,
                        invoices: []
                    };
                }
                customerGroups[invoice.customer_id].invoices.push(invoice);
            });

            let customerIndex = 1;
            for (const customerId in customerGroups) {
                const group = customerGroups[customerId];
                message += `${customerIndex}. 👤 ${group.customer}\n`;
                if (group.phone) {
                    message += `   📱 ${group.phone}\n`;
                }

                group.invoices.forEach((invoice, idx) => {
                    const dueDate = invoice.due_date ? new Date(invoice.due_date).toLocaleDateString('id-ID') : 'N/A';
                    const daysOverdue = invoice.due_date
                        ? Math.floor((new Date() - new Date(invoice.due_date)) / (1000 * 60 * 60 * 24))
                        : 0;

                    message += `   ${idx + 1}. 💰 Rp ${invoice.amount.toLocaleString('id-ID')}\n`;
                    message += `      📅 Due: ${dueDate}`;
                    if (daysOverdue > 0) {
                        message += ` (${daysOverdue} hari telat)`;
                    }
                    message += '\n';
                    message += `      🆔 ${invoice.invoice_number}\n`;
                });
                message += '\n';
                customerIndex++;
            }

            if (message.length > 4000) {
                const parts = this.splitMessage(message, 4000);
                for (const part of parts) {
                    await this.sendMessage(from, part);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                return true;
            } else {
                return await this.sendMessage(from, message);
            }
        } catch (error) {
            console.error('Error in handleListTagihan:', error);
            return await this.sendMessage(from, '❌ Gagal mengambil data tagihan. Silakan coba lagi.');
        }
    }

    async handleListBayar(from, agent) {
        try {
            const paidInvoices = await this.billingManager.getPaidInvoices();

            if (paidInvoices.length === 0) {
                return await this.sendMessage(from, '✅ *LIST PEMBAYARAN*\n\n📝 Tidak ada pelanggan yang sudah melakukan pembayaran.');
            }

            let message = `💰 *LIST PELANGGAN SUDAH BAYAR*\n\n`;
            message += `📊 Total pelanggan: ${paidInvoices.length}\n\n`;

            const customerGroups = {};
            paidInvoices.forEach(invoice => {
                if (!customerGroups[invoice.customer_id]) {
                    customerGroups[invoice.customer_id] = {
                        customer: invoice.customer_name,
                        phone: invoice.customer_phone,
                        invoices: []
                    };
                }
                customerGroups[invoice.customer_id].invoices.push(invoice);
            });

            let customerIndex = 1;
            for (const customerId in customerGroups) {
                const group = customerGroups[customerId];
                message += `${customerIndex}. 👤 ${group.customer}\n`;
                if (group.phone) {
                    message += `   📱 ${group.phone}\n`;
                }

                group.invoices.forEach((invoice, idx) => {
                    const paymentDate = invoice.payment_date
                        ? new Date(invoice.payment_date).toLocaleDateString('id-ID')
                        : 'N/A';

                    message += `   ${idx + 1}. 💰 Rp ${invoice.amount.toLocaleString('id-ID')}\n`;
                    message += `      💳 Dibayar: ${paymentDate}\n`;
                    message += `      🆔 ${invoice.invoice_number}\n`;
                    if (invoice.payment_method) {
                        message += `      💳 Via: ${invoice.payment_method}\n`;
                    }
                });
                message += '\n';
                customerIndex++;
            }

            if (message.length > 4000) {
                const parts = this.splitMessage(message, 4000);
                for (const part of parts) {
                    await this.sendMessage(from, part);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                return true;
            } else {
                return await this.sendMessage(from, message);
            }
        } catch (error) {
            console.error('Error in handleListBayar:', error);
            return await this.sendMessage(from, '❌ Gagal mengambil data pembayaran. Silakan coba lagi.');
        }
    }

    splitMessage(message, maxLength) {
        const parts = [];
        let currentPart = '';

        const lines = message.split('\n');

        for (const line of lines) {
            if ((currentPart + line + '\n').length <= maxLength) {
                currentPart += line + '\n';
            } else {
                if (currentPart) {
                    parts.push(currentPart.trim());
                    currentPart = line + '\n';
                }
            }
        }

        if (currentPart) {
            parts.push(currentPart.trim());
        }

        return parts;
    }

    async handleTransactionHistory(from, agent) {
        try {
            const transactions = await this.agentManager.getAgentTransactions(agent.id, 10);

            let message = `📊 *RIWAYAT TRANSAKSI TERAKHIR*

👤 Agent: ${agent.name}
📅 Periode: 10 transaksi terakhir

`;

            if (transactions.length === 0) {
                message += '📝 Belum ada transaksi.';
            } else {
                transactions.forEach((tx, index) => {
                    const date = new Date(tx.created_at).toLocaleDateString('id-ID');
                    const time = new Date(tx.created_at).toLocaleTimeString('id-ID');
                    const amount = tx.amount.toLocaleString('id-ID');

                    message += `${index + 1}. ${tx.transaction_type.toUpperCase()}\n`;
                    message += `   💰 Rp ${amount}\n`;
                    message += `   📅 ${date} ${time}\n`;
                    if (tx.description) {
                        message += `   📝 ${tx.description}\n`;
                    }
                    message += '\n';
                });
            }

            return await this.sendMessage(from, message);
        } catch (error) {
            return await this.sendMessage(from, '❌ Gagal mengambil riwayat transaksi.');
        }
    }

    async sendMessage(to, message) {
        try {
            let sock = null;

            try {
                const whatsapp = require('./whatsapp');
                sock = whatsapp.getSock ? whatsapp.getSock() : null;
            } catch (e) {
                console.log('Could not get socket from whatsapp module');
            }

            const jid = to.includes('@s.whatsapp.net') ? to : formatWhatsAppJid(to);

            if (sock && sock.sendMessage) {
                await sock.sendMessage(jid, { text: message });
                console.log(`📤 [AGENT] Sent message to ${jid}: ${message}`);
                return true;
            } else {
                console.log(`📤 [AGENT] [MOCK] Would send to ${jid}: ${message}`);
                return false;
            }
        } catch (error) {
            console.error('Error sending WhatsApp message:', error);
            return false;
        }
    }

    async handleCheckBill(from, agent, params) {
        if (!params || !params.customerName) {
            return await this.sendMessage(from, '❌ Format salah. Gunakan: *CEK TAGIHAN [NAMA_PELANGGAN]*');
        }

        try {
            const customer = await this.billingManager.getCustomerByNameOrPhone(params.customerName);
            if (!customer) {
                return await this.sendMessage(from, `❌ Pelanggan dengan nama "${params.customerName}" tidak ditemukan.`);
            }

            const allBills = await this.billingManager.getInvoicesByCustomer(customer.id);
            const bills = allBills.filter(bill => bill.status === 'unpaid');

            if (bills.length === 0) {
                return await this.sendMessage(from, `✅ Pelanggan "${params.customerName}" tidak memiliki tagihan yang belum dibayar.`);
            }

            let message = `📋 *TAGIHAN PELANGGAN: ${params.customerName}*

`;
            bills.forEach((bill, index) => {
                const status = bill.status === 'unpaid' ? 'Belum Dibayar' : 'Sudah Dibayar';
                message += `${index + 1}. Jumlah: Rp ${bill.amount.toLocaleString('id-ID')} - Status: ${status}\n`;
                if (bill.due_date) {
                    message += `   Jatuh Tempo: ${new Date(bill.due_date).toLocaleDateString('id-ID')}\n`;
                }
                message += '\n';
            });

            return await this.sendMessage(from, message);
        } catch (error) {
            return await this.sendMessage(from, '❌ Gagal mengambil data tagihan.');
        }
    }

    async handlePayBill(from, agent, params) {
        if (!params || !params.customerName) {
            return await this.sendMessage(from, '❌ Format salah. Gunakan: *BAYAR TAGIHAN [NAMA_PELANGGAN]*');
        }

        try {
            const customer = await this.billingManager.getCustomerByNameOrPhone(params.customerName);
            if (!customer) {
                return await this.sendMessage(from, `❌ Pelanggan dengan nama "${params.customerName}" tidak ditemukan.`);
            }

            const allInvoices = await this.billingManager.getInvoicesByCustomer(customer.id);
            const unpaidInvoices = allInvoices.filter(invoice => invoice.status === 'unpaid');

            if (unpaidInvoices.length === 0) {
                return await this.sendMessage(from, `✅ Pelanggan "${params.customerName}" tidak memiliki tagihan yang belum dibayar.`);
            }

            const invoice = unpaidInvoices[0];
            console.log('[AGENT][DEBUG] invoice:', invoice);

            const result = await this.billingManager.recordPayment({
                invoice_id: invoice.id,
                amount: invoice.base_amount,
                payment_method: 'agent_payment',
                reference_number: agent.id,
                notes: ''
            });

            if (result.success) {
                await this.billingManager.updateInvoiceStatus(invoice.id, 'paid', 'agent_payment');

                await this.agentManager.updateAgentBalance(
                    agent.id,
                    -invoice.base_amount,
                    'monthly_payment',
                    `Pembayaran tagihan pelanggan ${params.customerName}`,
                    invoice.id
                );

                const saldoAkhir = await this.agentManager.getAgentBalance(agent.id);
                const komisi = invoice.amount - invoice.base_amount;

                let message = `✅ *PEMBAYARAN TAGIHAN BERHASIL*

👤 Pelanggan: ${params.customerName}
💰 Jumlah dibayar pelanggan: Rp ${invoice.amount.toLocaleString('id-ID')}
💵 Saldo agent terpotong: Rp ${invoice.base_amount.toLocaleString('id-ID')}
🎁 Komisi: Rp ${komisi.toLocaleString('id-ID')}
📅 Tanggal: ${new Date().toLocaleString('id-ID')}
`;

                if (customer.phone) {
                    await this.sendMessage(customer.phone, `✅ Pembayaran tagihan atas nama ${customer.name} sebesar Rp ${invoice.amount.toLocaleString('id-ID')} telah berhasil!`);
                    message += '📱 Konfirmasi telah dikirim ke pelanggan.';
                }

                message += `\n💰 Saldo akhir: Rp ${saldoAkhir.toLocaleString('id-ID')}`;

                return await this.sendMessage(from, message);
            } else {
                return await this.sendMessage(from, `❌ Gagal memproses pembayaran: ${result.message}`);
            }
        } catch (error) {
            console.error('[AGENT][ERROR] handlePayBill:', error);
            return await this.sendMessage(from, '❌ Terjadi kesalahan saat memproses pembayaran.');
        }
    }

    async handleBuyVoucher(from, agent, params) {
        if (!params || !params.package) {
            return await this.sendMessage(from, '❌ Format salah. Gunakan: *BELI VOUCHER [PAKET]* atau *BELI VOUCHER [PAKET] [NOMOR_PELANGGAN]*');
        }

        try {
            const balance = await this.agentManager.getAgentBalance(agent.id);
            const packages = await this.agentManager.getAvailablePackages();
            const selectedPackage = packages.find(p => p.name.toLowerCase().includes(params.package.toLowerCase()));

            if (!selectedPackage) {
                return await this.sendMessage(from, `❌ Paket "${params.package}" tidak ditemukan. Paket tersedia: ${packages.map(p => p.name).join(', ')}`);
            }

            const price = selectedPackage.price;
            if (balance < price) {
                return await this.sendMessage(from, `❌ Saldo tidak mencukupi. Saldo: Rp ${balance.toLocaleString('id-ID')}, Dibutuhkan: Rp ${price.toLocaleString('id-ID')}`);
            }

            const voucherCode = this.agentManager.generateVoucherCode(selectedPackage);

            const result = await this.agentManager.sellVoucher(
                agent.id,
                voucherCode,
                selectedPackage.id,
                params.customerPhone || 'Customer',
                params.customerPhone || ''
            );

            if (result.success) {
                let message = `🎉 *VOUCHER BERHASIL DIBELI*

🎫 Kode Voucher: *${result.voucherCode}*
📦 Paket: ${result.packageName}
💰 Harga Jual: Rp ${result.customerPrice.toLocaleString('id-ID')}
💳 Harga Agent: Rp ${result.agentPrice.toLocaleString('id-ID')}
💵 Komisi: Rp ${result.commissionAmount.toLocaleString('id-ID')}

💰 Saldo tersisa: Rp ${result.newBalance.toLocaleString('id-ID')}`;

                if (params.customerPhone) {
                    const agentInfo = {
                        name: agent.name,
                        phone: agent.phone
                    };

                    await this.whatsappManager.sendVoucherToCustomer(
                        params.customerPhone,
                        params.customerName || 'Customer',
                        result.voucherCode,
                        result.packageName,
                        result.customerPrice,
                        agentInfo
                    );
                    message += `\n\n📱 Notifikasi telah dikirim ke pelanggan (${params.customerPhone}).`;
                } else {
                    message += '\n\nℹ️ Voucher siap diberikan ke pelanggan secara langsung.';
                }

                return await this.sendMessage(from, message);
            } else {
                return await this.sendMessage(from, `❌ Gagal menjual voucher: ${result.message}`);
            }
        } catch (error) {
            return await this.sendMessage(from, '❌ Terjadi kesalahan saat membeli voucher. Silakan coba lagi.');
        }
    }
}

module.exports = AgentWhatsAppCommands;
