const { getSubscriptionsByRole, sendPushToSubscriptions } = require('./pushNotificationManager');
const logger = require('./logger');

async function sendRolePush(role, userKeys, notification) {
    try {
        const normalizedKeys = Array.isArray(userKeys)
            ? [...new Set(userKeys.filter(Boolean).map((value) => String(value)))]
            : (userKeys ? [String(userKeys)] : []);

        let subscriptions = [];

        if (normalizedKeys.length > 0) {
            const rows = await Promise.all(
                normalizedKeys.map((key) => getSubscriptionsByRole(role, key))
            );
            subscriptions = rows.flat();
        } else {
            subscriptions = await getSubscriptionsByRole(role);
        }

        if (!subscriptions.length) {
            return { success: false, sent: 0, message: 'Tidak ada subscription aktif' };
        }

        return sendPushToSubscriptions(subscriptions, {
            role,
            ...notification
        });
    } catch (error) {
        logger.warn(`sendRolePush gagal untuk ${role}: ${error.message}`);
        return { success: false, sent: 0, message: error.message };
    }
}

async function notifyAdmins(notification) {
    return sendRolePush('admin', null, notification);
}

async function notifyTechnicians(notification, technicianIds = null) {
    return sendRolePush('technician', technicianIds, notification);
}

async function notifyAgents(notification, agentIds = null) {
    return sendRolePush('agent', agentIds, notification);
}

async function notifyCollectors(notification, collectorIds = null) {
    return sendRolePush('collector', collectorIds, notification);
}

async function notifyCustomer(notification, customer = {}) {
    const identifiers = [
        customer.username,
        customer.phone,
        customer.normalizedPhone
    ].filter(Boolean);

    return sendRolePush('customer', identifiers, notification);
}

module.exports = {
    sendRolePush,
    notifyAdmins,
    notifyTechnicians,
    notifyAgents,
    notifyCollectors,
    notifyCustomer
};
