const OpenAI = require('openai');
require('dotenv').config();

class LLMService {
    constructor() {
        this.openai = null;
        this.chatModel = process.env.OPENAI_CHAT_MODEL || 'gpt-3.5-turbo';
        this.medicineMatchModel = process.env.OPENAI_MED_MATCH_MODEL || 'gpt-4o-mini';
        this.initializeLLM();
    }

    initializeLLM() {
        try {
            if (process.env.OPENAI_API_KEY) {
                this.openai = new OpenAI({
                    apiKey: process.env.OPENAI_API_KEY
                });
                console.log('✅ LLM Service initialized with OpenAI');
            } else {
                console.log('⚠️ Valid OPENAI_API_KEY not found, using template fallback');
            }
        } catch (error) {
            console.error('❌ LLM initialization failed:', error.message);
        }
    }

    async generateChatResponse({ message, state = 'idle', userName = '', medicine = '' }) {
        try {
            if (!this.openai) {
                return this.getFallbackChatResponse({ message, state, userName, medicine });
            }

            const systemPrompt = `You are a friendly Pharmacy AI assistant for an Indian online pharmacy.
You must improve user chat experience while being concise and actionable.
Rules:
- Keep replies under 80 words.
- If user intent is ordering medicine, guide to exact next step based on state.
- If user asks health-critical questions, advise consulting a doctor.
- Never provide diagnosis.
- Use simple, conversational English.`;

            const contextPrompt = `Conversation state: ${state}\nKnown user name: ${userName || 'unknown'}\nCurrent medicine context: ${medicine || 'none'}`;

            const completion = await this.openai.chat.completions.create({
                model: this.chatModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'system', content: contextPrompt },
                    { role: 'user', content: message }
                ],
                max_tokens: 140,
                temperature: 0.7
            });

            const reply = completion?.choices?.[0]?.message?.content?.trim();
            if (!reply) {
                return this.getFallbackChatResponse({ message, state, userName, medicine });
            }

