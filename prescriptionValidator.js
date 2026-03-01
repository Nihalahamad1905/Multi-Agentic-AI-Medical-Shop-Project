const Tesseract = require('tesseract.js');
const fs = require('fs');

class PrescriptionValidator {
    constructor() {
        this.name = 'PrescriptionValidator';
        // Keywords that indicate a valid prescription
        this.doctorKeywords = ['dr', 'doctor', 'physician', 'mbbs', 'md', 'clinic', 'hospital', 'medical', 'practitioner'];
        this.prescriptionKeywords = ['rx', 'prescription', 'take', 'dose', 'dosage', 'tablet', 'capsule', 'mg', 'ml', 'daily', 'morning', 'evening', 'night', 'bid', 'tid', 'qid', 'sos', 'stat'];
        
        // Common medicine name patterns for better matching
        this.medicineSuffixes = ['cin', 'mycin', 'cycline', 'prazole', 'sartan', 'lukast', 'navir', 'vir', 'zole', 'mine', 'drine', 'pam', 'lam', 'pine', 'zepam', 'done', 'line', 'xetine', 'amine', 'profen', 'xicam', 'coxib', 'formin', 'glitazone', 'vastatin'];
    }

    async validatePrescription(imagePath, medicineName) {
        try {
            console.log('🔍 Validating prescription for medicine:', medicineName);
            
            // Check if file exists
            if (!fs.existsSync(imagePath)) {
                console.error('❌ Prescription file not found:', imagePath);
                return {
                    valid: false,
                    message: 'Prescription image file not found',
                    confidence: 0,
                    agent: this.name
                };
            }

            // Check file size
            const stats = fs.statSync(imagePath);
            if (stats.size === 0) {
                return {
                    valid: false,
                    message: 'Prescription file is empty',
                    confidence: 0,
                    agent: this.name
                };
            }

            console.log(`📸 File size: ${stats.size} bytes`);

            // Perform OCR on prescription image
            console.log('📸 Running OCR on prescription...');
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

            if (!text || text.trim().length === 0) {
                return {
                    valid: false,
                    message: 'No text could be extracted from the prescription. Please ensure the image is clear.',
                    confidence: 0,
                    agent: this.name
                };
            }

            const extractedText = text
                .toLowerCase()
                .replace(/[^a-z0-9\s\-/.]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            console.log('📝 Prescription text extracted:', extractedText.substring(0, 500));

            // Validate the prescription - STRICT MEDICINE MATCHING
            const validationResult = this.analyzePrescription(extractedText, medicineName.toLowerCase());
            
            return {
                valid: validationResult.valid,
                message: validationResult.message,
                confidence: validationResult.confidence,
                details: validationResult.details,
                agent: this.name
            };

        } catch (error) {
            console.error('❌ Prescription validation error:', error);
            return {
                valid: false,
                message: 'Error analyzing prescription: ' + error.message,
                confidence: 0,
                agent: this.name
            };
        }
    }

    analyzePrescription(text, medicineName) {
        const details = {
            hasDoctorInfo: false,
            hasPrescriptionFormat: false,
            hasExactMedicineMatch: false,
            hasPartialMedicineMatch: false,
            hasDosage: false,
            hasDate: false,
            hasSignature: false,
            matchedMedicine: null
        };

        let score = 0;
        const maxScore = 7; // Increased max score

        // Check for doctor information
        if (this.doctorKeywords.some(keyword => text.includes(keyword))) {
            details.hasDoctorInfo = true;
            score++;
        }

        // Check for prescription format
        if (this.prescriptionKeywords.some(keyword => text.includes(keyword))) {
            details.hasPrescriptionFormat = true;
            score++;
        }

        // STRICT MEDICINE MATCHING - This is the most important part
        const medicineMatch = this.findMedicineInText(text, medicineName);
        
        if (medicineMatch.exact) {
            details.hasExactMedicineMatch = true;
            details.matchedMedicine = medicineName;
            score += 3; // High weight for exact match
            console.log(`✅ Exact medicine match found: ${medicineName}`);
        } else if (medicineMatch.partial) {
            details.hasPartialMedicineMatch = true;
            details.matchedMedicine = medicineMatch.partialMatch;
            score += 1; // Low weight for partial match
            console.log(`⚠️ Partial medicine match found: ${medicineMatch.partialMatch} for ${medicineName}`);
        } else {
            console.log(`❌ No medicine match found for: ${medicineName}`);
            // If no medicine match at all, fail immediately with low confidence
            return {
                valid: false,
                message: `❌ Prescription does not contain the medicine "${medicineName}". Please ensure you upload the correct prescription.`,
                confidence: 0,
                details
            };
        }

        // Check for dosage information (optional but good to have)
        const dosagePattern = /\d+\s*(mg|ml|mcg|gram|tablet|capsule|drop|tsp|tab|caps)/gi;
        if (dosagePattern.test(text)) {
            details.hasDosage = true;
            score++;
        }

        // Check for date
        const datePattern = /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2}/;
        if (datePattern.test(text)) {
            details.hasDate = true;
            score++;
        }

        // Check for signature or doctor's name
        if (text.includes('sign') || text.includes('dr.') || /dr\s+[a-z]+/.test(text)) {
            details.hasSignature = true;
            score++;
        }

        // Calculate confidence percentage
        const confidence = Math.min(100, Math.round((score / maxScore) * 100));

        // Determine validity - Medicine match is mandatory
        let valid = false;
        let message = '';

        if (details.hasExactMedicineMatch) {
            if (confidence >= 60) {
                valid = true;
                message = `✅ Valid prescription for ${medicineName} found with ${confidence}% confidence`;
            } else {
                valid = true; // Still accept if medicine matches
                message = `⚠️ Prescription for ${medicineName} verified but missing some details (${confidence}% confidence)`;
            }
        } else if (details.hasPartialMedicineMatch) {
            // Partial match - warn but accept
            valid = true;
            message = `⚠️ Prescription contains "${details.matchedMedicine}" which partially matches "${medicineName}". Please verify.`;
        } else {
            valid = false;
            message = `❌ Prescription does not contain "${medicineName}". Please upload the correct prescription.`;
        }

        return {
            valid,
            message,
            confidence,
            details
        };
    }

