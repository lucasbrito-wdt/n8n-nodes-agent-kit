---
title: AgentKit Guardrails
date: 2026-04-30
status: approved
---

# AgentKit Guardrails

## Overview

Add inline guardrail support to the AgentKit node. Guardrails validate content at key points in the agent pipeline, returning a configurable fallback response when validation fails.

## Data Model

Each guardrail is defined inline via a `fixedCollection` in the node UI:

| Field | Type | Visibility |
|-------|------|------------|
| `name` | string | always |
| `phase` | select: `pre` / `post` | always |
| `type` | select: `deterministic` / `model` | always |
| `pattern` | string (regex) | only when `type = deterministic` |
| `prompt` | string (multiline) | only when `type = model` |
| `fallbackResponse` | string | always |

### Deterministic guardrail

Tests a regex pattern against the content. A match means the guardrail **fails**.

Example: pattern `\b\d{3}-\d{2}-\d{4}\b` blocks SSN-like strings.

### Model-based guardrail

Sends a prompt + content to the LLM and expects a `yes` or `no` response. `yes` means the guardrail **fails**.

Example prompt: `"Does this text contain personally identifiable information? Answer only yes or no."`

The model call reuses the existing OpenAI client instance with no tools and no history — lightweight single-turn call.

## Execution Flow

```
[input] → pre-guardrails → [LLM agentic loop] → post-guardrails → [output]
```

- **Pre phase:** runs against `userMessage` before any LLM call
- **Post phase:** runs against `finalResponse` after the tool-calling loop
- Guardrails in the same phase run sequentially; the first failure short-circuits the rest
- On failure: the pipeline stops for that item and returns `fallbackResponse` in the configured `outputField`
- The workflow continues normally (no error thrown)

## Implementation

### New function: `runGuardrails`

```typescript
async function runGuardrails(
  content: string,
  guardrails: Guardrail[],
  phase: 'pre' | 'post',
  openai: OpenAI,
  model: string,
): Promise<string | null>
```

Returns `null` if all guardrails pass, or the `fallbackResponse` string of the first failing guardrail.

### Changes to `AgentKit.node.ts`

1. Add `Guardrail` interface
2. Add `guardrails` `fixedCollection` to `properties` with `displayOptions` for conditional fields
3. Call `runGuardrails(..., 'pre')` on `userMessage` before the LLM loop
4. Call `runGuardrails(..., 'post')` on `finalResponse` before pushing to results
5. No changes to memory, tools, or skills logic

## Constraints

- No new dependencies
- No new nodes
- Model-based guardrails use the same model as the agent (or `modelOverride`)
- Pattern field accepts a plain regex string (no flags); matched case-insensitively by default
