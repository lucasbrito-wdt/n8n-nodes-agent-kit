---
title: AgentKit Guardrails
date: 2026-04-30
status: approved
---

# AgentKit Guardrails

## Overview

Add inline guardrail support to the AgentKit node. Guardrails validate content at key points in the agent pipeline, returning a configurable fallback response when validation fails.

Check logic is ported directly from `@n8n/nodes-langchain/nodes/Guardrails/actions/checks` — pure functions with no external dependencies.

## Check Types

### Deterministic (no LLM)

| Type | Config fields | Logic |
|------|--------------|-------|
| `keywords` | `keywords` (comma-separated) | Unicode-aware word-boundary matching |
| `pii` | `piiEntities` (multi-select) | Regex patterns for 30+ entity types (email, credit card, SSN, IBAN, phone, etc.) |
| `secretKeys` | `secretKeysThreshold` (strict/balanced/permissive) | Shannon entropy + char diversity + common prefixes (`sk-`, `ghp_`, `Bearer`, etc.) |
| `urls` | `allowedUrls`, `allowedSchemes`, `blockUserinfo`, `allowSubdomains` | URL extraction + allowlist with CIDR and subdomain support |
| `customRegex` | `pattern` (regex string) | User-defined regex; match = fail |

### Model-based (LLM single-turn call)

| Type | Config fields | Built-in system prompt |
|------|--------------|----------------------|
| `jailbreak` | — | Detects bypass/manipulation attempts, prompt injection |
| `nsfw` | — | Sexual, hate speech, violence, drugs, gore, etc. |
| `topicalAlignment` | `businessScope` (text) | Checks if content stays within defined business scope |
| `customModel` | `prompt` (multiline) | User-defined evaluation prompt; expects `yes`/`no` — `yes` = fail |

## Data Model

Each guardrail entry in the `fixedCollection`:

| Field | Type | Visibility |
|-------|------|------------|
| `name` | string | always |
| `phase` | select: `pre` / `post` | always |
| `type` | select: one of 9 types above | always |
| `fallbackResponse` | string | always |
| `keywords` | string | only `type = keywords` |
| `piiEntities` | multiOptions | only `type = pii` |
| `secretKeysThreshold` | select: strict/balanced/permissive | only `type = secretKeys` |
| `allowedUrls` | string | only `type = urls` |
| `allowedSchemes` | string (comma-sep) | only `type = urls` |
| `blockUserinfo` | boolean | only `type = urls` |
| `allowSubdomains` | boolean | only `type = urls` |
| `businessScope` | string (multiline) | only `type = topicalAlignment` |
| `pattern` | string | only `type = customRegex` |
| `prompt` | string (multiline) | only `type = customModel` |

## Execution Flow

```
[input] → pre-guardrails → [LLM agentic loop] → post-guardrails → [output]
```

- **Pre phase:** runs against `userMessage` before any LLM call
- **Post phase:** runs against `finalResponse` after the tool-calling loop
- Guardrails in the same phase run sequentially; first failure short-circuits the rest
- On failure: returns `fallbackResponse` in the configured `outputField` — no error thrown, workflow continues

## Implementation

### File structure

```
nodes/AgentKit/
  AgentKit.node.ts       — node definition + execute (add guardrails fixedCollection + runGuardrails call)
  guardrails/
    index.ts             — runGuardrails() orchestrator
    types.ts             — GuardrailConfig interface, GuardrailResult type
    checks/
      keywords.ts        — ported from nodes-langchain
      pii.ts             — ported from nodes-langchain
      secretKeys.ts      — ported from nodes-langchain
      urls.ts            — ported from nodes-langchain
      model.ts           — shared LLM check helper (jailbreak, nsfw, topicalAlignment, customModel)
```

### `runGuardrails` signature

```typescript
async function runGuardrails(
  content: string,
  guardrails: GuardrailConfig[],
  phase: 'pre' | 'post',
  openai: OpenAI,
  model: string,
): Promise<string | null>
```

Returns `null` if all guardrails pass, or the `fallbackResponse` of the first failing guardrail.

### Changes to `AgentKit.node.ts`

1. Add `guardrails` `fixedCollection` to `properties` with `displayOptions` per field
2. Call `runGuardrails(..., 'pre')` on `userMessage` before the LLM loop; if non-null, push fallback and `continue`
3. Call `runGuardrails(..., 'post')` on `finalResponse`; if non-null, replace response with fallback
4. No changes to memory, tools, or skills logic

## Constraints

- No new npm dependencies — deterministic checks are pure functions, LLM checks reuse the existing OpenAI client
- No new n8n nodes
- Model-based checks use the same model as the agent (`modelOverride` or credential default)
- `customRegex` pattern is treated as case-insensitive by default (flag `i`)
