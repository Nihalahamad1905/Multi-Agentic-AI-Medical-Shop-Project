const { pool } = require('../config/database');
const LLMService = require('./llmService');
const twilio = require('twilio');

class AutoRefillService {
    constructor() {
        this.llmService = new LLMService();
        this.twilioClient = null;
        this.initializeTwilio();
        this.isRunning = false;
        this.checkInterval = null;
    }

    initializeTwilio() {
        try {
            if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
                this.twilioClient = twilio(
                    process.env.TWILIO_ACCOUNT_SID,
                    process.env.TWILIO_AUTH_TOKEN
                );
                console.log('✅ AutoRefill: Twilio initialized successfully');
            }
        } catch (error) {
            console.error('❌ AutoRefill: Twilio initialization failed:', error.message);
        }
    }

    start(intervalHours = 24) {
        if (this.isRunning) {
            console.log('⚠️ AutoRefill service is already running');
            return;
        }

        console.log(`\n🚀 Starting AutoRefill SMS Service`);
        console.log(`📱 Checking every ${intervalHours} hours`);
        console.log(`📱 Real SMS will be sent to verified numbers\n`);
        
        this.isRunning = true;
        
        // Run immediately
        setTimeout(() => {
            this.checkAndSendRefillReminders();
        }, 5000);
        
        this.checkInterval = setInterval(
            () => this.checkAndSendRefillReminders(),
            intervalHours * 60 * 60 * 1000
        );
    }

    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        this.isRunning = false;
        console.log('🛑 AutoRefill service stopped');
    }

    async checkAndSendRefillReminders() {
        console.log(`\n🔍 AutoRefill: Checking for refill opportunities at ${new Date().toLocaleString()}`);
        
        try {
            // First, ensure the refill_reminders table has the correct structure
            await this.ensureRemindersTable();
            
            const customersNeedingRefill = await this.getCustomersForRefill();
            
            if (customersNeedingRefill.length === 0) {
                console.log('📭 No customers need refill reminders at this time');
                return;
            }

            console.log(`📊 Found ${customersNeedingRefill.length} customers who need refills`);

            for (const customer of customersNeedingRefill) {
                await this.processCustomerRefill(customer);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

        } catch (error) {
            console.error('❌ AutoRefill check error:', error.message);
        }
    }

async getCustomersForRefill() {
    try {
        // First, ensure the refill_reminders table has the correct structure
        await this.ensureRemindersTable();
        
        // Get all customers with their most recent order
        const [customers] = await pool.query(`
            SELECT 
                o.user_name,
                o.phone,
                o.medicine_name,
                o.quantity,
                o.created_at as purchase_date,
                o.order_id,
                o.consumption_rate,
                m.name as medicine_full_name,
                m.category,
                m.prescription_req,
                DATEDIFF(NOW(), o.created_at) as days_since_purchase
            FROM orders o
            JOIN medicines m ON LOWER(TRIM(o.medicine_name)) = LOWER(TRIM(m.name))
            WHERE o.status IN ('approved', 'delivered', 'completed')
            AND o.created_at = (
                SELECT MAX(created_at) 
                FROM orders o2 
                WHERE o2.phone = o.phone 
                AND o2.medicine_name = o.medicine_name
                AND o2.status IN ('approved', 'delivered', 'completed')
            )
            ORDER BY o.created_at DESC
        `);

        if (customers.length === 0) {
            console.log('📭 No customers found in orders table');
            return [];
        }

        console.log('\n📊 Checking refill needs based on consumption rate...');
        const customersNeedingRefill = [];

        for (const customer of customers) {
            // Skip if no consumption rate defined
            if (!customer.consumption_rate || customer.consumption_rate <= 0) {
                console.log(`\n⚠️ ${customer.user_name} - ${customer.medicine_name}: No consumption rate defined (value: ${customer.consumption_rate})`);
                continue;
            }

            // Calculate days until refill needed
            // Formula: (Quantity / Consumption Rate) - Days Since Purchase
            const daysSupply = Math.floor(customer.quantity / customer.consumption_rate);
            const daysUntilRefill = daysSupply - customer.days_since_purchase;
            
            // Calculate remaining tablets
            const tabletsRemaining = (customer.quantity - (customer.consumption_rate * customer.days_since_purchase));
            const remainingRounded = Math.max(0, Math.round(tabletsRemaining * 10) / 10);

            // Check if reminder already sent recently
            const alreadySentRecently = await this.checkRecentReminder(customer.phone, customer.medicine_name);

            console.log(`\n${'='.repeat(50)}`);
            console.log(`👤 Customer: ${customer.user_name} (${customer.phone})`);
            console.log(`💊 Medicine: ${customer.medicine_name}`);
            console.log(`📦 Purchase Date: ${new Date(customer.purchase_date).toLocaleDateString()}`);
            console.log(`📦 Quantity: ${customer.quantity} tablets`);
            console.log(`⚡ Consumption Rate: ${customer.consumption_rate} tablet(s) per day`);
            console.log(`📅 Days Since Purchase: ${customer.days_since_purchase}`);
            console.log(`📆 Total Days Supply: ${daysSupply} days`);
            console.log(`💊 Tablets Remaining: ${remainingRounded}`);
            console.log(`📆 Days Until Refill: ${daysUntilRefill}`);

            // Determine if refill is needed
            let needsRefill = false;
            let urgency = '';

            if (daysUntilRefill <= 0) {
                needsRefill = true;
                urgency = 'URGENT - OUT OF STOCK';
                console.log(`🔴 STATUS: ${urgency}`);
            } else if (daysUntilRefill <= 3) {
                needsRefill = true;
                urgency = 'REFILL SOON';
                console.log(`🟡 STATUS: ${urgency} (${daysUntilRefill} days left)`);
            } else {
                console.log(`🟢 STATUS: OK (${daysUntilRefill} days of supply left)`);
            }

            // Send reminder if needed and not sent recently
            if (needsRefill && !alreadySentRecently) {
                customersNeedingRefill.push({
                    customerName: customer.user_name,
                    phone: customer.phone,
                    medicineName: customer.medicine_name,
                    medicineFullName: customer.medicine_full_name,
                    lastPurchaseDate: customer.purchase_date,
                    daysSincePurchase: customer.days_since_purchase,
                    quantity: customer.quantity,
                    consumptionRate: customer.consumption_rate,
                    tabletsRemaining: remainingRounded,
                    daysUntilRefill: daysUntilRefill,
                    urgency: urgency,
                    prescriptionRequired: customer.prescription_req === 1,
                    category: customer.category,
                    lastOrderId: customer.order_id
                });
                
                console.log(`✅ MARKED FOR REFILL REMINDER`);
            } else if (alreadySentRecently) {
                console.log(`⏸️ Reminder already sent in last 7 days`);
            }
        }

        console.log(`\n📊 Total customers needing refill: ${customersNeedingRefill.length}`);
        return customersNeedingRefill;

    } catch (error) {
        console.error('❌ Error getting customers for refill:', error.message);
        console.error('📝 SQL Query that failed:', error.sql); // This will help debug
        return [];
    }
}

    async checkRecentReminder(phone, medicineName) {
        try {
            // First check if the column exists
            const [columns] = await pool.query(`
                SELECT COLUMN_NAME 
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_NAME = 'refill_reminders' 
                AND COLUMN_NAME = 'sent_at'
            `);
            
            if (columns.length === 0) {
                // Column doesn't exist, add it
                await pool.query(`
                    ALTER TABLE refill_reminders 
                    ADD COLUMN sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                `);
                console.log('✅ Added sent_at column to refill_reminders table');
            }

            const [rows] = await pool.query(`
                SELECT COUNT(*) as count 
                FROM refill_reminders 
                WHERE phone = ? 
                AND medicine_name = ? 
                AND sent_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
            `, [phone, medicineName]);
            
            return rows[0].count > 0;
        } catch (error) {
            console.error('Error checking recent reminder:', error.message);
            return false;
        }
    }

async processCustomerRefill(customerData) {
    try {
        console.log(`\n💊 Sending refill reminder to ${customerData.customerName} (${customerData.phone})`);

        // Generate reminder using simple calculation
        const reminderMessage = this.generateSimpleReminder(customerData);

        // Send SMS
        if (this.twilioClient) {
            const smsResult = await this.sendRefillSMS({
                message: reminderMessage,
                customerPhone: customerData.phone,
                medicineName: customerData.medicineName,
                generatedBy: 'Simple'
            }, customerData);
            
            if (smsResult.success) {
                // Log the reminder
                await this.logRefillReminder({
                    customerName: customerData.customerName,
                    phone: customerData.phone,
                    medicineName: customerData.medicineName,
                    message: reminderMessage,
                    generatedBy: 'Simple',
                    daysUntilRefill: customerData.daysUntilRefill,
                    tabletsRemaining: customerData.tabletsRemaining,
                    consumptionRate: customerData.consumptionRate,
                    lastOrderId: customerData.lastOrderId,
                    smsSid: smsResult.sid
                });

                console.log(`✅ SMS SENT to ${customerData.phone}`);
                console.log(`📱 Message: "${reminderMessage}"`);
            }
        } else {
            console.log(`\n📱 WOULD SEND SMS to ${customerData.phone}:`);
            console.log(`   "${reminderMessage}"`);
        }

    } catch (error) {
        console.error(`❌ Error processing refill for ${customerData.customerName}:`, error.message);
    }
}

generateSimpleReminder(customerData) {
    if (customerData.daysUntilRefill <= 0) {
        return `Hi ${customerData.customerName}, you are out of ${customerData.medicineName}. Please refill immediately! Order here: [link]`;
    } else if (customerData.daysUntilRefill === 1) {
        return `Hi ${customerData.customerName}, you have only 1 day of ${customerData.medicineName} left. Refill now: [link]`;
    } else {
        return `Hi ${customerData.customerName}, you have ${customerData.daysUntilRefill} days of ${customerData.medicineName} left. Refill soon: [link]`;
    }
}

    async sendRefillSMS(reminderData, customerData) {
        try {
            if (!this.twilioClient) {
                return { success: false, error: 'Twilio not configured' };
            }

            // Format phone number
            let formattedPhone = customerData.phone;
            formattedPhone = formattedPhone.replace(/\s+/g, '');
            
            if (!formattedPhone.startsWith('+')) {
                if (formattedPhone.length === 10) {
                    formattedPhone = `+91${formattedPhone}`;
                } else {
                    formattedPhone = `+${formattedPhone}`;
                }
            }

            // Create order link with quantity suggestion
            const orderLink = `${process.env.APP_URL || 'http://localhost:3000'}/order?medicine=${encodeURIComponent(customerData.medicineName)}&quantity=${customerData.lastQuantity || 1}&phone=${encodeURIComponent(customerData.phone)}`;
            
            // Prepare final message
            let finalMessage = reminderData.message;
            if (!finalMessage.includes('[link]') && !finalMessage.includes('http')) {
                finalMessage += ` Order here: ${orderLink}`;
            } else {
                finalMessage = finalMessage.replace('[link]', orderLink);
            }

            // Truncate if too long
            if (finalMessage.length > 160) {
                finalMessage = finalMessage.substring(0, 140) + '... Order now.';
            }

            const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
            if (!twilioPhoneNumber) {
                return { success: false, error: 'TWILIO_PHONE_NUMBER not set' };
            }

            console.log(`📤 Sending SMS to ${formattedPhone}`);
            
            // Remove statusCallback for local development
            const smsMessage = await this.twilioClient.messages.create({
                body: finalMessage,
                from: twilioPhoneNumber,
                to: formattedPhone
                // Removed statusCallback to avoid URL error
            });

            console.log(`✅ SMS sent! SID: ${smsMessage.sid}`);
            
            return { 
                success: true, 
                sid: smsMessage.sid,
                status: smsMessage.status
            };

        } catch (error) {
            console.error('❌ Failed to send SMS:');
            
            if (error.code === 21211) {
                console.error('   Invalid phone number format');
            } else if (error.code === 21608) {
                console.error('   ❗ Phone number not verified in Twilio');
                console.error(`   Add this number: ${customerData.phone}`);
            } else {
                console.error(`   Error: ${error.message}`);
            }
            
            return { success: false, error: error.message };
        }
    }

    async logRefillReminder(reminderData) {
        try {
            await this.ensureRemindersTable();

            await pool.query(`
                INSERT INTO refill_reminders 
                (customer_name, phone, medicine_name, message, generated_by, 
                 days_until_refill, avg_refill_interval, last_order_id, responded, sent_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE, NOW())
            `, [
                reminderData.customerName,
                reminderData.phone,
                reminderData.medicineName,
                reminderData.message,
                reminderData.generatedBy,
                reminderData.daysUntilRefill,
                reminderData.dailyConsumption, // Using dailyConsumption as avg_refill_interval
                reminderData.lastOrderId
            ]);

            console.log(`📝 Refill reminder logged to database`);
        } catch (error) {
            console.error('❌ Failed to log refill reminder:', error.message);
        }
    }

    async ensureRemindersTable() {
    try {
        // Check if table exists
        const [tables] = await pool.query("SHOW TABLES LIKE 'refill_reminders'");
        
        if (tables.length === 0) {
            // Create table with correct structure - only ONE TIMESTAMP with CURRENT_TIMESTAMP
            await pool.query(`
                CREATE TABLE refill_reminders (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    customer_name VARCHAR(255) NOT NULL,
                    phone VARCHAR(20) NOT NULL,
                    medicine_name VARCHAR(255) NOT NULL,
                    message TEXT,
                    generated_by VARCHAR(50) DEFAULT 'LLM',
                    days_until_refill INT,
                    avg_refill_interval INT,
                    last_order_id VARCHAR(50),
                    responded BOOLEAN DEFAULT FALSE,
                    response_data JSON,
                    sms_sid VARCHAR(255),
                    sent_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                    responded_at TIMESTAMP NULL,
                    INDEX idx_phone (phone),
                    INDEX idx_sent_at (sent_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=latin1
            `);
            console.log('✅ Created refill_reminders table');
        } else {
            // Check and fix table structure
            const [columns] = await pool.query(`
                SELECT COLUMN_NAME, COLUMN_TYPE 
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_NAME = 'refill_reminders'
            `);
            
            const columnNames = columns.map(c => c.COLUMN_NAME);
            
            // Add missing columns one by one
            if (!columnNames.includes('sent_at')) {
                await pool.query('ALTER TABLE refill_reminders ADD COLUMN sent_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP');
                console.log('✅ Added sent_at column');
            }
            
            if (!columnNames.includes('avg_refill_interval')) {
                await pool.query('ALTER TABLE refill_reminders ADD COLUMN avg_refill_interval INT');
                console.log('✅ Added avg_refill_interval column');
            }
            
            if (!columnNames.includes('last_order_id')) {
                await pool.query('ALTER TABLE refill_reminders ADD COLUMN last_order_id VARCHAR(50)');
                console.log('✅ Added last_order_id column');
            }
            
            if (!columnNames.includes('responded_at')) {
                await pool.query('ALTER TABLE refill_reminders ADD COLUMN responded_at TIMESTAMP NULL');
                console.log('✅ Added responded_at column');
            }
            
            if (!columnNames.includes('sms_sid')) {
                await pool.query('ALTER TABLE refill_reminders ADD COLUMN sms_sid VARCHAR(255)');
                console.log('✅ Added sms_sid column');
            }
        }
    } catch (error) {
        console.error('❌ Failed to setup refill_reminders table:', error.message);
    }
}
}
module.exports = AutoRefillService;