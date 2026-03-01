const natural = require('natural');
const compromise = require('compromise');
const fuzzball = require('fuzzball');
const stringSimilarity = require('string-similarity');
const { TfIdf, WordTokenizer, PorterStemmer, LevenshteinDistance, Metaphone } = natural;

class NLPService {
    constructor() {
        this.tokenizer = new WordTokenizer();
        this.tfidf = new TfIdf();
        this.medicineDatabase = new Map();
        this.medicineNames = [];
        this.medicineKeywords = new Map();
        this.commonMisspellings = new Map();
        this.phoneticMap = new Map(); // For sound-alike medicines
        this.dynamicVariations = new Map();
        this.dynamicWordIndex = new Map();
        this.dynamicWordPhoneticIndex = new Map();
        
        // Common misspellings patterns
        this.misspellingPatterns = {
            'paracetamol': ['paracimal', 'paracitamol', 'paracetemol', 'paracitamole', 'paracetmole', 'paracetmal', 'paracitmal', 'pcm', 'crocin'],
            'cetamol': ['cetemol', 'cetamole', 'setamol', 'sytamol', 'cetmal'],
            'ibuprofen': ['ibuprofan', 'ibeprufen', 'iboprufen', 'ibuprifen', 'brufen'],
            'amoxicillin': ['amoxcillin', 'amoxcyllin', 'amoxilin', 'amoxiciline', 'amoxcyline', 'amox'],
            'azithromycin': ['azithromicin', 'azythromycin', 'azithromycine', 'azithro', 'azee'],
            'metformin': ['metformine', 'metphormin', 'metformun', 'metforman', 'met'],
            'atorvastatin': ['atorvastin', 'atorvastatine', 'atorvastan', 'atrova'],
            'omeprazole': ['omeprazol', 'omeprazole', 'omeprazile', 'omeprazol'],
            'cetirizine': ['cetrizine', 'cetirizene', 'ceterizine', 'cetrizene', 'cet'],
            'loratadine': ['loratidine', 'loratadene', 'loratadin', 'loradine'],
            'dolo': ['dolo 650', 'dolo650', 'dolo-650', 'dolo tab'],
            'crocin': ['crocin 500', 'crocin500', 'crocin-500', 'crocin advance']
        };
        
        // Baseline abbreviations (dynamic aliases from DB are added at runtime)
        this.variations = new Map([
            ['pcm', ['paracetamol']],
            ['amox', ['amoxicillin']],
            ['azee', ['azithromycin']],
            ['met', ['metformin']]
        ]);

        this.formWords = new Set([
            'tablet', 'tablets', 'tab', 'tabs', 'capsule', 'capsules', 'cap', 'caps',
            'syrup', 'suspension', 'injection', 'inj', 'drops', 'drop', 'cream', 'gel',
            'ointment', 'powder', 'strip', 'pack', 'bottle'
        ]);
        
        this.stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'if', 'because', 'as', 'what', 'which', 'this', 'that', 'these', 'those', 'then', 'just', 'so', 'than', 'such', 'both', 'through', 'about', 'for', 'is', 'of', 'while', 'during', 'to', 'from', 'in', 'on', 'at', 'by', 'with', 'without', 'after', 'before', 'up', 'down', 'into', 'out', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now']);
    }
    
    // Initialize with medicine database
    async initializeMedicineDatabase(medicines) {
        console.log(`📚 Loading ${medicines.length} medicines into NLP system with spell check...`);
        
        this.medicineNames = medicines.map(m => ({
            name: m.name.toLowerCase(),
            original: m.name,
            id: m.medicine_id,
            tokens: this.tokenizer.tokenize(m.name.toLowerCase()),
            stemmed: this.stemMedicineName(m.name)
        }));
        
        // Build search index
        this.buildSearchIndex();

        // Build dynamic medicine aliases/abbreviations from DB names
        this.buildDynamicVariations();

        // Build dynamic word index for typo and phonetic correction
        this.buildDynamicWordIndex();
        
        // Initialize common misspellings
        this.initializeMisspellings();
        
        // Build phonetic index for sound-alike medicines
        this.buildPhoneticIndex();
        
        console.log('✅ NLP Medicine database initialized with spell checking');
    }
    
