const AgentWhatsAppCommands = require('./agentWhatsAppCommands');
const whatsappMessageHandler = require('./whatsapp-message-handler');

class AgentWhatsAppIntegration {
    constructor(whatsappGateway) {
        this.commands = new AgentWhatsAppCommands();
        this.whatsappGateway = whatsappGateway;
    }

    // Initialize WhatsApp integration
    initialize() {
        console.log('ðŸ¤– Initializing Agent WhatsApp Commands...');
        
        try {
            // Check if whatsappGateway has the required methods
            if (!this.whatsappGateway || typeof this.whatsappGateway.connectToWhatsApp !== 'function') {
                console.log('âš ï¸ WhatsApp gateway not properly initialized, using mock mode');
                return;
            }
            
            // Get the socket instance from whatsapp gateway
            const sock = this.whatsappGateway.getSock ? this.whatsappGateway.getSock() : null;
            
            if (!sock || !sock.ev) {
                console.log('âš ï¸ WhatsApp socket not available, using mock mode');
                return;
            }
            
            // Don't register our own event listener - let main handler call us
            console.log('ðŸ¤– Agent WhatsApp Integration ready (no direct event listener)');

            console.log('âœ… Agent WhatsApp Commands initialized successfully');
        } catch (error) {
            console.error('âŒ Error initializing Agent WhatsApp Commands:', error);
        }
    }

    // Method to be called from main handler
async handleIncomingMessage(message, from, text) {
    try {
        console.log(`ðŸ“± [AGENT] Received message from ${from}: ${text}`);

        const { getSetting } = require('./settingsManager');
        const adminNumbers = [];
        let i = 0;
        while (true) {
            const adminNum = getSetting(`admins.${i}`);
            if (!adminNum) break;

            let normalizedAdmin = String(adminNum).replace(/\D/g, '');
            if (normalizedAdmin.startsWith('0')) {
                normalizedAdmin = '62' + normalizedAdmin.slice(1);
            } else if (!normalizedAdmin.startsWith('62')) {
                normalizedAdmin = '62' + normalizedAdmin;
            }

            adminNumbers.push(normalizedAdmin);
            i++;
        }

        // Normalize sender number
        let senderNumber = from;
        if (from.includes('@s.whatsapp.net')) {
            senderNumber = from.replace('@s.whatsapp.net', '');
        } else if (from.includes('@lid')) {
            senderNumber = from.replace('@lid', '');
        }

        senderNumber = senderNumber.replace(/\D/g, '');
        if (senderNumber.startsWith('0')) {
            senderNumber = '62' + senderNumber.slice(1);
        } else if (!senderNumber.startsWith('62')) {
            senderNumber = '62' + senderNumber;
        }

        const isAdmin = adminNumbers.includes(senderNumber);

        console.log(`ðŸ“± [AGENT] DEBUG: senderNumber=${senderNumber}, isAdmin=${isAdmin}, adminNumbers=${JSON.stringify(adminNumbers)}, text=${text}`);

        if (isAdmin) {
            console.log(`ðŸ“± [AGENT] Admin detected, skipping agent handler for ALL commands: ${text}`);
            return false;
        }

        const technician = await whatsappMessageHandler.getTechnicianByPhone(senderNumber);
        console.log(`ðŸ“± [ROUTER] Technician lookup result for ${senderNumber}:`, technician);

        if (technician) {
            console.log(`ðŸ“± [ROUTER] Teknisi dikenali: ${technician.name} (${technician.phone})`);

            const technicianText = String(text || '').trim().toLowerCase() === 'teknisi' ? 'MENU' : text;
            const techResponse = await whatsappMessageHandler.processTechnicianMessage(
                senderNumber,
                technicianText,
                technician.name,
                message && message.key ? message.key.remoteJid : null
            );
            if (techResponse !== null) {
                message._agentProcessed = true;
                console.log(`ðŸ“¤ [TECHNICIAN] Message processed by technician handler`);
                return true;
            }

            return false;
        }

        const response = await this.commands.handleMessage(senderNumber, text);

        if (response !== null) {
            message._agentProcessed = true;
            console.log(`ðŸ“¤ [AGENT] DEBUG: Response from commands: ${response}, type: ${typeof response}`);
            return true;
        } else {
            console.log(`ðŸ“¤ [AGENT] No response sent, allowing main handler to process`);
            return false;
        }
    } catch (error) {
        console.error('Error processing agent WhatsApp message:', error);
        return false;
    }
}

    // Send message via WhatsApp gateway
    async sendMessage(to, message) {
        try {
            // Ensure message is a string
            const messageText = typeof message === 'string' ? message : String(message);
            
            // Try to get socket from whatsapp gateway
            let sock = null;
            console.log(`ðŸ“¤ [AGENT] DEBUG: whatsappGateway exists: ${!!this.whatsappGateway}`);
            console.log(`ðŸ“¤ [AGENT] DEBUG: whatsappGateway.getSock exists: ${!!(this.whatsappGateway && this.whatsappGateway.getSock)}`);
            
            if (this.whatsappGateway && this.whatsappGateway.getSock) {
                sock = this.whatsappGateway.getSock();
                console.log(`ðŸ“¤ [AGENT] DEBUG: Got socket from gateway: ${!!sock}`);
            }
            
            // If no socket from gateway, try to get from whatsapp gateway passed in constructor
            if (!sock && this.whatsappGateway) {
                try {
                    sock = this.whatsappGateway.getSock ? this.whatsappGateway.getSock() : null;
                    console.log(`ðŸ“¤ [AGENT] DEBUG: Got socket from gateway (retry): ${!!sock}`);
                } catch (e) {
                    console.log('Could not get socket from whatsapp gateway');
                }
            }
            
            if (sock && sock.sendMessage) {
                await sock.sendMessage(to, { text: messageText });
                console.log(`ðŸ“¤ [AGENT] Sent message to ${to}: ${messageText}`);
                return true;
            } else {
                console.log(`ðŸ“¤ [AGENT] [MOCK] Would send to ${to}: ${messageText}`);
                return true;
            }
        } catch (error) {
            console.error('Error sending WhatsApp message:', error);
            return false;
        }
    }

    // Test agent commands
    async testCommands() {
        console.log('ðŸ§ª Testing Agent WhatsApp Commands...');
        
        const testPhone = '081234567890@s.whatsapp.net';
        
        // Test help command
        console.log('Testing HELP command...');
        await this.commands.handleMessage(testPhone, 'HELP');
        
        // Test saldo command
        console.log('Testing SALDO command...');
        await this.commands.handleMessage(testPhone, 'SALDO');
        
        // Test jual command
        console.log('Testing JUAL command...');
        await this.commands.handleMessage(testPhone, 'JUAL 10K John 081234567890 YA');
        
        // Test bayar command
        console.log('Testing BAYAR command...');
        await this.commands.handleMessage(testPhone, 'BAYAR Jane 081234567891 50000 YA');
        
        // Test request command
        console.log('Testing REQUEST command...');
        await this.commands.handleMessage(testPhone, 'REQUEST 100000 Top up saldo');
        
        // Test riwayat command
        console.log('Testing RIWAYAT command...');
        await this.commands.handleMessage(testPhone, 'RIWAYAT');
        
        console.log('âœ… Agent WhatsApp Commands test completed');
    }
}

module.exports = AgentWhatsAppIntegration;
