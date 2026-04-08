/**
 * CLEAN VERSION - adminMappingNew.js
 * Perbaikan:
 * 1. Hapus duplicate function getParameterValue
 * 2. Hapus fallback ONU palsu online/offline acak
 * 3. Status ONU berdasarkan _lastInform dari GenieACS
 * 4. Matching customer/device berdasarkan PPPoE username
 * 5. Backbone gabungan network_segments + odp_connections
 */

const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { adminAuth } = require('./adminAuth');
const { getSettingsWithCache } = require('../config/settingsManager');

// Helper function untuk mendapatkan parameter value dari device GenieACS
function getParameterValue(device, parameterPath) {
    try {
        if (!device || !parameterPath) return null;

        const parts = parameterPath.split('.');
        let current = device;

        for (const part of parts) {
            if (!current || typeof current !== 'object') return null;
            current = current[part];
        }

        if (current && typeof current === 'object' && current._value !== undefined) {
            return current._value;
        }

        return current ?? null;
    } catch (error) {
        console.error(`Error getting parameter ${parameterPath}:`, error);
        return null;
    }
}

// Helper function untuk mendapatkan status device
function getDeviceStatus(lastInform) {
    if (!lastInform) return 'Offline';

    const now = new Date();
    const lastInformTime = new Date(lastInform);
    const diffMinutes = (now - lastInformTime) / (1000 * 60);

    return diffMinutes <= 60 ? 'Online' : 'Offline';
}

// Helper function untuk memvalidasi dan membersihkan PPPoE username
function sanitizePPPoEUsername(username) {
    if (!username) return null;

    if (typeof username === 'object') {
        username = JSON.stringify(username);
    }

    if (typeof username !== 'string') {
        return null;
    }

    username = username.trim();

    if (
        username === '-' ||
        username === '' ||
        username === 'null' ||
        username === 'undefined'
    ) {
        return null;
    }

    return username;
}