    stemMedicineName(name) {
        const tokens = this.tokenizer.tokenize(name.toLowerCase());
        return tokens.map(t => PorterStemmer.stem(t)).join(' ');
    }
    
    buildSearchIndex() {
        this.medicineNames.forEach(med => {
            // Index by name
            this.medicineDatabase.set(med.name, med);
            
            // Index by tokens
            med.tokens.forEach(token => {
                if (!this.medicineKeywords.has(token)) {
                    this.medicineKeywords.set(token, []);
                }
                this.medicineKeywords.get(token).push(med);
            });
            
            // Add variations
            const nameParts = med.name.split(/\s+/);
            for (let i = 0; i < nameParts.length; i++) {
                const partial = nameParts.slice(i).join(' ');
                if (partial.length > 3) {
                    this.medicineDatabase.set(partial, med);
                }
            }
        });
    }

    buildDynamicVariations() {
        this.dynamicVariations.clear();

        const addAlias = (alias, canonical) => {
            if (!alias || !canonical) return;

            const normalizedAlias = alias.toLowerCase().trim().replace(/\s+/g, ' ');
            if (normalizedAlias.length < 2) return;

            if (!this.dynamicVariations.has(normalizedAlias)) {
                this.dynamicVariations.set(normalizedAlias, new Set());
            }
            this.dynamicVariations.get(normalizedAlias).add(canonical);
        };

        this.medicineNames.forEach(med => {
            const canonical = med.original;
            const lowerName = med.name;

            // Full name
            addAlias(lowerName, canonical);

            // Remove dosage details: 500mg, 5 ml, etc.
            const withoutDose = lowerName
                .replace(/\b\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml)\b/gi, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            addAlias(withoutDose, canonical);

            // Split combo names: "A + B", "A/B", "A with B"
            lowerName
                .split(/\+|\/|,|\bwith\b|\band\b/gi)
                .map(part => part.trim())
                .filter(part => part.length > 2)
                .forEach(part => addAlias(part, canonical));

            // Bracket content handling: "Name (something)"
            const noBrackets = lowerName
                .replace(/\([^)]*\)/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            addAlias(noBrackets, canonical);

            // Base name by removing common dosage/form words
            const baseTokens = this.tokenizer
                .tokenize(lowerName)
                .filter(token => !this.formWords.has(token))
                .filter(token => !/^\d+(?:\.\d+)?(?:mg|mcg|g|ml)?$/i.test(token));

            if (baseTokens.length > 0) {
                addAlias(baseTokens.join(' '), canonical);
            }

            // Prefix aliases for quick user shorthand: first 4-6 chars
            const compact = lowerName.replace(/[^a-z]/g, '');
            if (compact.length >= 4) {
                addAlias(compact.substring(0, 4), canonical);
            }
            if (compact.length >= 6) {
                addAlias(compact.substring(0, 6), canonical);
            }
        });

        console.log(`🤖 Dynamic medicine aliases built: ${this.dynamicVariations.size}`);
    }

