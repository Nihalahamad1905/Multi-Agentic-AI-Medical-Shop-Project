require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const twilio = require('twilio');

const { pool, testConnection } = require('./config/database');
const AgentOrchestrator = require('./agents');
const { getTraceUrl } = require('./config/observability');
const PrescriptionValidator = require('./prescriptionValidator');

// Import NLP Service
const NLPService = require('./services/nlpService');

// Import Auto Refill Service with LLM
const AutoRefillService = require('./services/autoRefillService');
const LLMService = require('./services/llmService');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize NLP Service
const nlpService = new NLPService();

// Initialize Twilio (only if credentials are provided)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
        twilioClient = twilio(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
        );
        console.log('✅ Twilio initialized');
    } catch (error) {
        console.error('❌ Twilio initialization failed:', error.message);
    }
} else {
    console.log('⚠️ Twilio credentials not found, SMS disabled');
}

// Initialize Agent Orchestrator
const orchestrator = new AgentOrchestrator();

// Initialize Prescription Validator
const prescriptionValidator = new PrescriptionValidator();

// Initialize Auto Refill Service with LLM
const autoRefillService = new AutoRefillService();
const chatLLMService = new LLMService();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const prefix = file.fieldname === 'prescription' ? 'prescription' : 'scan';
        cb(null, `${prefix}_${Date.now()}.jpg`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads', { recursive: true });
}

// Test database connection on startup
testConnection();

// ==================== NLP INITIALIZATION ====================
// Load medicines into NLP on startup
async function initializeNLP() {
    try {
        const [medicines] = await pool.query('SELECT medicine_id, name FROM medicines');
        await nlpService.initializeMedicineDatabase(medicines);
        console.log('✅ NLP Service initialized with', medicines.length, 'medicines');
    } catch (error) {
        console.error('❌ Failed to initialize NLP:', error);
    }
}

// Initialize NLP after database connection
setTimeout(() => {
    initializeNLP();
}, 2000); // Give database time to connect

// ==================== AUTO-REFILL INITIALIZATION ====================
// Start auto-refill service (checks every 24 hours by default)
if (process.env.ENABLE_AUTO_REFILL === 'true') {
    const refillInterval = parseInt(process.env.REFILL_CHECK_INTERVAL) || 24;
    
    // Add refill_frequency_days column if it doesn't exist
    (async () => {
        try {
            const [columns] = await pool.query(`
                SELECT COLUMN_NAME 
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_NAME = 'medicines' 
                AND COLUMN_NAME = 'refill_frequency_days'
            `);
            
            if (columns.length === 0) {
                console.log('📋 Adding refill_frequency_days column to medicines table...');
                await pool.query(`
                    ALTER TABLE medicines 
                    ADD COLUMN refill_frequency_days INT DEFAULT 30
                `);
                console.log('✅ refill_frequency_days column added successfully');
            }
        } catch (error) {
            console.error('❌ Failed to add refill_frequency_days column:', error.message);
        }
    })();
    
    // Start the auto-refill service
    autoRefillService.start(refillInterval);
    console.log(`🤖 Auto Refill Service: Active (checks every ${refillInterval} hours)`);
} else {
    console.log('🤖 Auto Refill Service: Disabled (set ENABLE_AUTO_REFILL=true to enable)');
}

// ==================== API ENDPOINTS ====================

