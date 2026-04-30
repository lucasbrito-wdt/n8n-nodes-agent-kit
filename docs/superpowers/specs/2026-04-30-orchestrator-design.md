---
title: OrchestratorKit + SubAgentKit
date: 2026-04-30
status: approved
---

# OrchestratorKit + SubAgentKit

## Overview

Add a supervisor multi-agent system to the AgentKit package. An `OrchestratorKit` node acts as a supervisor LLM that delegates tasks to specialized `SubAgentKit` nodes via a custom `AiAgent` connection type. Each sub-agent is a full AgentKit-equivalent agent with its own model, memory, tools, skills, and guardrails.

## Architecture

```
[SubAgentKit] ──AiAgent──┐
[SubAgentKit] ──AiAgent──┼──► [OrchestratorKit] ──Main──► output
[McpGateway]  ──AiTool───┤
[AgentMemory] ──AiMemory─┘
```

## Connection Type

`'AiAgent'` — custom string literal used as connection type. Functional in n8n runtime; no custom UI icon but connections render correctly.

## SubAgent Interface

```typescript
interface SubAgent {
  name: string;
  description: string;
  call: (task: string, sessionId: string) => Promise<string>;
}
```

`call()` is a closure that captures the sub-agent's OpenAI client and runs a full LLM agentic loop (same logic as AgentKit).

## Nodes

### SubAgentKit

**Inputs:**
- `AiMemory` (optional) — sub-agent's own persistent memory
- `AiTool` (optional) — sub-agent's own MCP tools

**Output:** `AiAgent` connection (supply-data) → returns `{ response: SubAgent }`

**Credentials:** own OpenRouter credentials (can use a different model than the orchestrator)

**Properties:**
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Identifier used by orchestrator LLM (e.g. `researcher`) |
| `description` | string | Shown to orchestrator LLM to decide when to call this agent |
| `systemPrompt` | string | Base system prompt |
| `modelOverride` | string | Override credential model |
| `maxIterations` | number | Max tool-calling iterations (default 10) |
| `inlineSkills` | fixedCollection | Same as AgentKit inline skills |
| `guardrails` | fixedCollection | Same as AgentKit guardrails |

### OrchestratorKit

**Inputs:**
- `Main` — primary workflow input
- `AiAgent` — connected SubAgentKit nodes
- `AiMemory` (optional) — orchestrator's own memory
- `AiTool` (optional) — direct MCP tools for the orchestrator

**Output:** `Main`

**Credentials:** own OpenRouter credentials

**Properties:**
| Field | Type | Description |
|-------|------|-------------|
| `inputField` | string | Field in input JSON with user message |
| `sessionIdField` | string | Field for session identity |
| `systemPrompt` | string | Supervisor system prompt |
| `modelOverride` | string | Override credential model |
| `maxIterations` | number | Max supervisor iterations (default 20) |
| `outputField` | string | Output field name |

## Execution Flow

```
userMessage
    │
    ▼
[Orchestrator LLM] ── tool_call: researcher(task='...') ──► SubAgent.call(task, sessionId)
    │                                                              │ (full LLM loop)
    │◄───────────────── result string ─────────────────────────────┘
    ▼
[Orchestrator LLM] ── tool_call: writer(task='...') ──► SubAgent.call(task, sessionId)
    │                                                         │
    │◄─────────────── result string ───────────────────────────┘
    ▼
finalResponse
```

**Tool exposure to orchestrator LLM:**
```typescript
{
  type: 'function',
  function: {
    name: subAgent.name,
    description: subAgent.description,
    parameters: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task']
    }
  }
}
```

**Tool dispatch in orchestrator loop:**
- Tool is a sub-agent → `subAgent.call(args.task, sessionId)`
- Tool is McpTool → `tool.call(args)` (existing behavior)

Combined: `tools = [...subAgentsAsTools, ...mcpTools]`

## Code Reuse

Extract the AgentKit LLM loop into `utils/subAgentRunner.ts` — a pure function called by both AgentKit and SubAgentKit, eliminating duplication.

```typescript
// utils/subAgentRunner.ts
export async function runAgentLoop(params: {
  openai: OpenAI;
  model: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools?: McpTool[];
  maxIterations: number;
  guardrails: GuardrailConfig[];
}): Promise<{ response: string; usage: TokenUsage }>
```

AgentKit is refactored to call `runAgentLoop`. SubAgentKit's `call()` closure also calls `runAgentLoop`.

## File Structure

```
nodes/
  AgentKit/
    AgentKit.node.ts          — refactored to call runAgentLoop
    guardrails/               — existing (unchanged)
  SubAgentKit/
    SubAgentKit.node.ts       — supply-data node, returns SubAgent
  OrchestratorKit/
    OrchestratorKit.node.ts   — supervisor loop
utils/
  subAgentRunner.ts           — extracted LLM loop (new)
  skillParser.ts              — existing (unchanged)
```

## package.json changes

Add to `n8n.nodes` array:
- `dist/nodes/SubAgentKit/SubAgentKit.node.js`
- `dist/nodes/OrchestratorKit/OrchestratorKit.node.js`

## Constraints

- No new npm dependencies
- SubAgentKit has its own credentials — orchestrator cannot inject its client into sub-agents
- Sub-agents share sessionId with the orchestrator (passed via `call(task, sessionId)`) for memory continuity
- `subAgentRunner.ts` must not import anything from n8n-workflow (pure function, testable without n8n context)