    buildDynamicWordIndex() {
        this.dynamicWordIndex.clear();
        this.dynamicWordPhoneticIndex.clear();

        const addWord = (word, canonical) => {
            if (!word || !canonical) return;

            const normalizedWord = word.toLowerCase().trim();
            if (normalizedWord.length < 3) return;
            if (this.stopWords.has(normalizedWord)) return;
            if (/^\d+(?:\.\d+)?$/.test(normalizedWord)) return;

            if (!this.dynamicWordIndex.has(normalizedWord)) {
                this.dynamicWordIndex.set(normalizedWord, new Set());
            }
            this.dynamicWordIndex.get(normalizedWord).add(canonical);

            const code = this.getPhoneticCode(normalizedWord);
            if (code) {
                if (!this.dynamicWordPhoneticIndex.has(code)) {
                    this.dynamicWordPhoneticIndex.set(code, new Set());
                }
                this.dynamicWordPhoneticIndex.get(code).add(normalizedWord);
            }
        };

        this.medicineNames.forEach(med => {
            addWord(med.name, med.original);

            med.tokens
                .filter(token => token.length >= 3)
                .forEach(token => addWord(token, med.original));
        });

        for (const [alias, canonicalSet] of this.dynamicVariations.entries()) {
            const canonical = Array.from(canonicalSet)[0];
            if (!canonical) continue;

            addWord(alias, canonical);

            this.tokenizer
                .tokenize(alias)
                .filter(token => token.length >= 3)
                .forEach(token => addWord(token, canonical));
        }

        console.log(`🤖 Dynamic medicine word index built: ${this.dynamicWordIndex.size}`);
    }

    findBestDynamicWordMatch(word) {
        const inputWord = (word || '').toLowerCase().trim();
        if (!inputWord || inputWord.length < 3) return null;

        if (this.dynamicWordIndex.has(inputWord)) {
            return inputWord;
        }

        const inputCode = this.getPhoneticCode(inputWord);
        const phoneticCandidates = inputCode ? this.dynamicWordPhoneticIndex.get(inputCode) : null;
        const usingPhoneticCandidates = !!(phoneticCandidates && phoneticCandidates.size > 0);
        const candidates = phoneticCandidates && phoneticCandidates.size > 0
            ? Array.from(phoneticCandidates)
            : Array.from(this.dynamicWordIndex.keys());

        let bestMatch = null;
        let bestScore = 0;

        for (const candidate of candidates) {
            if (Math.abs(candidate.length - inputWord.length) > 5) continue;

            const levenshteinScore = this.levenshteinSimilarity(inputWord, candidate);
            const similarityScore = stringSimilarity.compareTwoStrings(inputWord, candidate);
            const fuzzyScore = fuzzball.ratio(inputWord, candidate) / 100;
            const score = Math.max(levenshteinScore, similarityScore, fuzzyScore);

            if (score > bestScore) {
                bestScore = score;
                bestMatch = candidate;
            }
        }

        const threshold = usingPhoneticCandidates ? 0.5 : 0.62;
        if (bestMatch && bestScore >= threshold) {
            return bestMatch;
        }

        return null;
    }
    
    initializeMisspellings() {
        // Build misspelling dictionary from patterns
        for (const [correct, misspellings] of Object.entries(this.misspellingPatterns)) {
            misspellings.forEach(wrong => {
                this.commonMisspellings.set(wrong.toLowerCase(), correct.toLowerCase());
            });
        }
        
        // Add common typos based on keyboard proximity
        this.addKeyboardTypos();

        // Add dynamic aliases as correction hints
        for (const [alias, canonicals] of this.dynamicVariations.entries()) {
            const canonical = Array.from(canonicals)[0];
            if (alias && canonical && !this.commonMisspellings.has(alias)) {
                this.commonMisspellings.set(alias, canonical.toLowerCase());
            }
        }
    }
    
    addKeyboardTypos() {
        const keyboard = {
            'q': ['w', 'a'], 'w': ['q', 'e', 's'], 'e': ['w', 'r', 'd'], 'r': ['e', 't', 'f'],
            't': ['r', 'y', 'g'], 'y': ['t', 'u', 'h'], 'u': ['y', 'i', 'j'], 'i': ['u', 'o', 'k'],
            'o': ['i', 'p', 'l'], 'p': ['o', '['], 'a': ['q', 's', 'z'], 's': ['w', 'a', 'd', 'x'],
            'd': ['e', 's', 'f', 'c'], 'f': ['r', 'd', 'g', 'v'], 'g': ['t', 'f', 'h', 'b'],
            'h': ['y', 'g', 'j', 'n'], 'j': ['u', 'h', 'k', 'm'], 'k': ['i', 'j', 'l'],
            'l': ['o', 'k', ';'], 'z': ['a', 'x'], 'x': ['z', 's', 'c'], 'c': ['x', 'd', 'f', 'v'],
            'v': ['c', 'f', 'g', 'b'], 'b': ['v', 'g', 'h', 'n'], 'n': ['b', 'h', 'j', 'm'],
            'm': ['n', 'j', 'k']
        };
        
        // Generate common typos for medicine names
        this.medicineNames.forEach(med => {
            const name = med.name;
            const typos = this.generateTypos(name, keyboard);
            typos.forEach(typo => {
                if (!this.commonMisspellings.has(typo)) {
                    this.commonMisspellings.set(typo, name);
                }
            });
        });
    }
    
