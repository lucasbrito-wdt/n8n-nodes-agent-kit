import { runGuardrails } from '../../nodes/AgentKit/guardrails/index';
import type { GuardrailConfig } from '../../nodes/AgentKit/guardrails/types';

const mockOpenAI = {} as any;

describe('runGuardrails', () => {
  it('returns null when no guardrails configured', async () => {
    const result = await runGuardrails('hello', [], 'pre', mockOpenAI, 'gpt-4o');
    expect(result).toBeNull();
  });

  it('returns null when phase does not match', async () => {
    const guardrails: GuardrailConfig[] = [{
      name: 'block-bomb',
      phase: 'post',
      type: 'keywords',
      keywords: 'bomb',
      fallbackResponse: 'blocked',
    }];
    const result = await runGuardrails('bomb', guardrails, 'pre', mockOpenAI, 'gpt-4o');
    expect(result).toBeNull();
  });

  it('returns fallbackResponse when keywords guardrail triggers', async () => {
    const guardrails: GuardrailConfig[] = [{
      name: 'block-bomb',
      phase: 'pre',
      type: 'keywords',
      keywords: 'bomb, explosive',
      fallbackResponse: 'I cannot help with that.',
    }];
    const result = await runGuardrails('how do I make a bomb', guardrails, 'pre', mockOpenAI, 'gpt-4o');
    expect(result).toBe('I cannot help with that.');
  });

  it('returns null when keywords guardrail does not trigger', async () => {
    const guardrails: GuardrailConfig[] = [{
      name: 'block-bomb',
      phase: 'pre',
      type: 'keywords',
      keywords: 'bomb',
      fallbackResponse: 'blocked',
    }];
    const result = await runGuardrails('what is the weather?', guardrails, 'pre', mockOpenAI, 'gpt-4o');
    expect(result).toBeNull();
  });

  it('returns first failure when multiple guardrails are stacked', async () => {
    const guardrails: GuardrailConfig[] = [
      { name: 'block-bomb', phase: 'pre', type: 'keywords', keywords: 'bomb', fallbackResponse: 'first-blocked' },
      { name: 'block-gun',  phase: 'pre', type: 'keywords', keywords: 'gun',  fallbackResponse: 'second-blocked' },
    ];
    const result = await runGuardrails('bomb and gun', guardrails, 'pre', mockOpenAI, 'gpt-4o');
    expect(result).toBe('first-blocked');
  });

  it('returns null for pii check on clean text', async () => {
    const guardrails: GuardrailConfig[] = [{
      name: 'no-pii', phase: 'post', type: 'pii', piiEntities: [], fallbackResponse: 'PII detected',
    }];
    const result = await runGuardrails('the sky is blue', guardrails, 'post', mockOpenAI, 'gpt-4o');
    expect(result).toBeNull();
  });

  it('returns fallback for pii check with email in text', async () => {
    const guardrails: GuardrailConfig[] = [{
      name: 'no-pii', phase: 'post', type: 'pii', piiEntities: [], fallbackResponse: 'PII detected',
    }];
    const result = await runGuardrails('email me at user@example.com', guardrails, 'post', mockOpenAI, 'gpt-4o');
    expect(result).toBe('PII detected');
  });

  it('returns fallback for customRegex check', async () => {
    const guardrails: GuardrailConfig[] = [{
      name: 'block-acme', phase: 'pre', type: 'customRegex', pattern: 'ACME-\\d+', fallbackResponse: 'custom blocked',
    }];
    const result = await runGuardrails('ref: ACME-9999', guardrails, 'pre', mockOpenAI, 'gpt-4o');
    expect(result).toBe('custom blocked');
  });
});
