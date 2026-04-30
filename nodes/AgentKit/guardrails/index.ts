import type OpenAI from 'openai';
import type { GuardrailConfig } from './types';
import { keywordsCheck } from './checks/keywords';
import { piiCheck } from './checks/pii';
import { secretKeysCheck } from './checks/secretKeys';
import { urlsCheck } from './checks/urls';
import { modelCheck, JAILBREAK_PROMPT, NSFW_PROMPT, topicalAlignmentPrompt } from './checks/model';

async function runCheck(
  content: string,
  g: GuardrailConfig,
  openai: OpenAI,
  model: string,
): Promise<boolean> {
  switch (g.type) {
    case 'keywords': {
      const kws = (g.keywords ?? '').split(',').map((k) => k.trim()).filter(Boolean);
      return keywordsCheck(content, kws);
    }
    case 'pii':
      return piiCheck(content, g.piiEntities ?? []);
    case 'secretKeys':
      return secretKeysCheck(content, g.secretKeysThreshold ?? 'balanced');
    case 'urls': {
      const allowedUrls = (g.allowedUrls ?? '').split('\n').map((u) => u.trim()).filter(Boolean);
      const allowedSchemes = (g.allowedSchemes ?? 'https,http').split(',').map((s) => s.trim()).filter(Boolean);
      return urlsCheck(content, allowedUrls, allowedSchemes, g.blockUserinfo ?? false, g.allowSubdomains ?? false);
    }
    case 'jailbreak':
      return modelCheck(content, JAILBREAK_PROMPT, openai, model);
    case 'nsfw':
      return modelCheck(content, NSFW_PROMPT, openai, model);
    case 'topicalAlignment':
      return modelCheck(content, topicalAlignmentPrompt(g.businessScope ?? ''), openai, model);
    case 'customRegex': {
      if (!g.pattern) return false;
      return new RegExp(g.pattern, 'i').test(content);
    }
    case 'customModel':
      return modelCheck(content, g.prompt ?? '', openai, model);
    default:
      return false;
  }
}

export async function runGuardrails(
  content: string,
  guardrails: GuardrailConfig[],
  phase: 'pre' | 'post',
  openai: OpenAI,
  model: string,
): Promise<string | null> {
  const active = guardrails.filter((g) => g.phase === phase);
  for (const g of active) {
    if (await runCheck(content, g, openai, model)) {
      return g.fallbackResponse;
    }
  }
  return null;
}
