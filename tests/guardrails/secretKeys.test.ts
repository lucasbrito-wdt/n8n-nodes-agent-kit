import { secretKeysCheck } from '../../nodes/AgentKit/guardrails/checks/secretKeys';

describe('secretKeysCheck', () => {
  it('detects sk- prefixed key', () => {
    expect(secretKeysCheck('my key is sk-abc123XYZ456def789GHI', 'balanced')).toBe(true);
  });

  it('detects GitHub token prefix ghp_', () => {
    expect(secretKeysCheck('token ghp_abcdefghijklmnopqrstuvwxyz123', 'balanced')).toBe(true);
  });

  it('detects Bearer token', () => {
    expect(secretKeysCheck('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'balanced')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(secretKeysCheck('the weather is sunny today', 'balanced')).toBe(false);
  });

  it('strict mode catches shorter keys', () => {
    expect(secretKeysCheck('key-Ab1Cd2Ef3G', 'strict')).toBe(true);
  });

  it('permissive mode ignores short keys', () => {
    expect(secretKeysCheck('key-Ab1Cd2Ef3G', 'permissive')).toBe(false);
  });
});
