require('dotenv').config();
const AutoRefillService = require('./services/autoRefillService');

async function testRefill() {
    console.log('🧪 Testing Auto Refill Service...\n');
    
    const refillService = new AutoRefillService();
    
    // Test LLM reminder generation
    console.log('Testing LLM reminder generation:');
    const testData = {
        customerName: 'John Doe',
        medicineName: 'Amoxicillin',
        daysUntilRefill: 0,
        lastPurchaseDate: '2024-02-15',
        phone: '+1234567890'
    };
    
    const reminder = await refillService.llmService.generateRefillReminder(testData);
    console.log('Generated reminder:', reminder);
    console.log('\n' + '-'.repeat(50) + '\n');
    
    // Test customer pattern analysis
    console.log('Testing pattern analysis (with sample data):');
    const sampleOrders = [
        {
            medicine_name: 'Amoxicillin',
            quantity: 1,
            created_at: '2024-01-15',
            total_amount: 150
        },
        {
            medicine_name: 'Amoxicillin',
            quantity: 1,
            created_at: '2024-02-15',
            total_amount: 150
        },
        {
            medicine_name: 'Paracetamol',
            quantity: 2,
            created_at: '2024-02-20',
            total_amount: 100
        }
    ];
    
    const analysis = await refillService.llmService.analyzePurchaseHistory(sampleOrders);
    console.log('Analysis result:', JSON.stringify(analysis, null, 2));
    
    console.log('\n✅ Test complete!');
}

testRefill().catch(console.error);