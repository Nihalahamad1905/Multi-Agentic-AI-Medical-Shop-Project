const { pool } = require('../config/database');

class InventoryAgent {
    constructor() {
        this.name = 'InventoryAgent';
    }
    
    async checkStock(medicineName) {
        try {
            // Search in medicines table
            const [rows] = await pool.query(
                `SELECT * FROM medicines WHERE LOWER(name) LIKE ? OR LOWER(name) = ?`,
                [`%${medicineName}%`, medicineName]
            );
            
            if (rows.length === 0) {
                return {
                    found: false,
                    message: 'Medicine not found in database',
                    agent: this.name
                };
            }
            
            const medicine = rows[0];
            
            return {
                found: true,
                medicineId: medicine.medicine_id,
                name: medicine.name,
                stock: medicine.stock,
                price: medicine.selling_price,
                costPrice: medicine.cost_price,
                manufacturer: medicine.manufacturer,
                expiryDate: medicine.expiry_date,
                category: medicine.category,
                prescriptionRequired: medicine.prescription_req === 1 || medicine.prescription_req === true,
                agent: this.name
            };
            
        } catch (error) {
            console.error('InventoryAgent error:', error);
            return {
                found: false,
                message: 'Database error: ' + error.message,
                agent: this.name
            };
        }
    }
    
    makeDecision(inventory, requestedQuantity, prescriptionValidated = false) {
        if (!inventory.found) {
            return {
                approved: false,
                message: `❌ ${inventory.message}`,
                agent: this.name
            };
        }
        
        if (inventory.stock < requestedQuantity) {
            return {
                approved: false,
                message: `❌ Insufficient stock. Available: ${inventory.stock}, Requested: ${requestedQuantity}`,
                available: inventory.stock,
                requested: requestedQuantity,
                agent: this.name
            };
        }
        
        // Check if prescription is required and validated
        if (inventory.prescriptionRequired) {
            if (!prescriptionValidated) {
                return {
                    approved: false,
                    message: `❌ Prescription required for ${inventory.name}. Please upload a valid prescription.`,
                    prescriptionRequired: true,
                    prescriptionValidated: false,
                    agent: this.name
                };
            } else {
                console.log(`✅ Prescription validated for ${inventory.name}`);
            }
        }
        
        // Check expiry
        const expiryDate = new Date(inventory.expiryDate);
        const today = new Date();
        const daysUntilExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
        
        if (daysUntilExpiry < 30) {
            return {
                approved: false,
                message: `❌ Medicine expires in ${daysUntilExpiry} days. Cannot fulfill order.`,
                daysUntilExpiry,
                agent: this.name
            };
        }
        
        let message = `✅ Stock available: ${inventory.stock} units. Price: ₹${inventory.price} per unit`;
        if (inventory.prescriptionRequired) {
            message += `\n📋 Prescription verified`;
        }
        
        return {
            approved: true,
            message: message,
            available: inventory.stock,
            price: inventory.price,
            medicineId: inventory.medicineId,
            prescriptionRequired: inventory.prescriptionRequired,
            prescriptionValidated: prescriptionValidated,
            agent: this.name
        };
    }
}

module.exports = InventoryAgent;