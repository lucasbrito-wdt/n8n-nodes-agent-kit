import { piiCheck, PII_PATTERNS } from '../../nodes/AgentKit/guardrails/checks/pii';

describe('piiCheck', () => {
  it('detects email address', () => {
    expect(piiCheck('contact me at user@example.com please', [])).toBe(true);
  });

  it('detects US SSN', () => {
    expect(piiCheck('my ssn is 123-45-6789', [])).toBe(true);
  });

  it('detects credit card', () => {
    expect(piiCheck('card 4111 1111 1111 1111', [])).toBe(true);
  });

  it('returns false for clean text', () => {
    expect(piiCheck('the weather is nice today', [])).toBe(false);
  });

  it('respects entity filter — only checks selected entities', () => {
    expect(piiCheck('user@example.com', ['US_SSN'])).toBe(false);
  });

  it('detects custom regex', () => {
    expect(piiCheck('ref: ACME-12345', [], [{ name: 'ACME_ID', value: '/ACME-\\d+/' }])).toBe(true);
  });

  it('exports PII_PATTERNS with at least 10 entity keys', () => {
    expect(Object.keys(PII_PATTERNS).length).toBeGreaterThanOrEqual(10);
  });
});