    generateTypos(word, keyboard, maxTypos = 3) {
        const typos = new Set();
        const chars = word.split('');
        
        for (let i = 0; i < chars.length && typos.size < maxTypos; i++) {
            const char = chars[i];
            const neighbors = keyboard[char] || [];
            
            neighbors.forEach(neighbor => {
                const typo = chars.slice();
                typo[i] = neighbor;
                typos.add(typo.join(''));
            });
        }
        
        return Array.from(typos);
    }
    
    buildPhoneticIndex() {
        // Use a simple phonetic algorithm (first 4 consonants) as fallback
        this.medicineNames.forEach(med => {
            const phonetic = this.simplePhonetic(med.name);
            if (!this.phoneticMap.has(phonetic)) {
                this.phoneticMap.set(phonetic, []);
            }
            this.phoneticMap.get(phonetic).push(med);
        });
    }
    
    // Simple phonetic algorithm (extracts first 4 consonants)
    simplePhonetic(word) {
        const consonants = word.toLowerCase().replace(/[aeiou\s]/g, '');
        return consonants.substring(0, 4);
    }

    getPhoneticCode(word) {
        const input = (word || '').toLowerCase().trim();
        if (!input) return '';

        try {
            if (Metaphone) {
                if (typeof Metaphone.process === 'function') {
                    return Metaphone.process(input) || this.simplePhonetic(input);
                }

                if (typeof Metaphone === 'function') {
                    return Metaphone(input) || this.simplePhonetic(input);
                }
            }
        } catch (error) {
            // Fall back to local phonetic encoder
        }

        return this.simplePhonetic(input);
    }
    
    // Main method to extract medicine name from user input with spell correction
    extractMedicineName(userInput) {
        if (!userInput) return null;
        
        const input = userInput.toLowerCase().trim();
        
        console.log('🔍 NLP: Extracting medicine from:', input);
        
        // Strategy 1: Check common abbreviations and variations
        const abbreviationMatch = this.checkAbbreviations(input);
        if (abbreviationMatch) return abbreviationMatch;
        
        // Strategy 2: Check for exact matches
        const exactMatch = this.findExactMedicineMatch(input);
        if (exactMatch) return exactMatch;
        
        // Strategy 3: Spell correction for common misspellings
        const spellCorrected = this.correctSpelling(input);
        if (spellCorrected && spellCorrected !== input) {
            console.log(`📝 Spell corrected: "${input}" -> "${spellCorrected}"`);

            const correctedAbbreviationMatch = this.checkAbbreviations(spellCorrected);
            if (correctedAbbreviationMatch) return correctedAbbreviationMatch;

            const correctedMatch = this.findExactMedicineMatch(spellCorrected);
            if (correctedMatch) return correctedMatch;
        }
        
        // Strategy 4: Fuzzy word matching with multiple algorithms
        const fuzzyMatch = this.fuzzyMatchWithRanking(input);
        if (fuzzyMatch) return fuzzyMatch;
        
        // Strategy 5: Phonetic matching (for sound-alike medicines)
        const phoneticMatch = this.phoneticMatch(input);
        if (phoneticMatch) return phoneticMatch;
        
        // Strategy 6: Partial word matching
        const partialMatch = this.partialWordMatch(input);
        if (partialMatch) return partialMatch;
        
        // Strategy 7: Character-level n-gram matching
        const ngramMatch = this.ngramMatch(input);
        if (ngramMatch) return ngramMatch;
        
        return null;
    }
    
