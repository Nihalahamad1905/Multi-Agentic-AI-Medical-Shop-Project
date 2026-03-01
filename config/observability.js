const { Langfuse } = require('langfuse');
require('dotenv').config();

// Initialize Langfuse with proper error handling
let langfuse;
try {
    if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
        langfuse = new Langfuse({
            publicKey: process.env.LANGFUSE_PUBLIC_KEY,
            secretKey: process.env.LANGFUSE_SECRET_KEY,
            baseUrl: process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com'
        });
        console.log('✅ Langfuse initialized successfully');
    } else {
        console.log('⚠️ Langfuse credentials not found, running in mock mode');
        langfuse = null;
    }
} catch (error) {
    console.error('❌ Langfuse initialization error:', error.message);
    console.log('⚠️ Running in mock observability mode');
    langfuse = null;
}

// Create a trace for agent interactions
const createTrace = async (sessionId, userId = 'anonymous') => {
    const traceId = `trace_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    try {
        if (langfuse) {
            const trace = langfuse.trace({
                id: traceId,
                name: 'pharmacy_agent_chain',
                sessionId: sessionId,
                userId: userId,
                metadata: {
                    timestamp: new Date().toISOString(),
                    environment: process.env.NODE_ENV || 'development'
                }
            });
            
            console.log(`📊 Langfuse trace created: ${traceId}`);
            return trace;
        } else {
            // Mock trace for development
            console.log(`📊 Mock trace created: ${traceId}`);
            return {
                id: traceId,
                span: (name, input) => ({
                    end: (output) => console.log(`Mock span ${name} ended`)
                })
            };
        }
    } catch (error) {
        console.error('Langfuse trace creation error:', error.message);
        // Return mock trace on error
        return {
            id: traceId,
            span: () => ({
                end: () => {}
            })
        };
    }
};

// Create a span within a trace
const createSpan = (trace, name, input = null) => {
    try {
        if (trace && trace.span) {
            const span = trace.span({
                name: name,
                input: input,
                startTime: new Date()
            });
            return span;
        } else {
            // Mock span
            return {
                end: (output) => {
                    if (output) {
                        console.log(`📊 Span "${name}" completed`);
                    }
                }
            };
        }
    } catch (error) {
        console.error('Langfuse span creation error:', error.message);
        return {
            end: () => {}
        };
    }
};

// End span with output
const endSpan = (span, output) => {
    try {
        if (span && span.end) {
            span.end({
                output: output,
                endTime: new Date()
            });
        }
    } catch (error) {
        console.error('Langfuse end span error:', error.message);
    }
};

// Get trace URL
const getTraceUrl = (traceId) => {
    if (process.env.LANGFUSE_HOST && traceId && !traceId.startsWith('mock_')) {
        return `${process.env.LANGFUSE_HOST}/trace/${traceId}`;
    }
    // Return mock URL for development
    return `https://cloud.langfuse.com/trace/${traceId}`;
};

module.exports = {
    langfuse,
    createTrace,
    createSpan,
    endSpan,
    getTraceUrl
};