            return {
                success: true,
                reply,
                generatedBy: 'LLM'
            };
        } catch (error) {
            console.error('❌ LLM chat response error:', error.message);
            return this.getFallbackChatResponse({ message, state, userName, medicine });
        }
    }

    async matchMedicineFromText({ message, candidates = [] }) {
        try {
            const fallback = this.fallbackMedicineMatch(message, candidates);

            if (!this.openai || !Array.isArray(candidates) || candidates.length === 0) {
                return fallback;
            }

            const limitedCandidates = candidates.slice(0, 120);
            const candidatePrompt = limitedCandidates.map((candidate, index) => {
                const aliases = (candidate.aliases || []).slice(0, 8).join(', ');
                return `${index + 1}. canonical: ${candidate.canonical}; aliases: ${aliases}`;
            }).join('\n');

            const completion = await this.openai.chat.completions.create({
                model: this.medicineMatchModel,
                messages: [
                    {
                        role: 'system',
                        content: `You match user medicine text to one canonical medicine from the given candidate list.
Rules:
- Medicine can include multiple names (brand, generic, combo names, aliases).
- Return strict JSON only with keys: matched(boolean), canonical(string|null), confidence(number 0-1), reason(string).
- If uncertain, return matched=false.
- Never invent medicine not present in candidates.`
                    },
                    {
                        role: 'user',
                        content: `User text: "${message}"\n\nCandidates:\n${candidatePrompt}`
                    }
                ],
                temperature: 0.1,
                max_tokens: 120,
                response_format: { type: 'json_object' }
            });

            const raw = completion?.choices?.[0]?.message?.content?.trim();
            if (!raw) {
                return fallback;
            }

            const parsed = JSON.parse(raw);
            if (!parsed?.matched || !parsed?.canonical) {
                return fallback;
            }

            const canonical = String(parsed.canonical).trim();
            const exists = limitedCandidates.some(candidate =>
                candidate.canonical.toLowerCase() === canonical.toLowerCase()
            );

            if (!exists) {
                return fallback;
            }

            return {
                success: true,
                matched: true,
                medicine: canonical,
                confidence: Number(parsed.confidence) || 0.7,
                reason: parsed.reason || 'Matched by LLM medicine model',
                generatedBy: 'LLM'
            };
        } catch (error) {
            console.error('❌ LLM medicine match error:', error.message);
            return this.fallbackMedicineMatch(message, candidates);
        }
    }

    fallbackMedicineMatch(message, candidates = []) {
        const query = (message || '').toLowerCase().trim();
        if (!query || !Array.isArray(candidates) || candidates.length === 0) {
            return {
                success: true,
                matched: false,
                medicine: null,
                confidence: 0,
                reason: 'No candidates available',
                generatedBy: 'Template'
            };
        }

        for (const candidate of candidates) {
            const aliases = [candidate.canonical, ...(candidate.aliases || [])]
                .filter(Boolean)
                .map(alias => alias.toLowerCase());

            for (const alias of aliases) {
                if (alias.length > 2 && (query.includes(alias) || alias.includes(query))) {
                    return {
                        success: true,
                        matched: true,
                        medicine: candidate.canonical,
                        confidence: 0.65,
                        reason: 'Matched by alias fallback',
                        generatedBy: 'Template'
                    };
                }
            }
        }

        return {
            success: true,
            matched: false,
            medicine: null,
            confidence: 0,
            reason: 'No fallback match',
            generatedBy: 'Template'
        };
    }

    getFallbackChatResponse({ state = 'idle', userName = '', medicine = '' }) {
        if (state === 'ordering') {
            return {
                success: true,
                reply: medicine
                    ? `I can help you order ${medicine}. Please tell me the quantity you need.`
                    : 'Please tell me the exact medicine name, and I will check availability for you.',
                generatedBy: 'Template'
            };
        }

        if (state === 'quantity') {
            return {
                success: true,
                reply: 'Please share quantity as a number or words, like 2 or two.',
                generatedBy: 'Template'
            };
        }

        return {
            success: true,
            reply: `Hi ${userName || 'there'}! I can help you order medicines, scan labels, and track steps quickly. Tell me medicine name to start, or type scan to open camera.`,
            generatedBy: 'Template'
        };
    }

    async generateRefillReminder(customerData) {
        try {
            if (!this.openai) {
                return this.getFallbackReminder(customerData);
            }

            const prompt = this.buildRefillPrompt(customerData);
            
            const completion = await this.openai.chat.completions.create({
                model: this.chatModel,
                messages: [
                    {
                        role: "system",
                        content: "You are a helpful pharmacy assistant. Create short, friendly SMS reminders for medicine refills. Keep messages under 160 characters. Include medicine name and number of days of supply left."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                max_tokens: 100,
                temperature: 0.7
            });

            const reminderMessage = completion.choices[0].message.content.trim();
            
            return {
                success: true,
                message: reminderMessage,
                customerPhone: customerData.phone,
                medicineName: customerData.medicineName,
                generatedBy: 'LLM'
            };

        } catch (error) {
            console.error('❌ LLM generation error:', error.message);
            return this.getFallbackReminder(customerData);
        }
    }

buildRefillPrompt(customerData) {
    let urgencyLevel = '';
    if (customerData.daysUntilRefill <= 0) {
        urgencyLevel = 'urgent - they are out of medicine';
    } else if (customerData.daysUntilRefill <= 2) {
        urgencyLevel = 'important - they have very few days left';
    } else {
        urgencyLevel = 'reminder - they have limited supply';
    }
    
    return `
        Create a friendly SMS reminder for medicine refill:
        
        Customer: ${customerData.customerName}
        Medicine: ${customerData.medicineName}
        Current Status: ${urgencyLevel}
        Tablets Remaining: ${customerData.tabletsRemaining}
        Days Until Refill Needed: ${customerData.daysUntilRefill}
        Daily Consumption: ${customerData.dailyConsumption} tablets
        Purchase History: ${customerData.totalPurchases} previous purchases
        
        The message should:
        - Be friendly and caring
        - Mention the medicine name
        - Indicate urgency level
        - Suggest refill now
        - Keep under 160 characters
        
        Generate only the SMS message text.
    `;
}

getFallbackReminder(customerData) {
    let urgencyText = '';
    if (customerData.daysUntilRefill <= 0) {
        urgencyText = 'You are out of';
    } else if (customerData.daysUntilRefill === 1) {
        urgencyText = 'You have only 1 day of';
    } else {
        urgencyText = `You have ${customerData.daysUntilRefill} days of`;
    }
    
    const templates = [
        `Hi ${customerData.customerName}, ${urgencyText} ${customerData.medicineName} left (${customerData.tabletsRemaining} tablets). Please refill soon. [link]`,
        `Friendly reminder: Your ${customerData.medicineName} supply is running low. ${urgencyText} supply remaining. Order now: [link]`,
        `${customerData.customerName}, time to refill your ${customerData.medicineName}. Only ${customerData.tabletsRemaining} tablets left (${customerData.daysUntilRefill} days supply). [link]`
    ];
    
    const randomTemplate = templates[Math.floor(Math.random() * templates.length)];
    
    return {
        success: true,
        message: randomTemplate,
        customerPhone: customerData.phone,
        medicineName: customerData.medicineName,
        generatedBy: 'Template'
    };
}
}

module.exports = LLMService;