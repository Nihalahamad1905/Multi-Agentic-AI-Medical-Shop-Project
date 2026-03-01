const { v4: uuidv4 } = require('uuid');

class OrderAgent {
    constructor() {
        this.name = 'OrderAgent';
    }
    
    async process(orderData) {
        // Validate order data
        const validation = this.validateOrder(orderData);
        
        if (!validation.valid) {
            return {
                valid: false,
                message: validation.message,
                agent: this.name
            };
        }
        
        // Calculate total amount
        const totalAmount = orderData.price * orderData.quantity;
        
        // Generate order ID
        const orderId = `ORD_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        
        return {
            valid: true,
            orderId,
            medicine: orderData.medicine.toLowerCase(),
            quantity: parseInt(orderData.quantity),
            price: parseFloat(orderData.price),
            totalAmount,
            userName: orderData.userName,
            phone: orderData.phone,
            address: orderData.address,
            agent: this.name,
            timestamp: new Date().toISOString()
        };
    }
    
    validateOrder(order) {
        if (!order.medicine) {
            return { valid: false, message: 'Medicine name is required' };
        }
        if (!order.quantity || order.quantity <= 0) {
            return { valid: false, message: 'Valid quantity is required' };
        }
        if (!order.userName || order.userName.trim() === '') {
            return { valid: false, message: 'Name is required' };
        }
        if (!order.phone || order.phone.trim() === '') {
            return { valid: false, message: 'Phone number is required' };
        }
        if (!order.address || order.address.trim() === '') {
            return { valid: false, message: 'Delivery address is required' };
        }
        
        return { valid: true };
    }
}

module.exports = OrderAgent;