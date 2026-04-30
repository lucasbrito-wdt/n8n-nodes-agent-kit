interface CustomRegex { name: string; value: string }

function parseRegex(value: string): RegExp {
  const m = value.match(/^\/(.+)\/([gimsuy]*)$/);
  if (m) return new RegExp(m[1], m[2] || 'g');
  return new RegExp(value, 'g');
}

export const PII_PATTERNS: Record<string, RegExp> = {
  CREDIT_CARD: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
  CRYPTO: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,
  DATE_TIME: /\b(0[1-9]|1[0-2])[\/\-](0[1-9]|[12]\d|3[01])[\/\-](19|20)\d{2}\b/g,
  EMAIL_ADDRESS: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  IBAN_CODE: /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}([A-Z0-9]?){0,16}\b/g,
  IP_ADDRESS: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
  PHONE_NUMBER: /\b[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}\b/g,
  MEDICAL_LICENSE: /\b[A-Z]{2}\d{6}\b/g,
  US_BANK_NUMBER: /\b\d{8,17}\b/g,
  US_DRIVER_LICENSE: /\b[A-Z]\d{7}\b/g,
  US_ITIN: /\b9\d{2}-\d{2}-\d{4}\b/g,
  US_PASSPORT: /\b[A-Z]\d{8}\b/g,
  US_SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  UK_NHS: /\b\d{3} \d{3} \d{4}\b/g,
  UK_NINO: /\b[A-Z]{2}\d{6}[A-Z]\b/g,
  ES_NIF: /\b[A-Z]\d{8}\b/g,
  IT_FISCAL_CODE: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/g,
  PL_PESEL: /\b\d{11}\b/g,
  SG_NRIC_FIN: /\b[A-Z]\d{7}[A-Z]\b/g,
  AU_ABN: /\b\d{2} \d{3} \d{3} \d{3}\b/g,
  AU_TFN: /\b\d{9}\b/g,
  IN_PAN: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  IN_AADHAAR: /\b\d{4} \d{4} \d{4}\b/g,
  FI_PERSONAL_IDENTITY_CODE: /\b\d{6}[+-A]\d{3}[A-Z0-9]\b/g,
};

const ALL_ENTITIES = Object.keys(PII_PATTERNS);

export function piiCheck(
  text: string,
  entities: string[],
  customRegex: CustomRegex[] = [],
): boolean {
  const toCheck = entities.length > 0 ? entities : ALL_ENTITIES;

  for (const entity of toCheck) {
    const pattern = PII_PATTERNS[entity];
    if (!pattern) continue;
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    if (new RegExp(pattern.source, flags).test(text)) return true;
  }

  for (const cr of customRegex) {
    const parsed = parseRegex(cr.value);
    const flags = parsed.flags.includes('g') ? parsed.flags : parsed.flags + 'g';
    if (new RegExp(parsed.source, flags).test(text)) return true;
  }

  return false;
}