    findMedicineInText(text, medicineName) {
        const result = {
            exact: false,
            partial: false,
            partialMatch: null
        };

        // Clean the medicine name
        const cleanMedicineName = medicineName.toLowerCase().trim();
        
        // 1. Check for exact match (whole word or phrase)
        const exactMatchPattern = new RegExp(`\\b${cleanMedicineName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (exactMatchPattern.test(text)) {
            result.exact = true;
            return result;
        }

        // 2. Check for medicine without dosage/strength (e.g., "paracetamol" in "paracetamol 500mg")
        const baseName = cleanMedicineName.replace(/\s*\d+\s*(mg|ml|mcg|gram|tablet).*$/, '').trim();
        if (baseName !== cleanMedicineName) {
            const basePattern = new RegExp(`\\b${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (basePattern.test(text)) {
                result.exact = true;
                return result;
            }
        }

        // 3. Check for partial matches (for longer medicine names)
        const words = cleanMedicineName.split(/\s+/);
        for (const word of words) {
            if (word.length <= 3) continue; // Skip short words
            
            // Look for this word in the text
            const wordPattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (wordPattern.test(text)) {
                result.partial = true;
                result.partialMatch = word;
                return result;
            }
            
            // Check for common misspellings or variations (first 4+ chars)
            if (word.length >= 5) {
                const prefix = word.substring(0, 5);
                const prefixPattern = new RegExp(`\\b${prefix}[a-z]*\\b`, 'i');
                if (prefixPattern.test(text)) {
                    result.partial = true;
                    result.partialMatch = prefix + '...';
                    return result;
                }
            }
        }

        // 4. Check for medicine with common suffixes
        for (const suffix of this.medicineSuffixes) {
            if (cleanMedicineName.includes(suffix)) {
                // Look for any word ending with this suffix
                const suffixPattern = new RegExp(`\\b[a-z]+${suffix}\\b`, 'i');
                const matches = text.match(suffixPattern);
                if (matches) {
                    result.partial = true;
                    result.partialMatch = matches[0];
                    return result;
                }
            }
        }

        return result;
    }
}

module.exports = PrescriptionValidator;