import type OpenAI from 'openai';

export type GuardrailType =
  | 'keywords'
  | 'pii'
  | 'secretKeys'
  | 'urls'
  | 'jailbreak'
  | 'nsfw'
  | 'topicalAlignment'
  | 'customRegex'
  | 'customModel';

export interface GuardrailConfig {
  name: string;
  phase: 'pre' | 'post';
  type: GuardrailType;
  fallbackResponse: string;
  // keywords
  keywords?: string;
  // pii
  piiEntities?: string[];
  // secretKeys
  secretKeysThreshold?: 'strict' | 'balanced' | 'permissive';
  // urls
  allowedUrls?: string;
  allowedSchemes?: string;
  blockUserinfo?: boolean;
  allowSubdomains?: boolean;
  // topicalAlignment
  businessScope?: string;
  // customRegex
  pattern?: string;
  // customModel
  prompt?: string;
}

export interface CheckResult {
  triggered: boolean;
}

export interface LLMClient {
  openai: OpenAI;
  model: string;
}