// Helper function untuk memvalidasi device ID
function getValidDeviceId(device) {
    if (!device) return null;

    const possibleIds = [
        device._id,
        device.id,
        typeof device.DeviceID === 'string' ? device.DeviceID : null,
        device._deviceId
    ];

    for (const id of possibleIds) {
        if (id && typeof id === 'string' && id.trim() !== '') {
            return id.trim();
        }
    }

    return `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Helper function untuk mendapatkan nilai RXPower dengan multiple paths
function getRXPowerValue(device) {
    try {
        const rxPowerPaths = [
            'VirtualParameters.RXPower',
            'VirtualParameters.redaman',
            'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
            'Device.XPON.Interface.1.Stats.RXPower',
            'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower._value',
            'VirtualParameters.RXPower._value',
            'Device.XPON.Interface.1.Stats.RXPower._value'
        ];

        for (const path of rxPowerPaths) {
            const value = getParameterValue(device, path);
            if (value !== null && value !== undefined && value !== '') {
                const numValue = parseFloat(value);
                if (!isNaN(numValue)) {
                    return value;
                }
            }
        }

        return null;
    } catch (error) {
        console.error('Error getting RXPower:', error);
        return null;
    }
}

// Helper function untuk mendapatkan nilai TXPower dengan multiple paths
function getTXPowerValue(device) {
    try {
        const txPowerPaths = [
            'VirtualParameters.TXPower',
            'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.TXPower',
            'Device.XPON.Interface.1.Stats.TXPower',
            'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.TXPower._value',
            'VirtualParameters.TXPower._value',
            'Device.XPON.Interface.1.Stats.TXPower._value'
        ];

        for (const path of txPowerPaths) {
            const value = getParameterValue(device, path);
            if (value !== null && value !== undefined && value !== '') {
                const numValue = parseFloat(value);
                if (!isNaN(numValue)) {
                    return value;
                }
            }
        }

        return null;
    } catch (error) {
        console.error('Error getting TXPower:', error);
        return null;
    }
}

// Helper function untuk ambil parameter dari beberapa path
function getParameterWithPaths(device, paths) {
    for (const p of paths) {
        const value = getParameterValue(device, p);
        if (value !== null && value !== undefined && value !== '' && value !== '-') {
            return value;
        }
    }
    return null;
}

// Main admin mapping page
router.get('/mapping-new', adminAuth, async (req, res) => {
    try {
        res.render('admin/billing/mapping-new', {
            title: 'Network Mapping',
            user: req.user,
            page: 'mapping-new',
            settings: getSettingsWithCache()
        });
    } catch (error) {
        console.error('Error rendering admin mapping page:', error);
        res.status(500).render('error', {
            message: 'Error loading network mapping page',
            error
        });
    }
});

// API endpoint untuk mapping data baru
router.get('/api/mapping/new', adminAuth, async (req, res) => {
    try {
        console.log('🚀 New Mapping API - Loading network data...');

        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);

        const [
            customers,
            odps,
            cables,
            backboneCables
        ] = await Promise.all([
            // Customers
            new Promise((resolve) => {
                db.all(`
                    SELECT c.id, c.name, c.phone, c.email, c.pppoe_username, c.latitude, c.longitude,
                           c.address, c.house_photo, c.package_id, c.status, c.join_date, c.odp_id,
                           p.name as package_name,
                           o.name as odp_name
                    FROM customers c
                    LEFT JOIN packages p ON c.package_id = p.id
                    LEFT JOIN odps o ON c.odp_id = o.id
                    WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
                    ORDER BY c.name
                `, [], (err, rows) => {
                    if (err) {
                        console.error('❌ Error loading customers:', err);
                        resolve([]);
                    } else {
                        resolve(rows || []);
                    }
                });
            }),

            // ODPs
            new Promise((resolve) => {
                db.all(`
                    SELECT id, name, code, latitude, longitude, address,
                           capacity, used_ports, status, installation_date, photo
                    FROM odps
                    ORDER BY name
                `, [], (err, rows) => {
                    if (err) {
                        console.error('❌ Error loading ODPs:', err);
                        resolve([]);
                    } else {
                        resolve(rows || []);
                    }
                });
            }),

            // Cable routes
            new Promise((resolve) => {
                db.all(`
                    SELECT cr.id, cr.customer_id, cr.odp_id, cr.cable_length, cr.cable_type,
                           cr.installation_date, cr.status, cr.port_number, cr.notes,
                           c.name as customer_name, c.phone as customer_phone,
                           c.latitude as customer_latitude, c.longitude as customer_longitude,
                           o.name as odp_name, o.code as odp_code,
                           o.latitude as odp_latitude, o.longitude as odp_longitude
                    FROM cable_routes cr
                    LEFT JOIN customers c ON cr.customer_id = c.id
                    LEFT JOIN odps o ON cr.odp_id = o.id
                    WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
                      AND o.latitude IS NOT NULL AND o.longitude IS NOT NULL
                    ORDER BY cr.id
                `, [], (err, rows) => {
                    if (err) {
                        console.error('❌ Error loading cables:', err);
                        resolve([]);
                    } else {
                        resolve(rows || []);
                    }
                });
            }),

            // Backbone cables: gabungan network_segments + odp_connections
            new Promise((resolve) => {
                db.all(`
                    SELECT ns.id, ns.name, ns.start_odp_id, ns.end_odp_id, ns.cable_length,
                           ns.segment_type, ns.installation_date, ns.status, ns.notes,
                           start_odp.name as start_odp_name, start_odp.code as start_odp_code,
                           start_odp.latitude as start_odp_latitude, start_odp.longitude as start_odp_longitude,
                           end_odp.name as end_odp_name, end_odp.code as end_odp_code,
                           end_odp.latitude as end_odp_latitude, end_odp.longitude as end_odp_longitude,
                           'network_segments' as source_table
                    FROM network_segments ns
                    LEFT JOIN odps start_odp ON ns.start_odp_id = start_odp.id
                    LEFT JOIN odps end_odp ON ns.end_odp_id = end_odp.id
                    WHERE start_odp.latitude IS NOT NULL AND start_odp.longitude IS NOT NULL
                      AND end_odp.latitude IS NOT NULL AND end_odp.longitude IS NOT NULL

                    UNION ALL

                    SELECT oc.id + 10000 as id,
                           'Connection-' || from_odp.name || '-' || to_odp.name as name,
                           oc.from_odp_id as start_odp_id,
                           oc.to_odp_id as end_odp_id,
                           oc.cable_length,
                           oc.connection_type as segment_type,
                           oc.installation_date,
                           oc.status,
                           oc.notes,
                           from_odp.name as start_odp_name,
                           from_odp.code as start_odp_code,
                           from_odp.latitude as start_odp_latitude,
                           from_odp.longitude as start_odp_longitude,
                           to_odp.name as end_odp_name,
                           to_odp.code as end_odp_code,
                           to_odp.latitude as end_odp_latitude,
                           to_odp.longitude as end_odp_longitude,
                           'odp_connections' as source_table
                    FROM odp_connections oc
                    LEFT JOIN odps from_odp ON oc.from_odp_id = from_odp.id
                    LEFT JOIN odps to_odp ON oc.to_odp_id = to_odp.id
                    WHERE from_odp.latitude IS NOT NULL AND from_odp.longitude IS NOT NULL
                      AND to_odp.latitude IS NOT NULL AND to_odp.longitude IS NOT NULL
                      AND oc.status = 'active'

                    ORDER BY name
                `, [], (err, rows) => {
                    if (err) {
                        console.error('❌ Error loading backbone cables:', err);
                        resolve([]);
                    } else {
                        resolve(rows || []);
                    }
                });
            })
        ]);

        console.log(`✅ Loaded base data: customers=${customers.length}, odps=${odps.length}, cables=${cables.length}, backbone=${backboneCables.length}`);

        // Load ONU devices dari GenieACS dan merge dengan customer
        let onuDevices = [];

        try {
            const { getDevices } = require('../config/genieacs');
            const genieacsDevices = await getDevices();

            if (!Array.isArray(genieacsDevices) || genieacsDevices.length === 0) {
                throw new Error('No GenieACS data available');
            }

            console.log(`📊 Found ${genieacsDevices.length} devices from GenieACS`);

            const parameterPaths = {
                pppUsername: [
                    'VirtualParameters.pppoeUsername',
                    'VirtualParameters.pppUsername',
                    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username'
                ],
                serialNumber: [
                    'VirtualParameters.getSerialNumber',
                    'Device.DeviceInfo.SerialNumber',
                    'DeviceID.SerialNumber'
                ],
                model: [
                    'DeviceID.ProductClass',
                    'Device.DeviceInfo.ModelName',
                    'Device.DeviceInfo.ProductClass'
                ],
                ssid: [
                    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
                    'Device.WiFi.SSID.1.SSID',
                    'VirtualParameters.wifiSSID'
                ],
                password: [
                    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
                    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
                    'VirtualParameters.wifiPassword'
                ],
                firmware: [
                    'Device.DeviceInfo.SoftwareVersion',
                    'InternetGatewayDevice.DeviceInfo.SoftwareVersion'
                ],
                hardware: [
                    'Device.DeviceInfo.HardwareVersion',
                    'InternetGatewayDevice.DeviceInfo.HardwareVersion'
                ],
                ipAddress: [
                    'VirtualParameters.pppoeIP',
                    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress'
                ],
                macAddress: [
                    'VirtualParameters.pppoeMac',
                    'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.1.MACAddress'
                ]
            };

            const customerByPppoe = {};
            for (const customer of customers) {
                const pppoe = sanitizePPPoEUsername(customer.pppoe_username);
                if (pppoe) {
                    customerByPppoe[pppoe.toLowerCase()] = customer;
                }
            }

            const devicesWithCoords = [];

            for (const device of genieacsDevices) {
                try {
                    const deviceId = getValidDeviceId(device);

                    const pppoeUsername = sanitizePPPoEUsername(
                        getParameterWithPaths(device, parameterPaths.pppUsername)
                    );

                    if (!pppoeUsername) {
                        continue;
                    }

                    const customerData = customerByPppoe[pppoeUsername.toLowerCase()];
                    if (!customerData) {
                        continue;
                    }

                    const deviceStatus = getDeviceStatus(device._lastInform);

                    devicesWithCoords.push({
                        id: deviceId,
                        serialNumber: getParameterWithPaths(device, parameterPaths.serialNumber) || 'N/A',
                        name: getParameterWithPaths(device, parameterPaths.model) || 'N/A',
                        model: getParameterWithPaths(device, parameterPaths.model) || 'N/A',
                        status: deviceStatus,
                        ssid: getParameterWithPaths(device, parameterPaths.ssid) || 'N/A',
                        password: getParameterWithPaths(device, parameterPaths.password) || 'N/A',
                        latitude: customerData.latitude,
                        longitude: customerData.longitude,
                        customerName: customerData.name,
                        customerId: customerData.id,
                        customerPhone: customerData.phone,
                        customerPPPoE: customerData.pppoe_username,
                        customerAddress: customerData.address,
                        customerHousePhoto: customerData.house_photo || null,
                        customerPackage: customerData.package_name || customerData.package_id || 'N/A',
                        customerStatus: customerData.status,
                        odpName: customerData.odp_name || customerData.odp_id || 'N/A',
                        rxPower: getRXPowerValue(device) || 'N/A',
                        txPower: getTXPowerValue(device) || 'N/A',
                        temperature: getParameterValue(device, 'VirtualParameters.gettemp') ||
                                     getParameterValue(device, 'VirtualParameters.temperature') || 'N/A',
                        uptime: getParameterValue(device, 'VirtualParameters.getdeviceuptime') ||
                                getParameterValue(device, 'VirtualParameters.deviceUptime') || 'N/A',
                        lastInform: device._lastInform || null,
                        firmware: getParameterWithPaths(device, parameterPaths.firmware) || 'N/A',
                        hardware: getParameterWithPaths(device, parameterPaths.hardware) || 'N/A',
                        ipAddress: getParameterWithPaths(device, parameterPaths.ipAddress) || 'N/A',
                        macAddress: getParameterWithPaths(device, parameterPaths.macAddress) || 'N/A',
                        coordinateSource: 'pppoe_username',
                        genieacsData: {
                            manufacturer: getParameterValue(device, 'Device.DeviceInfo.Manufacturer') || 'N/A',
                            hardwareVersion: getParameterWithPaths(device, parameterPaths.hardware) || 'N/A',
                            softwareVersion: getParameterWithPaths(device, parameterPaths.firmware) || 'N/A',
                            deviceUptime: getParameterValue(device, 'VirtualParameters.getdeviceuptime') || 'N/A',
                            pppoeUsername: pppoeUsername || 'N/A',
                            pppoeIP: getParameterWithPaths(device, parameterPaths.ipAddress) || 'N/A',
                            pppoeMac: getParameterWithPaths(device, parameterPaths.macAddress) || 'N/A'
                        }
                    });
                } catch (deviceError) {
                    console.error('❌ Error processing device:', deviceError.message);
                }
            }

            onuDevices = devicesWithCoords;
            console.log(`✅ Created ${onuDevices.length} ONU devices with coordinates from GenieACS`);
        } catch (error) {
            console.error('❌ Error loading ONU devices from GenieACS:', error.message);
            onuDevices = [];
        }

        db.close();

        const statistics = {
            totalCustomers: customers.length,
            totalONU: onuDevices.length,
            onlineONU: onuDevices.filter(d => d.status === 'Online').length,
            offlineONU: onuDevices.filter(d => d.status === 'Offline').length,
            totalODP: odps.length,
            totalCables: cables.length,
            totalBackboneCables: backboneCables.length,
            connectedCables: cables.filter(c => c.status === 'connected').length,
            disconnectedCables: cables.filter(c => c.status === 'disconnected').length
        };

        const formattedCables = cables.map(cable => ({
            id: cable.id,
            coordinates: [
                [cable.odp_latitude, cable.odp_longitude],
                [cable.customer_latitude, cable.customer_longitude]
            ],
            from: cable.odp_name,
            to: cable.customer_name,
            type: 'Access Cable',
            length: cable.cable_length || 'N/A',
            status: cable.status,
            customer_name: cable.customer_name,
            customer_phone: cable.customer_phone,
            odp_name: cable.odp_name,
            port_number: cable.port_number,
            notes: cable.notes
        }));

        const formattedBackboneCables = backboneCables.map(cable => ({
            id: cable.id,
            coordinates: [
                [cable.start_odp_latitude, cable.start_odp_longitude],
                [cable.end_odp_latitude, cable.end_odp_longitude]
            ],
            from: cable.start_odp_name,
            to: cable.end_odp_name,
            type: cable.segment_type || 'Backbone',
            length: cable.cable_length || 'N/A',
            status: cable.status,
            name: cable.name,
            notes: cable.notes
        }));

        console.log('✅ New Mapping API - Data loaded successfully:', statistics);

        res.json({
            success: true,
            data: {
                customers: customers,
                onuDevices: onuDevices,
                odps: odps,
                cables: formattedCables,
                backboneCables: formattedBackboneCables,
                statistics: statistics
            }
        });
    } catch (error) {
        console.error('❌ Error in new mapping API:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API endpoint untuk update ONU device
router.post('/update-onu', adminAuth, async (req, res) => {
    try {
        console.log('🔄 Update ONU API - Processing request...');
        console.log('📋 Request data:', req.body);

        const {
            id,
            name,
            serial_number,
            mac_address,
            ip_address,
            status,
            latitude,
            longitude,
            customer_id,
            odp_id
        } = req.body;

        if (!id || !name || !serial_number || !mac_address) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: id, name, serial_number, mac_address'
            });
        }

        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);

        const existingDevice = await new Promise((resolve, reject) => {
            db.get(`SELECT id FROM onu_devices WHERE id = ?`, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (existingDevice) {
            await new Promise((resolve, reject) => {
                db.run(`
                    UPDATE onu_devices SET
                        name = ?,
                        serial_number = ?,
                        mac_address = ?,
                        ip_address = ?,
                        status = ?,
                        latitude = ?,
                        longitude = ?,
                        customer_id = ?,
                        odp_id = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [name, serial_number, mac_address, ip_address, status, latitude, longitude, customer_id, odp_id, id], function(err) {
                    if (err) reject(err);
                    else resolve();
                });
            });
        } else {
            await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO onu_devices (
                        id, name, serial_number, mac_address, ip_address, status,
                        latitude, longitude, customer_id, odp_id, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `, [id, name, serial_number, mac_address, ip_address, status, latitude, longitude, customer_id, odp_id], function(err) {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }

        db.close();

        try {
            const cacheManager = require('../config/cacheManager');
            cacheManager.invalidatePattern('genieacs:*');
        } catch (cacheError) {
            console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
        }

        res.json({
            success: true,
            message: 'ONU device updated successfully',
            data: {
                id,
                name,
                serial_number,
                mac_address,
                ip_address,
                status,
                latitude,
                longitude,
                customer_id,
                odp_id
            }
        });
    } catch (error) {
        console.error('❌ Error updating ONU device:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating ONU device: ' + error.message
        });
    }
});

// API endpoint untuk mendapatkan detail ODP
router.get('/odp/:id', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'ODP ID is required'
            });
        }

        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);

        const odp = await new Promise((resolve, reject) => {
            db.get(`
                SELECT id, name, code, capacity, used_ports, status,
                       address, latitude, longitude, installation_date, photo,
                       created_at, updated_at
                FROM odps
                WHERE id = ?
            `, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        db.close();

        if (!odp) {
            return res.status(404).json({
                success: false,
                message: 'ODP not found'
            });
        }

        res.json({
            success: true,
            data: odp
        });
    } catch (error) {
        console.error('❌ Error getting ODP details:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting ODP details: ' + error.message
        });
    }
});

// API endpoint untuk update ODP
router.post('/update-odp', adminAuth, async (req, res) => {
    try {
        console.log('🔄 Update ODP API - Processing request...');
        console.log('📋 Request data:', req.body);

        const {
            id,
            name,
            code,
            capacity,
            used_ports,
            status,
            address,
            latitude,
            longitude,
            installation_date
        } = req.body;

        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: id'
            });
        }

        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);

        const existingODP = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM odps WHERE id = ?`, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (existingODP) {
            const fields = [];
            const values = [];

            if (name !== undefined) {
                fields.push('name = ?');
                values.push(name);
            }
            if (code !== undefined) {
                fields.push('code = ?');
                values.push(code);
            }
            if (capacity !== undefined) {
                fields.push('capacity = ?');
                values.push(capacity);
            }
            if (used_ports !== undefined) {
                fields.push('used_ports = ?');
                values.push(used_ports);
            }
            if (status !== undefined) {
                fields.push('status = ?');
                values.push(status);
            }
            if (address !== undefined) {
                fields.push('address = ?');
                values.push(address);
            }
            if (latitude !== undefined) {
                fields.push('latitude = ?');
                values.push(latitude);
            }
            if (longitude !== undefined) {
                fields.push('longitude = ?');
                values.push(longitude);
            }
            if (installation_date !== undefined) {
                fields.push('installation_date = ?');
                values.push(installation_date);
            }

            fields.push('updated_at = CURRENT_TIMESTAMP');

            if (fields.length > 1) {
                await new Promise((resolve, reject) => {
                    const query = `UPDATE odps SET ${fields.join(', ')} WHERE id = ?`;
                    values.push(id);

                    db.run(query, values, function(err) {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }
        } else {
            if (!name || !code || !capacity) {
                db.close();
                return res.status(400).json({
                    success: false,
                    message: 'Missing required fields for new ODP: name, code, capacity'
                });
            }

            await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO odps (
                        id, name, code, capacity, used_ports, status,
                        address, latitude, longitude, installation_date, photo,
                       created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `, [id, name, code, capacity, used_ports || 0, status || 'active', address || '', latitude || 0, longitude || 0, installation_date || null], function(err) {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }

        db.close();

        try {
            const cacheManager = require('../config/cacheManager');
            cacheManager.invalidatePattern('genieacs:*');
        } catch (cacheError) {
            console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
        }

        res.json({
            success: true,
            message: 'ODP updated successfully',
            data: {
                id,
                name,
                code,
                capacity,
                used_ports,
                status,
                address,
                latitude,
                longitude,
                installation_date
            }
        });
    } catch (error) {
        console.error('❌ Error updating ODP:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating ODP: ' + error.message
        });
    }
});

// API endpoint untuk update Customer
router.post('/update-customer', adminAuth, async (req, res) => {
    try {
        console.log('🔄 Update Customer API - Processing request...');
        console.log('📋 Request data:', req.body);

        const {
            id,
            name,
            phone,
            email,
            pppoe_username,
            status,
            address,
            latitude,
            longitude,
            package_id,
            odp_id,
            join_date
        } = req.body;

        if (!id || !name || !phone) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: id, name, phone'
            });
        }

        const dbPath = path.join(__dirname, '../data/billing.db');
        const db = new sqlite3.Database(dbPath);

        const existingCustomer = await new Promise((resolve, reject) => {
            db.get(`SELECT id FROM customers WHERE id = ?`, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (existingCustomer) {
            await new Promise((resolve, reject) => {
                db.run(`
                    UPDATE customers SET
                        name = ?,
                        phone = ?,
                        email = ?,
                        pppoe_username = ?,
                        status = ?,
                        address = ?,
                        latitude = ?,
                        longitude = ?,
                        package_id = ?,
                        odp_id = ?,
                        join_date = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [name, phone, email, pppoe_username, status, address, latitude, longitude, package_id, odp_id, join_date, id], function(err) {
                    if (err) reject(err);
                    else resolve();
                });
            });
        } else {
            await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO customers (
                        id, name, phone, email, pppoe_username, status,
                        address, latitude, longitude, package_id, odp_id, join_date,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `, [id, name, phone, email, pppoe_username, status, address, latitude, longitude, package_id, odp_id, join_date], function(err) {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }

        db.close();

        try {
            const cacheManager = require('../config/cacheManager');
            cacheManager.invalidatePattern('genieacs:*');
        } catch (cacheError) {
            console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
        }

        res.json({
            success: true,
            message: 'Customer updated successfully',
            data: {
                id,
                name,
                phone,
                email,
                pppoe_username,
                status,
                address,
                latitude,
                longitude,
                package_id,
                odp_id,
                join_date
            }
        });
    } catch (error) {
        console.error('❌ Error updating Customer:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating Customer: ' + error.message
        });
    }
});

// API endpoint untuk restart ONU device via GenieACS
router.post('/restart-onu', adminAuth, async (req, res) => {
    try {
        console.log('🔄 Restart ONU API - Processing request...');
        console.log('📋 Request data:', req.body);

        const { deviceId, deviceName, serialNumber, customerName } = req.body;

        if (!deviceId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: deviceId'
            });
        }

        const { getGenieACSConfig } = require('../config/genieacs');
        const genieacsConfig = getGenieACSConfig();

        if (!genieacsConfig || !genieacsConfig.url || !genieacsConfig.username || !genieacsConfig.password) {
            return res.status(500).json({
                success: false,
                message: 'GenieACS configuration not found or incomplete'
            });
        }

        const genieacsUrl = `${genieacsConfig.url}/devices/${encodeURIComponent(deviceId)}/tasks`;
        const auth = Buffer.from(`${genieacsConfig.username}:${genieacsConfig.password}`).toString('base64');

        const restartTask = {
            name: 'reboot',
            objectName: 'Device.Reboot',
            object: 'Device.Reboot',
            parameters: {
                CommandKey: 'Reboot'
            }
        };

        const response = await fetch(genieacsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`
            },
            body: JSON.stringify(restartTask)
        });

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(500).json({
                success: false,
                message: `GenieACS API error: ${response.status} - ${errorText}`
            });
        }

        const result = await response.json();

        try {
            const dbPath = path.join(__dirname, '../data/billing.db');
            const db = new sqlite3.Database(dbPath);

            await new Promise((resolve) => {
                db.run(`
                    INSERT INTO device_actions (
                        device_id, device_name, serial_number, customer_name,
                        action_type, action_status, action_details, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                `, [
                    deviceId,
                    deviceName || 'Unknown',
                    serialNumber || 'Unknown',
                    customerName || 'Unknown',
                    'restart',
                    'initiated',
                    JSON.stringify({
                        genieacs_task_id: result._id,
                        restart_time: new Date().toISOString(),
                        api_response: result
                    })
                ], function(err) {
                    if (err) {
                        console.error('❌ Error logging restart action:', err);
                    }
                    resolve();
                });
            });

            db.close();
        } catch (logError) {
            console.error('❌ Error logging restart action to database:', logError);
        }

        try {
            const cacheManager = require('../config/cacheManager');
            cacheManager.invalidatePattern('genieacs:*');
        } catch (cacheError) {
            console.warn('⚠️ Failed to invalidate cache:', cacheError.message);
        }

        res.json({
            success: true,
            message: 'ONU restart initiated successfully',
            data: {
                deviceId,
                deviceName,
                serialNumber,
                customerName,
                genieacsTaskId: result._id,
                restartTime: new Date().toISOString(),
                status: 'initiated'
            }
        });
    } catch (error) {
        console.error('❌ Error restarting ONU device:', error);
        res.status(500).json({
            success: false,
            message: 'Error restarting ONU device: ' + error.message
        });
    }
});

module.exports = router;