function buildMedicineCandidatesForLLM() {
    const source = nlpService?.medicineNames || [];
    return source.map(medicine => {
        const canonical = medicine.original;
        const aliasSet = new Set();

        aliasSet.add(canonical.toLowerCase().trim());

        canonical
            .toLowerCase()
            .split(/[\/|,+]/)
            .map(part => part.trim())
            .filter(part => part.length > 2)
            .forEach(part => aliasSet.add(part));

        const withoutBracketText = canonical
            .toLowerCase()
            .replace(/\([^)]*\)/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (withoutBracketText.length > 2) {
            aliasSet.add(withoutBracketText);
        }

        const withoutDose = canonical
            .toLowerCase()
            .replace(/\b\d+(?:\.\d+)?\s?(?:mg|ml|mcg|g)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (withoutDose.length > 2) {
            aliasSet.add(withoutDose);
        }

        return {
            canonical,
            aliases: Array.from(aliasSet)
        };
    });
}

// Get all medicines from database
app.get('/api/medicines', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM medicines ORDER BY name');
        res.json({
            success: true,
            count: rows.length,
            medicines: rows
        });
    } catch (error) {
        console.error('Error fetching medicines:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Get medicine by ID
app.get('/api/medicines/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM medicines WHERE medicine_id = ?',
            [req.params.id]
        );
        
        if (rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Medicine not found' 
            });
        }
        
        res.json({
            success: true,
            medicine: rows[0]
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update medicine refill frequency
app.put('/api/medicines/:id/refill-frequency', async (req, res) => {
    try {
        const { refill_frequency_days } = req.body;
        
        await pool.query(
            'UPDATE medicines SET refill_frequency_days = ? WHERE medicine_id = ?',
            [refill_frequency_days, req.params.id]
        );
        
        res.json({
            success: true,
            message: 'Refill frequency updated successfully'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== NLP ENDPOINTS ====================

// Spell checking and suggestions endpoint
app.post('/api/spell-check', async (req, res) => {
    try {
        const { text } = req.body;
        
        // Check if the medicine name might be misspelled
        let medicine = nlpService.extractMedicineName(text);

        if (!medicine) {
            const llmMatch = await chatLLMService.matchMedicineFromText({
                message: text,
                candidates: buildMedicineCandidatesForLLM()
            });
            if (llmMatch.matched && llmMatch.medicine) {
                medicine = llmMatch.medicine;
            }
        }
        const suggestions = nlpService.suggestCorrections(text);
        
        res.json({
            original: text,
            detectedMedicine: medicine,
            suggestions: suggestions,
            message: medicine ? 'Medicine detected' : 'No exact match found'
        });
        
    } catch (error) {
        console.error('Spell check error:', error);
        res.status(500).json({ 
            error: error.message,
            suggestions: [] 
        });
    }
});

// NLP endpoint for message processing
app.post('/api/process-message', async (req, res) => {
    try {
        const { message, state, sessionId } = req.body;
        
        // Process message with NLP
        const intent = nlpService.extractIntent(message);
        let action = nlpService.processUserMessage(message, state);

        if (!intent.MEDICINE && (state === 'idle' || state === 'ordering')) {
            const llmMatch = await chatLLMService.matchMedicineFromText({
                message,
                candidates: buildMedicineCandidatesForLLM()
            });

            if (llmMatch.matched && llmMatch.medicine) {
                intent.MEDICINE = llmMatch.medicine;

                if (state === 'idle') {
                    action = {
                        action: 'startOrderWithMedicine',
                        medicine: llmMatch.medicine,
                        quantity: intent.QUANTITY
                    };
                } else if (state === 'ordering') {
                    action = {
                        action: 'setMedicine',
                        medicine: llmMatch.medicine
                    };
                }
            }
        }
        
        res.json({
            ...action,
            intent,
            extractedMedicine: intent.MEDICINE
        });
        
    } catch (error) {
        console.error('NLP processing error:', error);
        res.status(500).json({ 
            action: 'processNormally',
            error: error.message 
        });
    }
});

// LLM chat endpoint for better conversational UX
app.post('/api/chat-assistant', async (req, res) => {
    try {
        const { message, state, userName, medicine } = req.body;

        const response = await chatLLMService.generateChatResponse({
            message,
            state,
            userName,
            medicine
        });

        res.json(response);
    } catch (error) {
        console.error('LLM chat endpoint error:', error);
        res.status(500).json({
            success: false,
            reply: 'I can help you with medicine ordering. Please tell me medicine name to continue.',
            error: error.message
        });
    }
});

// Extract medicine name endpoint
app.post('/api/extract-medicine', async (req, res) => {
    try {
        const { message } = req.body;
        let medicine = nlpService.extractMedicineName(message);

        if (!medicine) {
            const llmMatch = await chatLLMService.matchMedicineFromText({
                message,
                candidates: buildMedicineCandidatesForLLM()
            });

            if (llmMatch.matched && llmMatch.medicine) {
                medicine = llmMatch.medicine;
            }
        }
        
        res.json({ 
            success: !!medicine,
            medicine: medicine || null,
            message: medicine ? 'Medicine extracted' : 'No medicine found'
        });
        
    } catch (error) {
        console.error('Medicine extraction error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Check stock endpoint - WITH PRESCRIPTION INFO
app.post('/api/check-stock', async (req, res) => {
    const { medicine } = req.body;
    
    try {
        const [rows] = await pool.query(
            `SELECT * FROM medicines 
             WHERE LOWER(name) LIKE ? OR LOWER(name) = ?`,
            [`%${medicine.toLowerCase()}%`, medicine.toLowerCase()]
        );
        
        if (rows.length === 0) {
            return res.json({
                available: false,
                message: 'Medicine not found in database'
            });
        }
        
        const med = rows[0];
        res.json({
            available: med.stock > 0,
            medicineId: med.medicine_id,
            name: med.name,
            price: med.selling_price,
            stock: med.stock,
            manufacturer: med.manufacturer,
            expiry: med.expiry_date,
            category: med.category,
            prescriptionRequired: med.prescription_req === 1 || med.prescription_req === true,
            refillFrequencyDays: med.refill_frequency_days || 30
        });
        
    } catch (error) {
        res.status(500).json({ 
            available: false, 
            error: error.message 
        });
    }
});

// Scan medicine endpoint
app.post('/api/scan-medicine', upload.single('image'), async (req, res) => {
    let imagePath = null;
    
    try {
        // Handle different input types
        if (req.file) {
            imagePath = req.file.path;
            console.log('📸 Processing scan:', req.file.filename);
        } else if (req.body && req.body.image) {
            const base64Data = req.body.image.replace(/^data:image\/\w+;base64,/, '');
            imagePath = `uploads/scan_${Date.now()}.jpg`;
            fs.writeFileSync(imagePath, base64Data, 'base64');
        } else {
            return res.status(400).json({ error: 'No image provided' });
        }

        // Perform OCR
        console.log('🔍 Running OCR...');
        const { data: { text } } = await Tesseract.recognize(
            imagePath,
            'eng',
            {
                tessedit_pageseg_mode: '6',
                preserve_interword_spaces: '1',
                user_defined_dpi: '300',
                logger: m => {
                    if (m.status === 'recognizing text') {
                        console.log(`OCR Progress: ${Math.round(m.progress * 100)}%`);
                    }
                }
            }
        );

        // Clean up temp file
        try { fs.unlinkSync(imagePath); } catch (e) {}

        // Extract medicine name from OCR text
        const extractedText = text.toLowerCase();
        const normalizedText = extractedText
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        console.log('📝 Extracted text:', extractedText.substring(0, 200));

        // Detect medicine using NLP first (fast and accurate with fuzzy/spell correction)
        let detectedMedicine = null;

        const nlpDetectedName = nlpService.extractMedicineName(normalizedText);
        if (nlpDetectedName) {
            const [rows] = await pool.query(
                `SELECT * FROM medicines 
                 WHERE LOWER(name) = LOWER(?)
                 LIMIT 1`,
                [nlpDetectedName]
            );

            if (rows.length > 0) {
                detectedMedicine = rows[0];
            }
        }

        // Fallback: use top OCR tokens in a single DB query (efficient)
        if (!detectedMedicine) {
            const tokens = [...new Set(normalizedText.split(/\s+/).filter(t => t.length >= 4))].slice(0, 8);
            
            if (tokens.length > 0) {
                const whereClause = tokens.map(() => 'LOWER(name) LIKE ?').join(' OR ');
                const params = tokens.map(token => `%${token}%`);

                const [rows] = await pool.query(
                    `SELECT * FROM medicines
                     WHERE ${whereClause}
                     ORDER BY CASE WHEN stock > 0 THEN 0 ELSE 1 END, selling_price ASC
                     LIMIT 1`,
                    params
                );

                if (rows.length > 0) {
                    detectedMedicine = rows[0];
                }
            }
        }

        if (detectedMedicine) {
            res.json({
                success: true,
                medicine: detectedMedicine.name,
                details: {
                    name: detectedMedicine.name,
                    available: detectedMedicine.stock > 0,
                    price: detectedMedicine.selling_price,
                    stock: detectedMedicine.stock,
                    manufacturer: detectedMedicine.manufacturer,
                    composition: detectedMedicine.category,
                    expiry: detectedMedicine.expiry_date,
                    prescriptionRequired: detectedMedicine.prescription_req === 1 || detectedMedicine.prescription_req === true,
                    refillFrequencyDays: detectedMedicine.refill_frequency_days || 30
                },
                extractedText: extractedText.substring(0, 100),
                ocr: {
                    normalizedText: normalizedText.substring(0, 120),
                    detectionMode: nlpDetectedName ? 'nlp-fuzzy' : 'token-fallback'
                }
            });
        } else {
            res.json({
                success: false,
                message: 'No medicine detected. Please try again with clearer image and good lighting.'
            });
        }

    } catch (error) {
        console.error('Scan error:', error);
        if (imagePath && fs.existsSync(imagePath)) {
            try { fs.unlinkSync(imagePath); } catch (e) {}
        }
        res.status(500).json({ error: error.message });
    }
});

// Validate prescription endpoint
app.post('/api/validate-prescription', upload.single('prescription'), async (req, res) => {
    let imagePath = null;
    
    try {
        if (req.file) {
            imagePath = req.file.path;
            console.log('📄 Processing prescription:', req.file.filename);
        } else if (req.body && req.body.image) {
            const base64Data = req.body.image.replace(/^data:image\/\w+;base64,/, '');
            imagePath = `uploads/prescription_${Date.now()}.jpg`;
            fs.writeFileSync(imagePath, base64Data, 'base64');
        } else {
            return res.status(400).json({ error: 'No prescription image provided' });
        }

        // Validate prescription
        const validationResult = await prescriptionValidator.validatePrescription(imagePath, req.body.medicineName);

        // Clean up temp file
        try { fs.unlinkSync(imagePath); } catch (e) {}

        res.json(validationResult);

    } catch (error) {
        console.error('Prescription validation error:', error);
        if (imagePath && fs.existsSync(imagePath)) {
            try { fs.unlinkSync(imagePath); } catch (e) {}
        }
        res.status(500).json({ 
            valid: false, 
            error: error.message,
            message: 'Error validating prescription'
        });
    }
});

// Helper function to ensure orders table exists
async function ensureOrdersTable() {
    try {
        const [tables] = await pool.query("SHOW TABLES LIKE 'orders'");
        
        if (tables.length === 0) {
            console.log('📊 Creating orders table on demand...');
            await pool.query(`
                CREATE TABLE orders (
                    order_id VARCHAR(50) PRIMARY KEY,
                    medicine_name VARCHAR(255) NOT NULL,
                    quantity INT NOT NULL,
                    price DECIMAL(10,2) NOT NULL,
                    total_amount DECIMAL(10,2) NOT NULL,
                    user_name VARCHAR(255) NOT NULL,
                    phone VARCHAR(20) NOT NULL,
                    address TEXT NOT NULL,
                    status VARCHAR(20) DEFAULT 'pending',
                    payment_status VARCHAR(20) DEFAULT 'pending',
                    prescription_verified BOOLEAN DEFAULT FALSE,
                    prescription_path VARCHAR(255),
                    agent_chain TEXT,
                    trace_id VARCHAR(100),
                    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ Orders table created successfully');
        }
    } catch (error) {
        console.error('❌ Failed to ensure orders table:', error.message);
    }
}

// Process order through agent system - WITH PRESCRIPTION HANDLING
app.post('/api/create-order', async (req, res) => {
    try {
        const orderData = req.body;
        const sessionId = req.headers['x-session-id'];
        const paymentMethod = (orderData.paymentMethod || 'UPI').toUpperCase();
        const paymentStatus = paymentMethod === 'COD' ? 'pending' : 'completed';
        
        console.log('📦 Processing order:', orderData);
        
        // Check if prescription is required and validated
        if (orderData.prescriptionRequired && !orderData.prescriptionValidated) {
            return res.status(400).json({
                success: false,
                message: 'Prescription validation required for this medicine',
                prescriptionRequired: true
            });
        }
        
        // Process through agent orchestrator
        const result = await orchestrator.processOrder(orderData, sessionId);
        
        if (result.success) {
            // Save order to database with better error handling
            try {
                // Check if orders table exists and create if needed
                await ensureOrdersTable();
                
                // Insert order
                await pool.query(
                    `INSERT INTO orders 
                     (order_id, medicine_name, quantity, price, total_amount, 
                      user_name, phone, address, status, payment_status, 
                      prescription_verified, agent_chain, trace_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        result.orderId,
                        result.medicine,
                        result.quantity,
                        orderData.price,
                        result.totalAmount,
                        orderData.userName,
                        orderData.phone,
                        orderData.address,
                        'approved',
                        paymentStatus,
                        orderData.prescriptionValidated || false,
                        JSON.stringify(result.chainOfThought || []),
                        result.traceId
                    ]
                );
                
                console.log('✅ Order saved to database:', result.orderId);
            } catch (dbError) {
                console.error('❌ Database error saving order:', dbError.message);
                // Continue even if DB save fails - order is still processed
            }
            
            // Send SMS confirmation if Twilio is configured
            if (twilioClient) {
                try {
                    // Create a concise SMS message (trial accounts have length limits)
                    let smsMessage = `PharmacyAI Order: ${result.orderId}\n`;
                    smsMessage += `${result.medicine} x${result.quantity} = ₹${result.totalAmount}\n`;
                    smsMessage += `Payment: ${paymentMethod}\n`;
                    if (orderData.prescriptionValidated) {
                        smsMessage += `Prescription: Verified\n`;
                    }
                    smsMessage += `Thank you!`;
                    
                    // Try to send SMS but don't fail the order if it doesn't work
                    await sendOrderConfirmationSMS(orderData.phone, smsMessage).catch(err => {
                        console.error('SMS sending failed but order was created:', err.message);
                    });
                    
                } catch (smsError) {
                    console.error('SMS sending error:', smsError);
                    // Don't fail the order - just log the error
                }
            } else {
                console.log('📱 SMS not sent - Twilio not configured');
            }
            
            // Update inventory
            try {
                await pool.query(
                    `UPDATE medicines 
                     SET stock = stock - ? 
                     WHERE LOWER(name) = ?`,
                    [result.quantity, result.medicine.toLowerCase()]
                );
                console.log('✅ Inventory updated');
            } catch (invError) {
                console.error('❌ Inventory update failed:', invError.message);
            }
        }
        
        // Include trace URL for observability
        const traceUrl = getTraceUrl(result.traceId);
        
        res.json({
            ...result,
            paymentMethod,
            paymentStatus,
            traceUrl
        });
        
    } catch (error) {
        console.error('❌ Order creation error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            message: 'Failed to create order. Please try again.'
        });
    }
});

// Send SMS function - MODIFIED for Twilio trial account
async function sendOrderConfirmationSMS(phone, message) {
    try {
        // Check if Twilio client is initialized
        if (!twilioClient) {
            console.log('📱 SMS not sent - Twilio not configured');
            return;
        }

        // Format phone number (add + if not present)
        let formattedPhone = phone;
        if (!formattedPhone.startsWith('+')) {
            // Assume Indian numbers if not specified
            if (formattedPhone.length === 10) {
                formattedPhone = `+91${formattedPhone}`;
            } else {
                formattedPhone = `+${formattedPhone}`;
            }
        }
        
        console.log(`📱 Attempting to send SMS to ${formattedPhone}`);
        
        // Truncate message if too long (Twilio trial accounts have limits)
        const maxLength = 160; // Standard SMS length
        let finalMessage = message;
        if (message.length > maxLength) {
            finalMessage = message.substring(0, maxLength - 20) + '... Order confirmed';
            console.log(`📱 Message truncated from ${message.length} to ${finalMessage.length} chars`);
        }
        
        // Check if this is a verified number (for trial accounts)
        const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
        if (!twilioPhoneNumber) {
            console.error('❌ TWILIO_PHONE_NUMBER not set in .env');
            return;
        }
        
        // For trial accounts, you need to add the recipient number in Twilio console
        console.log(`📱 Sending from: ${twilioPhoneNumber} to: ${formattedPhone}`);
        
        const smsMessage = await twilioClient.messages.create({
            body: finalMessage,
            from: twilioPhoneNumber,
            to: formattedPhone
        });
        
        console.log(`✅ SMS sent successfully to ${formattedPhone}: ${smsMessage.sid}`);
        return smsMessage;
        
    } catch (error) {
        // Handle specific Twilio errors
        if (error.code === 21608) {
            console.error('❌ Twilio trial account error: The phone number is not verified.');
            console.error('   Add this number in your Twilio console: https://console.twilio.com');
        } else if (error.code === 21408) {
            console.error('❌ Twilio error: Message length exceeded trial limit.');
        } else if (error.code === 21211) {
            console.error('❌ Twilio error: Invalid phone number format.');
        } else {
            console.error('❌ Twilio error:', error.message);
        }
        throw error; // Re-throw for handling in the calling function
    }
}

// Get order trace (for observability)
app.get('/api/order-trace/:orderId', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM orders WHERE order_id = ?',
            [req.params.orderId]
        );
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = rows[0];
        const trace = {
            orderId: order.order_id,
            status: order.status,
            paymentStatus: order.payment_status,
            prescriptionVerified: order.prescription_verified,
            agentChain: JSON.parse(order.agent_chain || '[]'),
            traceId: order.trace_id,
            traceUrl: getTraceUrl(order.trace_id)
        };
        
        res.json(trace);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get sales report
app.get('/api/sales-report', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                s.sale_id,
                s.quantity,
                s.sale_date,
                m.name as medicine_name,
                m.selling_price,
                (s.quantity * m.selling_price) as total_amount
            FROM sales s
            JOIN medicines m ON s.medicine_id = m.medicine_id
            ORDER BY s.sale_date DESC
            LIMIT 100
        `);
        
        res.json({
            success: true,
            count: rows.length,
            sales: rows
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create orders table manually endpoint (for debugging)
app.get('/api/create-orders-table', async (req, res) => {
    try {
        await ensureOrdersTable();
        
        res.json({ 
            success: true, 
            message: 'Orders table created successfully' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ==================== AUTO-REFILL ENDPOINTS ====================

// Manually trigger refill check (admin only - you should add auth in production)
app.post('/api/admin/trigger-refill-check', async (req, res) => {
    try {
        await autoRefillService.checkAndSendRefillReminders();
        res.json({
            success: true,
            message: 'Refill check triggered successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get refill reminders statistics
app.get('/api/refill-stats', async (req, res) => {
    try {
        const stats = await autoRefillService.getRefillStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Analyze customer purchase patterns using LLM
app.post('/api/analyze-customer/:phone', async (req, res) => {
    try {
        const analysis = await autoRefillService.analyzeCustomerPatterns(req.params.phone);
        res.json(analysis);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get all refill reminders for a customer
app.get('/api/customer-refills/:phone', async (req, res) => {
    try {
        const [reminders] = await pool.query(`
            SELECT * FROM refill_reminders 
            WHERE phone = ? 
            ORDER BY sent_at DESC
        `, [req.params.phone]);
        
        res.json({
            success: true,
            count: reminders.length,
            reminders: reminders
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Mark refill as responded
app.post('/api/refill-responded/:id', async (req, res) => {
    try {
        await pool.query(`
            UPDATE refill_reminders 
            SET responded = TRUE 
            WHERE id = ?
        `, [req.params.id]);
        
        res.json({
            success: true,
            message: 'Refill marked as responded'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get upcoming refills for a customer (predictive using LLM)
app.get('/api/upcoming-refills/:phone', async (req, res) => {
    try {
        const [orders] = await pool.query(`
            SELECT 
                medicine_name,
                MAX(created_at) as last_purchase,
                COUNT(*) as purchase_count,
                AVG(quantity) as avg_quantity
            FROM orders 
            WHERE phone = ? AND status = 'approved'
            GROUP BY medicine_name
            HAVING purchase_count >= 2
        `, [req.params.phone]);

        if (orders.length === 0) {
            return res.json({
                success: true,
                message: 'No regular purchase patterns found',
                upcomingRefills: []
            });
        }

        const upcomingRefills = [];
        
        for (const order of orders) {
            const [medicine] = await pool.query(
                'SELECT refill_frequency_days FROM medicines WHERE LOWER(name) = LOWER(?)',
                [order.medicine_name]
            );
            
            const refillFrequency = medicine[0]?.refill_frequency_days || 30;
            const lastPurchase = new Date(order.last_purchase);
            const nextRefillDate = new Date(lastPurchase);
            nextRefillDate.setDate(nextRefillDate.getDate() + refillFrequency);
            
            const today = new Date();
            const daysUntilRefill = Math.ceil((nextRefillDate - today) / (1000 * 60 * 60 * 24));
            
            if (daysUntilRefill <= 7) { // Show refills needed in next 7 days
                upcomingRefills.push({
                    medicineName: order.medicine_name,
                    lastPurchase: order.last_purchase,
                    nextRefillDate: nextRefillDate.toISOString().split('T')[0],
                    daysUntilRefill,
                    estimatedQuantity: Math.round(order.avg_quantity),
                    confidence: order.purchase_count >= 3 ? 'High' : 'Medium'
                });
            }
        }

        // Use LLM to generate personalized insights if available
        let insights = null;
        if (upcomingRefills.length > 0) {
            const llmInsights = await autoRefillService.llmService.generateRefillReminder({
                customerName: req.query.name || 'Customer',
                medicineName: upcomingRefills[0].medicineName,
                daysUntilRefill: upcomingRefills[0].daysUntilRefill,
                phone: req.params.phone
            }).catch(() => null);
            
            if (llmInsights?.success) {
                insights = llmInsights.message;
            }
        }

        res.json({
            success: true,
            customer: req.params.phone,
            upcomingRefills,
            insights,
            totalRegularMedicines: orders.length
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Toggle auto-refill service
app.post('/api/admin/toggle-refill-service', async (req, res) => {
    try {
        const { enable } = req.body;
        
        if (enable) {
            if (!autoRefillService.isRunning) {
                const interval = parseInt(process.env.REFILL_CHECK_INTERVAL) || 24;
                autoRefillService.start(interval);
                res.json({ success: true, message: 'Auto-refill service started' });
            } else {
                res.json({ success: true, message: 'Auto-refill service already running' });
            }
        } else {
            if (autoRefillService.isRunning) {
                autoRefillService.stop();
                res.json({ success: true, message: 'Auto-refill service stopped' });
            } else {
                res.json({ success: true, message: 'Auto-refill service already stopped' });
            }
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check - UPDATED with NLP and Auto-Refill status
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        
        // Check if orders table exists
        const [tables] = await pool.query("SHOW TABLES LIKE 'orders'");
        
        // Check if refill_reminders table exists
        const [refillTables] = await pool.query("SHOW TABLES LIKE 'refill_reminders'");
        
        res.json({ 
            status: 'healthy',
            database: 'connected',
            nlp: nlpService && nlpService.medicineNames ? 'loaded' : 'initializing',
            medicinesCount: nlpService?.medicineNames?.length || 0,
            ordersTable: tables.length > 0 ? 'exists' : 'missing',
            refillRemindersTable: refillTables.length > 0 ? 'exists' : 'missing',
            twilio: twilioClient ? 'configured' : 'not configured',
            autoRefill: {
                enabled: process.env.ENABLE_AUTO_REFILL === 'true',
                running: autoRefillService.isRunning || false,
                llmEnabled: autoRefillService.llmService?.openai ? true : false
            },
            prescriptionValidator: 'active',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy',
            database: 'disconnected',
            error: error.message
        });
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(60));
    console.log(`🚀 Pharmacy AI Agentic System`);
    console.log('='.repeat(60));
    console.log(`📱 Server: http://localhost:${PORT}`);
    console.log(`💊 Database: ${process.env.DB_HOST || 'localhost'}/${process.env.DB_NAME || 'pharmacy_db'}`);
    console.log(`🤖 Multi-Agent System: Active`);
    console.log(`📋 Prescription Validation: Active`);
    console.log(`🔤 NLP Spell Check: Active`);
    console.log(`🤖 LLM Auto-Refill: ${process.env.ENABLE_AUTO_REFILL === 'true' ? 'Active' : 'Disabled'}`);
    console.log(`   ├─ LLM Provider: ${autoRefillService.llmService?.openai ? 'OpenAI' : 'Template Fallback'}`);
    console.log(`   └─ Check Interval: ${process.env.REFILL_CHECK_INTERVAL || 24} hours`);
    console.log(`📊 Observability: ${process.env.LANGFUSE_PUBLIC_KEY ? 'Langfuse' : 'Mock Mode'}`);
    console.log(`📱 SMS: ${twilioClient ? 'Enabled' : 'Disabled'}`);
    console.log('='.repeat(60) + '\n');
    
    // Don't create table here - it will be created on demand
    console.log('📊 Orders table will be created on first order if needed');
    console.log('📊 Refill reminders table will be created on first reminder if needed');
    
    // Show LLM status
    if (process.env.ENABLE_AUTO_REFILL === 'true' && !autoRefillService.llmService?.openai) {
        console.log('⚠️  Warning: OPENAI_API_KEY not set. Using template fallback for reminders.');
    }
});
// ==================== CUSTOMER-SPECIFIC REFILL ENDPOINTS ====================

// Get personalized refill schedule for a customer
app.get('/api/customer/:phone/refill-schedule', async (req, res) => {
    try {
        const schedule = await autoRefillService.getCustomerRefillSchedule(req.params.phone);
        res.json(schedule);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get detailed customer purchase patterns
app.get('/api/customer/:phone/patterns', async (req, res) => {
    try {
        const patterns = await autoRefillService.analyzeCustomerPatterns(req.params.phone);
        res.json(patterns);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Mark refill as responded (when customer orders)
app.post('/api/refill/:id/respond', async (req, res) => {
    try {
        const result = await autoRefillService.markRefillResponded(
            req.params.id, 
            req.body.responseData
        );
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get all refill reminders for a customer with details
app.get('/api/customer/:phone/refill-history', async (req, res) => {
    try {
        const [reminders] = await pool.query(`
            SELECT 
                r.*,
                o.order_id as subsequent_order_id,
                o.created_at as order_date
            FROM refill_reminders r
            LEFT JOIN orders o ON o.phone = r.phone 
                AND o.medicine_name = r.medicine_name 
                AND o.created_at > r.sent_at
            WHERE r.phone = ? 
            ORDER BY r.sent_at DESC
        `, [req.params.phone]);
        
        res.json({
            success: true,
            count: reminders.length,
            reminders: reminders
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Manually add a customer refill pattern (for new customers)
app.post('/api/customer/refill-pattern', async (req, res) => {
    try {
        const { phone, medicineName, customInterval } = req.body;
        
        // Store custom pattern in a new table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS customer_refill_preferences (
                id INT AUTO_INCREMENT PRIMARY KEY,
                phone VARCHAR(20) NOT NULL,
                medicine_name VARCHAR(255) NOT NULL,
                preferred_interval_days INT,
                preferred_quantity INT,
                last_reminder_sent TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_customer_medicine (phone, medicine_name)
            )
        `);
        
        await pool.query(`
            INSERT INTO customer_refill_preferences 
            (phone, medicine_name, preferred_interval_days, preferred_quantity)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            preferred_interval_days = VALUES(preferred_interval_days),
            preferred_quantity = VALUES(preferred_quantity),
            updated_at = NOW()
        `, [phone, medicineName, customInterval, req.body.preferredQuantity || 1]);
        
        res.json({
            success: true,
            message: 'Customer refill preference saved'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get upcoming refills for all customers (admin view)
app.get('/api/admin/upcoming-refills', async (req, res) => {
    try {
        const [upcoming] = await pool.query(`
            SELECT 
                phone,
                user_name,
                medicine_name,
                MAX(created_at) as last_purchase,
                COUNT(*) as purchase_count,
                AVG(quantity) as avg_quantity,
                DATEDIFF(NOW(), MAX(created_at)) as days_since_purchase
            FROM orders 
            WHERE status = 'approved'
            GROUP BY phone, medicine_name
            HAVING purchase_count >= 2
            ORDER BY days_since_purchase DESC
            LIMIT 50
        `);
        
        const refillCandidates = [];
        
        for (const order of upcoming) {
            // Calculate personalized interval
            const [intervals] = await pool.query(`
                SELECT 
                    DATEDIFF(o2.created_at, o1.created_at) as interval_days
                FROM orders o1
                JOIN orders o2 ON o1.phone = o2.phone 
                    AND o1.medicine_name = o2.medicine_name
                    AND o2.created_at > o1.created_at
                WHERE o1.phone = ? 
                    AND o1.medicine_name = ?
                    AND o1.status = 'approved'
                    AND o2.status = 'approved'
                ORDER BY o1.created_at
            `, [order.phone, order.medicine_name]);
            
            const avgInterval = intervals.length > 0 
                ? Math.round(intervals.reduce((sum, i) => sum + i.interval_days, 0) / intervals.length)
                : 30; // Default
            
            const daysUntilRefill = avgInterval - order.days_since_purchase;
            
            refillCandidates.push({
                ...order,
                avgInterval,
                daysUntilRefill,
                needsRefill: daysUntilRefill <= 2
            });
        }
        
        res.json({
            success: true,
            total: refillCandidates.length,
            needsRefill: refillCandidates.filter(r => r.needsRefill).length,
            candidates: refillCandidates
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== SMS STATUS CALLBACK ====================
app.post('/api/sms-status', (req, res) => {
    console.log('📱 SMS Status Update:', req.body);
    // You can log this to database if needed
    res.sendStatus(200);
});

// ==================== TEST SMS ENDPOINT ====================
app.post('/api/test-refill-sms', async (req, res) => {
    try {
        const { phone, medicineName, customerName } = req.body;
        
        // Create test customer data
        const testCustomer = {
            customerName: customerName || 'Test User',
            phone: phone,
            medicineName: medicineName || 'Paracetamol 500mg',
            lastPurchaseDate: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000), // 25 days ago
            daysSinceLastPurchase: 25,
            daysUntilRefill: -5, // Overdue
            avgRefillInterval: 30,
            totalPurchases: 3,
            lastQuantity: 10,
            confidence: 'High'
        };

        // Generate and send SMS
        const reminderData = await autoRefillService.llmService.generateRefillReminder({
            customerName: testCustomer.customerName,
            medicineName: testCustomer.medicineName,
            daysUntilRefill: testCustomer.daysUntilRefill,
            lastPurchaseDate: testCustomer.lastPurchaseDate,
            phone: testCustomer.phone,
            avgRefillInterval: testCustomer.avgRefillInterval,
            totalPurchases: testCustomer.totalPurchases,
            lastQuantity: testCustomer.lastQuantity,
            confidence: testCustomer.confidence
        });

        if (reminderData.success) {
            const smsResult = await autoRefillService.sendRefillSMS(reminderData, testCustomer);
            
            res.json({
                success: smsResult.success,
                message: smsResult.success ? 'SMS sent successfully!' : 'SMS failed',
                details: {
                    to: phone,
                    message: reminderData.message,
                    smsSid: smsResult.sid,
                    error: smsResult.error
                }
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to generate reminder'
            });
        }

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});