    checkAbbreviations(input) {
        // Check dynamic variation map generated from DB medicines
        for (const [alias, canonicalSet] of this.dynamicVariations.entries()) {
            if (alias.length > 1 && input.includes(alias)) {
                const canonical = Array.from(canonicalSet)[0];
                if (canonical) {
                    console.log(`✅ Dynamic alias match: ${alias} -> ${canonical}`);
                    return canonical;
                }
            }
        }

        // Check variations map
        for (const [abbr, expansions] of this.variations) {
            if (input.includes(abbr)) {
                console.log(`✅ Abbreviation match: ${abbr} -> ${expansions[0]}`);
                return expansions[0];
            }
        }
        
        // Check for common abbreviations in the message
        const words = input.split(/\s+/);
        for (const word of words) {
            if (word.length <= 4) { // Short words might be abbreviations
                for (const medicine of this.medicineNames) {
                    if (medicine.name.startsWith(word) && word.length > 2) {
                        console.log(`✅ Possible abbreviation: ${word} -> ${medicine.original}`);
                        return medicine.original;
                    }
                }
            }
        }
        
        return null;
    }
    
    correctSpelling(input) {
        const words = input.split(/\s+/);
        const correctedWords = [];
        
        for (const word of words) {
            const normalizedWord = word.toLowerCase().trim();

            if (this.commonMisspellings.has(normalizedWord)) {
                correctedWords.push(this.commonMisspellings.get(normalizedWord));
            } else if (normalizedWord.length >= 3 && !this.stopWords.has(normalizedWord)) {
                const dynamicMatch = this.findBestDynamicWordMatch(normalizedWord);
                if (dynamicMatch) {
                    correctedWords.push(dynamicMatch);
                } else {
                    correctedWords.push(word);
                }
            } else {
                correctedWords.push(word);
            }
        }
        
        return correctedWords.join(' ');
    }
    
    fuzzyMatchWithRanking(input) {
        const candidates = [];
        const words = input.split(/\s+/);
        
        for (const medicine of this.medicineNames) {
            let score = 0;
            let matchedWords = 0;
            
            // Check each word against medicine name
            for (const word of words) {
                if (word.length < 3) continue;
                
                // Calculate multiple similarity metrics
                const levScore = this.levenshteinSimilarity(word, medicine.name);
                const jaroScore = fuzzball.ratio(word, medicine.name) / 100;
                const partialRatio = fuzzball.partial_ratio(word, medicine.name) / 100;
                const tokenSortRatio = fuzzball.token_sort_ratio(input, medicine.name) / 100;
                
                // Weighted combination of scores
                const combinedScore = (
                    levScore * 0.3 + 
                    jaroScore * 0.2 + 
                    partialRatio * 0.2 + 
                    tokenSortRatio * 0.3
                );
                
                if (combinedScore > score) {
                    score = combinedScore;
                }
                
                // Check if word is contained in medicine name
                if (medicine.name.includes(word)) {
                    matchedWords++;
                }
            }
            
            // Bonus for matching multiple words
            if (matchedWords > 0) {
                score += (matchedWords / words.length) * 0.2;
            }
            
            candidates.push({
                medicine: medicine.original,
                score: Math.min(score, 1)
            });
        }
        
        // Sort by score and get best match
        candidates.sort((a, b) => b.score - a.score);
        
        if (candidates.length > 0 && candidates[0].score > 0.6) {
            console.log(`✅ Fuzzy match: ${candidates[0].medicine} (score: ${candidates[0].score.toFixed(2)})`);
            return candidates[0].medicine;
        }
        
        return null;
    }
    
    levenshteinSimilarity(word1, word2) {
        const distance = LevenshteinDistance(word1, word2);
        const maxLen = Math.max(word1.length, word2.length);
        return 1 - (distance / maxLen);
    }
    
