const mysql = require('mysql2');
require('dotenv').config();

// Create connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'pharmacy_db',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Promisify for async/await
const promisePool = pool.promise();

// Test connection
const testConnection = async () => {
    try {
        const [rows] = await promisePool.query('SELECT 1 + 1 AS result');
        console.log('✅ Database connected successfully');
        
        // Check if prescription_req column exists, add if not
        await ensurePrescriptionColumn();
        
        // Create orders table if it doesn't exist
        await createOrdersTable();
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
};

// Ensure prescription_req column exists
const ensurePrescriptionColumn = async () => {
    try {
        // Check if medicines table exists
        const [tables] = await promisePool.query("SHOW TABLES LIKE 'medicines'");
        if (tables.length === 0) {
            console.log('⚠️ Medicines table not found. Please create it first.');
            return;
        }

        // Check if column exists
        const [columns] = await promisePool.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'medicines' 
            AND COLUMN_NAME = 'prescription_req'
        `);
        
        if (columns.length === 0) {
            console.log('📋 Adding prescription_req column to medicines table...');
            await promisePool.query(`
                ALTER TABLE medicines 
                ADD COLUMN prescription_req BOOLEAN DEFAULT FALSE
            `);
            console.log('✅ prescription_req column added successfully');
            
            // Set default values for existing medicines
            await promisePool.query(`
                UPDATE medicines 
                SET prescription_req = TRUE 
                WHERE category IN ('Antibiotics', 'Antidepressants', 'Antipsychotics', 'Opioids', 'Sedatives', 'Hormones')
            `);
            console.log('📊 Default prescription requirements set');
        }
    } catch (error) {
        console.error('❌ Failed to ensure prescription_req column:', error.message);
    }
};

// Create orders table for tracking - FIXED for MySQL compatibility
const createOrdersTable = async () => {
    try {
        // First check if table exists
        const [tables] = await promisePool.query("SHOW TABLES LIKE 'orders'");
        
        if (tables.length === 0) {
            console.log('📊 Creating orders table...');
            
            // MySQL 5.5+ compatible version - using TIMESTAMP with separate DEFAULT and ON UPDATE
            await promisePool.query(`
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
        } else {
            console.log('✅ Orders table already exists');
            
            // Check if prescription_verified column exists (for existing tables)
            try {
                const [columns] = await promisePool.query(`
                    SELECT COLUMN_NAME 
                    FROM INFORMATION_SCHEMA.COLUMNS 
                    WHERE TABLE_NAME = 'orders' 
                    AND COLUMN_NAME = 'prescription_verified'
                `);
                
                if (columns.length === 0) {
                    console.log('📋 Adding prescription_verified column to orders table...');
                    await promisePool.query(`
                        ALTER TABLE orders 
                        ADD COLUMN prescription_verified BOOLEAN DEFAULT FALSE,
                        ADD COLUMN prescription_path VARCHAR(255) AFTER prescription_verified
                    `);
                    console.log('✅ prescription_verified column added');
                }
            } catch (alterError) {
                console.error('❌ Failed to alter orders table:', alterError.message);
            }
        }
    } catch (error) {
        console.error('❌ Failed to create/verify orders table:', error.message);
        
        // Try alternative syntax for very old MySQL versions
        try {
            console.log('🔄 Trying alternative table creation syntax...');
            await promisePool.query(`
                CREATE TABLE IF NOT EXISTS orders (
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
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ Orders table created with DATETIME instead of TIMESTAMP');
        } catch (altError) {
            console.error('❌ Alternative creation also failed:', altError.message);
        }
    }
};

module.exports = {
    pool: promisePool,
    testConnection
};