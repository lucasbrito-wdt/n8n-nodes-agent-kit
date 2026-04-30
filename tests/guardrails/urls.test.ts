import { urlsCheck } from '../../nodes/AgentKit/guardrails/checks/urls';

describe('urlsCheck', () => {
  it('returns false when no URLs in text', () => {
    expect(urlsCheck('hello world', [], ['https', 'http'], false, false)).toBe(false);
  });

  it('returns false when URL is in allowlist', () => {
    expect(urlsCheck('visit https://example.com/page', ['example.com'], ['https', 'http'], false, false)).toBe(false);
  });

  it('returns true when URL is not in allowlist', () => {
    expect(urlsCheck('visit https://evil.com', ['example.com'], ['https', 'http'], false, false)).toBe(true);
  });

  it('returns true for blocked scheme (javascript:)', () => {
    expect(urlsCheck('click javascript:alert(1)', [], ['https'], false, false)).toBe(true);
  });

  it('allows subdomains when allowSubdomains is true', () => {
    expect(urlsCheck('visit https://sub.example.com', ['example.com'], ['https', 'http'], false, true)).toBe(false);
  });

  it('blocks subdomains when allowSubdomains is false', () => {
    expect(urlsCheck('visit https://sub.example.com', ['example.com'], ['https', 'http'], false, false)).toBe(true);
  });
});