    phoneticMatch(input) {
        const inputPhonetic = this.simplePhonetic(input);
        const matches = this.phoneticMap.get(inputPhonetic) || [];
        
        if (matches.length > 0) {
            // Find best match among phonetically similar medicines
            let bestMatch = null;
            let bestScore = 0;
            
            for (const match of matches) {
                const score = stringSimilarity.compareTwoStrings(input, match.name);
                if (score > bestScore && score > 0.4) {
                    bestScore = score;
                    bestMatch = match.original;
                }
            }
            
            if (bestMatch) {
                console.log(`✅ Phonetic match: ${bestMatch} (score: ${bestScore.toFixed(2)})`);
                return bestMatch;
            }
        }
        
        return null;
    }
    
    partialWordMatch(input) {
        const words = input.split(/\s+/);
        let bestMatch = null;
        let bestScore = 0;
        
        for (const medicine of this.medicineNames) {
            for (const word of words) {
                if (word.length < 3) continue;
                
                // Check if word is a substring of medicine name
                if (medicine.name.includes(word)) {
                    const score = word.length / medicine.name.length;
                    if (score > bestScore && score > 0.3) {
                        bestScore = score;
                        bestMatch = medicine.original;
                    }
                }
                
                // Check if medicine name is a substring of word
                if (word.includes(medicine.name) && medicine.name.length > 3) {
                    const score = medicine.name.length / word.length;
                    if (score > bestScore && score > 0.5) {
                        bestScore = score;
                        bestMatch = medicine.original;
                    }
                }
            }
        }
        
        if (bestMatch) {
            console.log(`✅ Partial word match: ${bestMatch} (coverage: ${(bestScore * 100).toFixed(0)}%)`);
            return bestMatch;
        }
        
        return null;
    }
    
    ngramMatch(input, n = 3) {
        const inputNgrams = this.generateNgrams(input, n);
        let bestMatch = null;
        let bestOverlap = 0;
        
        for (const medicine of this.medicineNames) {
            const medicineNgrams = this.generateNgrams(medicine.name, n);
            
            // Calculate Jaccard similarity
            const intersection = new Set([...inputNgrams].filter(x => medicineNgrams.has(x)));
            const union = new Set([...inputNgrams, ...medicineNgrams]);
            const overlap = intersection.size / union.size;
            
            if (overlap > bestOverlap && overlap > 0.3) {
                bestOverlap = overlap;
                bestMatch = medicine.original;
            }
        }
        
        if (bestMatch) {
            console.log(`✅ N-gram match: ${bestMatch} (overlap: ${(bestOverlap * 100).toFixed(0)}%)`);
            return bestMatch;
        }
        
        return null;
    }
    
    generateNgrams(text, n) {
        const ngrams = new Set();
        const cleaned = text.replace(/\s+/g, '').toLowerCase();
        
        for (let i = 0; i <= cleaned.length - n; i++) {
            ngrams.add(cleaned.substr(i, n));
        }
        
        return ngrams;
    }
    
    findExactMedicineMatch(input) {
        // Direct match
        for (const medicine of this.medicineNames) {
            if (input.includes(medicine.name)) {
                return medicine.original;
            }
        }
        
        // Token-based match
        const inputTokens = this.tokenizer.tokenize(input);
        for (const medicine of this.medicineNames) {
            const matches = medicine.tokens.filter(token => 
                inputTokens.includes(token)
            ).length;
            
            if (matches === medicine.tokens.length) {
                return medicine.original;
            }
        }
        
        return null;
    }
    
