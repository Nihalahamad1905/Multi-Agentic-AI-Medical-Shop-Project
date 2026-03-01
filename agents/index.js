const { createTrace, createSpan, endSpan, getTraceUrl } = require('../config/observability');
const OrderAgent = require('./orderAgent');
const InventoryAgent = require('./inventoryAgent');
const PaymentAgent = require('./paymentAgent');
const { v4: uuidv4 } = require('uuid');

class AgentOrchestrator {
    constructor() {
        this.orderAgent = new OrderAgent();
        this.inventoryAgent = new InventoryAgent();
        this.paymentAgent = new PaymentAgent();
        this.sessions = new Map();
    }

    // Process order through multi-agent system
    async processOrder(orderData, sessionId = null) {
        const startTime = Date.now();
        
        // Create or get session
        if (!sessionId) {
            sessionId = `session_${uuidv4()}`;
        }
        
        // Create trace for observability
        const trace = await createTrace(sessionId, orderData.userName || 'anonymous');
        
        // Chain of Thought log
        const chainOfThought = [];
        
        try {
            // Step 1: Order Agent validates and processes initial order
            const orderSpan = createSpan(trace, 'order_agent_validation', orderData);
            const orderResult = await this.orderAgent.process(orderData);
            chainOfThought.push({
                agent: 'OrderAgent',
                action: 'validate_order',
                input: orderData,
                output: orderResult,
                timestamp: new Date().toISOString()
            });
            endSpan(orderSpan, orderResult);
            
            if (!orderResult.valid) {
                return {
                    success: false,
                    message: orderResult.message,
                    chainOfThought,
                    traceId: trace.id,
                    sessionId
                };
            }
            
            // Step 2: Inventory Agent checks stock with prescription validation status
            const inventorySpan = createSpan(trace, 'inventory_agent_check', orderResult);
            const inventoryResult = await this.inventoryAgent.checkStock(orderResult.medicine);
            chainOfThought.push({
                agent: 'InventoryAgent',
                action: 'check_stock',
                input: orderResult.medicine,
                output: inventoryResult,
                timestamp: new Date().toISOString()
            });
            endSpan(inventorySpan, inventoryResult);
            
            // Inventory Agent decision - PASS PRESCRIPTION VALIDATION STATUS
            const prescriptionValidated = orderData.prescriptionValidated || false;
            const inventoryDecision = this.inventoryAgent.makeDecision(inventoryResult, orderResult.quantity, prescriptionValidated);
            chainOfThought.push({
                agent: 'InventoryAgent',
                action: 'make_decision',
                input: { 
                    inventory: inventoryResult, 
                    requestedQuantity: orderResult.quantity,
                    prescriptionValidated: prescriptionValidated 
                },
                output: inventoryDecision,
                timestamp: new Date().toISOString()
            });
            
            if (!inventoryDecision.approved) {
                return {
                    success: false,
                    message: inventoryDecision.message,
                    chainOfThought,
                    traceId: trace.id,
                    sessionId
                };
            }
            
            // Step 3: Payment Agent handles payment
            const paymentSpan = createSpan(trace, 'payment_agent_process', orderResult);
            const paymentResult = await this.paymentAgent.processPayment(orderResult);
            chainOfThought.push({
                agent: 'PaymentAgent',
                action: 'process_payment',
                input: orderResult,
                output: paymentResult,
                timestamp: new Date().toISOString()
            });
            endSpan(paymentSpan, paymentResult);
            
            // Payment Agent decision
            const paymentDecision = this.paymentAgent.makeDecision(paymentResult);
            chainOfThought.push({
                agent: 'PaymentAgent',
                action: 'make_decision',
                input: paymentResult,
                output: paymentDecision,
                timestamp: new Date().toISOString()
            });
            
            if (!paymentDecision.approved) {
                return {
                    success: false,
                    message: paymentDecision.message,
                    chainOfThought,
                    traceId: trace.id,
                    sessionId
                };
            }
            
            // All agents approved
            const finalResult = {
                success: true,
                orderId: orderResult.orderId,
                message: 'Order approved by all agents',
                totalAmount: orderResult.totalAmount,
                medicine: orderResult.medicine,
                quantity: orderResult.quantity,
                paymentMethod: paymentResult.method,
                paymentStatus: paymentResult.status,
                chainOfThought,
                traceId: trace.id,
                sessionId,
                processingTime: Date.now() - startTime,
                prescriptionValidated: prescriptionValidated
            };
            
            // Store session
            this.sessions.set(sessionId, {
                ...finalResult,
                timestamp: new Date()
            });
            
            return finalResult;
            
        } catch (error) {
            console.error('Agent orchestration error:', error);
            
            chainOfThought.push({
                agent: 'Orchestrator',
                action: 'error_handling',
                error: error.message,
                timestamp: new Date().toISOString()
            });
            
            return {
                success: false,
                message: 'System error: ' + error.message,
                chainOfThought,
                traceId: trace.id,
                sessionId
            };
        }
    }
    
    // Get trace URL for observability
    getTraceUrl(traceId) {
        return getTraceUrl(traceId);
    }
}

module.exports = AgentOrchestrator;