    // Enhanced intent extraction with misspelled medicine names
    extractIntent(message) {
        const lower = message.toLowerCase();
        
        // First, try to extract medicine name (with spell correction)
        const extractedMedicine = this.extractMedicineName(message);
        
        const intents = {
            ORDER: ['order', 'buy', 'purchase', 'get', 'need', 'want', 'please', 'medicine', 'take', 'give'],
            SCAN: ['scan', 'camera', 'picture', 'photo', 'snap'],
            STATUS: ['status', 'track', 'where', 'order status', 'delivery', 'shipped'],
            PRESCRIPTION: ['prescription', 'upload', 'prescribed', 'doctor', 'valid', 'rx'],
            QUANTITY: this.extractQuantity(lower),
            MEDICINE: extractedMedicine
        };
        
        // Determine primary intent with context awareness
        if (intents.MEDICINE || intents.ORDER.some(word => lower.includes(word))) {
            intents.primary = 'ORDER';
            intents.confidence = intents.MEDICINE ? 0.9 : 0.6;
        } else if (intents.SCAN.some(word => lower.includes(word))) {
            intents.primary = 'SCAN';
            intents.confidence = 0.8;
        } else if (intents.STATUS.some(word => lower.includes(word))) {
            intents.primary = 'STATUS';
            intents.confidence = 0.8;
        } else {
            intents.primary = 'UNKNOWN';
            intents.confidence = 0.1;
        }
        
        return intents;
    }
    
    extractQuantity(message) {
        // Handle different quantity formats
        const patterns = [
            /\b(\d+)\s*(?:tablets?|pills?|units?|bottles?|boxes?|tabs?|mg|ml)?\b/gi,
            /\b(?:quantity|qty|count)[:\s]*(\d+)\b/gi,
            /\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi
        ];
        
        const wordToNumber = {
            'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
            'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10
        };
        
        for (const pattern of patterns) {
            const matches = message.matchAll(pattern);
            for (const match of matches) {
                if (match[1]) {
                    if (wordToNumber[match[1].toLowerCase()]) {
                        return wordToNumber[match[1].toLowerCase()];
                    }
                    const quantity = parseInt(match[1]);
                    if (!isNaN(quantity) && quantity > 0 && quantity < 100) {
                        return quantity;
                    }
                }
            }
        }
        
        return null;
    }
    
    // Suggest corrections for misspelled medicine names
    suggestCorrections(input, maxSuggestions = 3) {
        const suggestions = [];
        const words = input.split(/\s+/);
        
        for (const word of words) {
            if (word.length < 3) continue;
            
            // Find similar medicine names
            for (const medicine of this.medicineNames) {
                const similarity = stringSimilarity.compareTwoStrings(word, medicine.name);
                if (similarity > 0.6) {
                    suggestions.push({
                        original: word,
                        suggested: medicine.original,
                        similarity: similarity,
                        method: 'string-similarity'
                    });
                }
                
                // Check if it's a common misspelling
                if (this.commonMisspellings.has(word)) {
                    suggestions.push({
                        original: word,
                        suggested: this.commonMisspellings.get(word),
                        similarity: 0.9,
                        method: 'misspelling-dictionary'
                    });
                }
            }
        }
        
        // Remove duplicates and sort by similarity
        const unique = Array.from(new Map(
            suggestions.map(s => [s.suggested, s])
        ).values());
        
        return unique
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, maxSuggestions);
    }
    
    // Process user message based on current state
    processUserMessage(message, currentState) {
        const intent = this.extractIntent(message);
        
        // Handle special cases based on conversation state
        if (currentState === 'idle') {
            if (intent.primary === 'ORDER') {
                if (intent.MEDICINE) {
                    return {
                        action: 'startOrderWithMedicine',
                        medicine: intent.MEDICINE,
                        quantity: intent.QUANTITY
                    };
                } else {
                    return { action: 'startOrder', intent };
                }
            } else if (intent.primary === 'SCAN') {
                return { action: 'openScanner', intent };
            }
        } else if (currentState === 'ordering') {
            if (intent.MEDICINE) {
                return { action: 'setMedicine', medicine: intent.MEDICINE };
            }
        } else if (currentState === 'quantity') {
            if (intent.QUANTITY) {
                return { action: 'setQuantity', quantity: intent.QUANTITY };
            }
        }
        
        return { action: 'processNormally', intent };
    }
}

module.exports = NLPService;