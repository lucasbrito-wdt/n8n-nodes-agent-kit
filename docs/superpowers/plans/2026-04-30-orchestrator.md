# OrchestratorKit + SubAgentKit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a supervisor multi-agent system: `SubAgentKit` supply-data nodes connect to an `OrchestratorKit` supervisor via a custom `AiAgent` connection type, each sub-agent running a full LLM loop.

**Architecture:** Extract the AgentKit LLM loop into `utils/subAgentRunner.ts` (pure function, no n8n imports). `SubAgentKit` implements `supplyData()` returning a `SubAgent` object whose `call()` closure uses `runAgentLoop`. `OrchestratorKit` wraps sub-agents as McpTools so the existing supervisor loop runs unchanged.

**Tech Stack:** TypeScript strict, OpenAI SDK, Jest + ts-jest, n8n-workflow types

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `utils/subAgentRunner.ts` | Pure LLM loop function — no n8n imports |
| Modify | `nodes/AgentKit/AgentKit.node.ts` | Replace inline loop with `runAgentLoop` call |
| Create | `nodes/SubAgentKit/SubAgentKit.node.ts` | supply-data node, exports `SubAgent`, returns closure |
| Create | `nodes/OrchestratorKit/OrchestratorKit.node.ts` | Supervisor node, reads `AiAgent` connections |
| Modify | `package.json` | Register two new nodes in `n8n.nodes` array |
| Create | `tests/subAgentRunner.test.ts` | Unit tests for `runAgentLoop` |
| Create | `tests/orchestratorKit.test.ts` | Unit tests for supervisor loop with mock sub-agents |

---

## Task 1: Extract `runAgentLoop` to `utils/subAgentRunner.ts`

**Files:**
- Create: `utils/subAgentRunner.ts`
- Create: `tests/subAgentRunner.test.ts`
- Modify: `nodes/AgentKit/AgentKit.node.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/subAgentRunner.test.ts
import { runAgentLoop } from '../utils/subAgentRunner';
import type { McpTool } from '../nodes/McpGateway/McpGateway.node';

function makeOpenAI(replies: string[]): any {
  let call = 0;
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: replies[call++] ?? '' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      },
    },
  };
}

function makeToolCallOpenAI(toolName: string, toolArgs: string, finalReply: string): any {
  let call = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          if (call++ === 0) {
            return {
              choices: [{
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'tc1', type: 'function', function: { name: toolName, arguments: toolArgs } }],
                },
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          return {
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: finalReply } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };
}

describe('runAgentLoop', () => {
  it('returns the LLM reply and usage', async () => {
    const openai = makeOpenAI(['Hello!']);
    const result = await runAgentLoop({
      openai,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxIterations: 5,
    });
    expect(result.response).toBe('Hello!');
    expect(result.usage.iterations).toBe(1);
    expect(result.usage.total_tokens).toBe(15);
  });

  it('returns empty string if LLM returns no content', async () => {
    const openai = makeOpenAI(['']);
    const result = await runAgentLoop({
      openai,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxIterations: 5,
    });
    expect(result.response).toBe('');
  });

  it('calls a tool and returns the final reply', async () => {
    const tool: McpTool = {
      name: 'get_weather',
      description: 'Get weather',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      call: async () => 'sunny',
    };
    const openai = makeToolCallOpenAI('get_weather', '{"city":"Paris"}', 'The weather is sunny.');
    const result = await runAgentLoop({
      openai,
      model: 'test-model',
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      tools: [tool],
      maxIterations: 5,
    });
    expect(result.response).toBe('The weather is sunny.');
    expect(result.usage.iterations).toBe(2);
  });

  it('returns tool-not-found message when tool is missing', async () => {
    const openai = makeToolCallOpenAI('missing_tool', '{}', 'ok');
    const result = await runAgentLoop({
      openai,
      model: 'test-model',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      maxIterations: 5,
    });
    expect(result.response).toBe('ok');
  });

  it('stops after maxIterations', async () => {
    const openai = makeToolCallOpenAI('loop_tool', '{}', 'never');
    const tool: McpTool = {
      name: 'loop_tool',
      description: 'loops',
      inputSchema: {},
      call: async () => 'result',
    };
    const result = await runAgentLoop({
      openai,
      model: 'test-model',
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      maxIterations: 1,
    });
    expect(result.usage.iterations).toBe(1);
    expect(result.response).toBe('');
  });
});
```

- [ ] **Step 2: Run test — confirm FAIL with "Cannot find module"**

```bash
cd /mnt/dev/n8n-nodes-agent-kit && npx jest tests/subAgentRunner.test.ts --no-coverage 2>&1 | tail -5
```

- [ ] **Step 3: Create `utils/subAgentRunner.ts`**

```typescript
// utils/subAgentRunner.ts
import type OpenAI from 'openai';
import type { McpTool } from '../nodes/McpGateway/McpGateway.node';

export interface AgentLoopParams {
  openai: OpenAI;
  model: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools: McpTool[];
  maxIterations: number;
}

export interface AgentLoopResult {
  response: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; iterations: number };
}

function toolsToOpenAI(tools: McpTool[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const { openai, model, tools, maxIterations } = params;
  const messages = [...params.messages];
  const openaiTools = tools.length > 0 ? toolsToOpenAI(tools) : undefined;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0 };
  let finalResponse = '';

  while (usage.iterations < Math.max(1, maxIterations)) {
    usage.iterations++;
    const response = await openai.chat.completions.create({
      model,
      messages,
      ...(openaiTools ? { tools: openaiTools, tool_choice: 'auto' } : {}),
    });

    if (response.usage) {
      usage.prompt_tokens += response.usage.prompt_tokens;
      usage.completion_tokens += response.usage.completion_tokens;
      usage.total_tokens += response.usage.total_tokens;
    }

    const choice = response.choices[0];
    if (!choice) break;

    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (choice.finish_reason === 'tool_calls' && assistantMsg.tool_calls) {
      for (const toolCall of assistantMsg.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const fnCall = toolCall as OpenAI.Chat.ChatCompletionMessageToolCall & {
          function: { name: string; arguments: string };
        };
        const tool = tools.find((t) => t.name === fnCall.function.name);
        let toolResult: string;
        try {
          const args = JSON.parse(fnCall.function.arguments || '{}') as Record<string, unknown>;
          toolResult = tool ? await tool.call(args) : `Tool "${fnCall.function.name}" not found`;
        } catch (err) {
          toolResult = `Error: ${(err as Error).message}`;
        }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
      }
      continue;
    }

    finalResponse = assistantMsg.content ?? '';
    break;
  }

  return { response: finalResponse, usage };
}
```

- [ ] **Step 4: Run test — confirm 5 PASS**

```bash
cd /mnt/dev/n8n-nodes-agent-kit && npx jest tests/subAgentRunner.test.ts --no-coverage 2>&1 | tail -10
```

- [ ] **Step 5: Refactor `nodes/AgentKit/AgentKit.node.ts` to use `runAgentLoop`**

Add import at the top of the file, after the existing imports:

```typescript
import { runAgentLoop } from '../../utils/subAgentRunner';
```

Remove these two helper functions from `AgentKit.node.ts` (they are now in `subAgentRunner.ts`):

```typescript
// DELETE this function:
function toolsToOpenAI(tools: McpTool[]): OpenAI.Chat.ChatCompletionTool[] { ... }
```

Replace the entire LLM loop block (from `const openaiTools = ...` through the closing `}` of the while loop and NodeOperationError throw) with:

```typescript
      const loopResult = await runAgentLoop({
        openai,
        model,
        messages,
        tools,
        maxIterations,
      });

      let finalResponse = loopResult.response;
      const usage = loopResult.usage;

      if (!finalResponse) {
        throw new NodeOperationError(
          this.getNode(),
          `Agent did not produce a response after ${maxIterations} iteration(s). The model may be stuck in a tool-calling loop.`,
          { itemIndex: i },
        );
      }
```

- [ ] **Step 6: Run all existing tests — confirm still passing**

```bash
cd /mnt/dev/n8n-nodes-agent-kit && npx jest --no-coverage 2>&1 | tail -10
```

Expected: all tests PASS (count ≥ 67 now with new subAgentRunner tests)

- [ ] **Step 7: Fix usage reference in results push**

After refactor, the results push block uses `usage` and `iteration`. Update the output object to use `usage.iterations` instead of the old `iteration` variable:

```typescript
      results.push({
        json: {
          ...cleanJson,
          [outputField]: finalResponse,
          usage: { ...usage, model },
        } as INodeExecutionData['json'],
        pairedItem: { item: i },
      });
```

- [ ] **Step 8: Commit**

```bash
git add utils/subAgentRunner.ts tests/subAgentRunner.test.ts nodes/AgentKit/AgentKit.node.ts
git commit -m "refactor(agent): extract LLM loop to subAgentRunner utility"
```

---

## Task 2: `SubAgent` type + `SubAgentKit` supply-data node

**Files:**
- Create: `nodes/SubAgentKit/SubAgentKit.node.ts`

No separate test file — the `call()` closure is tested indirectly via `runAgentLoop` tests. A smoke test is included in Task 3.

- [ ] **Step 1: Create `nodes/SubAgentKit/SubAgentKit.node.ts`**

```typescript
// nodes/SubAgentKit/SubAgentKit.node.ts
import type {
  INodeType,
  INodeTypeDescription,
  ISupplyDataFunctions,
  SupplyData,
} from 'n8n-workflow';
import OpenAI from 'openai';
import { runAgentLoop } from '../../utils/subAgentRunner';
import { runGuardrails } from '../AgentKit/guardrails/index';
import type { GuardrailConfig } from '../AgentKit/guardrails/types';
import { composeSystemPrompt } from '../../utils/skillParser';
import type { Skill } from '../../utils/skillParser';

export interface SubAgent {
  name: string;
  description: string;
  call: (task: string, sessionId: string) => Promise<string>;
}

export class SubAgentKit implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Sub Agent Kit',
    name: 'subAgentKit',
    icon: 'fa:robot',
    group: ['transform'],
    version: 1,
    description: 'A specialized agent that can be connected to an OrchestratorKit as a sub-agent.',
    defaults: { name: 'Sub Agent Kit' },
    inputs: [],
    outputs: [{ type: 'AiAgent' as any }],
    outputNames: ['agent'],
    credentials: [{ name: 'openRouterApi', required: true }],
    properties: [
      {
        displayName: 'Agent Name',
        name: 'agentName',
        type: 'string',
        default: 'specialist',
        description: 'Identifier used by the orchestrator LLM to call this agent (no spaces, e.g. researcher).',
      },
      {
        displayName: 'Agent Description',
        name: 'agentDescription',
        type: 'string',
        default: 'A specialized agent.',
        description: 'Shown to the orchestrator LLM to decide when to delegate to this agent.',
      },
      {
        displayName: 'System Prompt',
        name: 'systemPrompt',
        type: 'string',
        typeOptions: { rows: 6 },
        default: 'You are a helpful specialist.',
      },
      {
        displayName: 'Model Override',
        name: 'modelOverride',
        type: 'string',
        default: '',
        description: 'Override the model from credentials (e.g. anthropic/claude-sonnet-4-5).',
      },
      {
        displayName: 'Max Iterations',
        name: 'maxIterations',
        type: 'number',
        default: 10,
      },
      {
        displayName: 'Inline Skills',
        name: 'inlineSkills',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        options: [
          {
            name: 'skill',
            displayName: 'Skill',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              { displayName: 'Description', name: 'description', type: 'string', default: '' },
              {
                displayName: 'Content',
                name: 'content',
                type: 'string',
                typeOptions: { rows: 6 },
                default: '',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Guardrails',
        name: 'guardrails',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        options: [
          {
            name: 'guardrail',
            displayName: 'Guardrail',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              {
                displayName: 'Phase',
                name: 'phase',
                type: 'options',
                options: [
                  { name: 'Pre (validate input)', value: 'pre' },
                  { name: 'Post (validate output)', value: 'post' },
                ],
                default: 'pre',
              },
              {
                displayName: 'Check Type',
                name: 'type',
                type: 'options',
                options: [
                  { name: 'Keywords', value: 'keywords' },
                  { name: 'PII Detection', value: 'pii' },
                  { name: 'Secret Keys', value: 'secretKeys' },
                  { name: 'Custom Regex', value: 'customRegex' },
                  { name: 'Jailbreak Detection', value: 'jailbreak' },
                  { name: 'NSFW Content', value: 'nsfw' },
                  { name: 'Custom Model Prompt', value: 'customModel' },
                ],
                default: 'keywords',
              },
              {
                displayName: 'Fallback Response',
                name: 'fallbackResponse',
                type: 'string',
                default: 'I cannot respond to that.',
              },
              {
                displayName: 'Keywords',
                name: 'keywords',
                type: 'string',
                default: '',
                displayOptions: { show: { type: ['keywords'] } },
              },
              {
                displayName: 'Pattern',
                name: 'pattern',
                type: 'string',
                default: '',
                displayOptions: { show: { type: ['customRegex'] } },
              },
              {
                displayName: 'Evaluation Prompt',
                name: 'prompt',
                type: 'string',
                typeOptions: { rows: 4 },
                default: '',
                displayOptions: { show: { type: ['customModel'] } },
              },
            ],
          },
        ],
      },
    ],
  };

  async supplyData(this: ISupplyDataFunctions): Promise<SupplyData> {
    const creds = await this.getCredentials('openRouterApi');
    const openai = new OpenAI({
      apiKey: creds.apiKey as string,
      baseURL: (creds.baseUrl as string) || 'https://openrouter.ai/api/v1',
      defaultHeaders: creds.httpReferer ? { 'X-Title': creds.httpReferer as string } : undefined,
    });

    const agentName = this.getNodeParameter('agentName', 0) as string;
    const agentDescription = this.getNodeParameter('agentDescription', 0) as string;
    const baseSystemPrompt = this.getNodeParameter('systemPrompt', 0) as string;
    const modelOverride = this.getNodeParameter('modelOverride', 0, '') as string;
    const maxIterations = this.getNodeParameter('maxIterations', 0, 10) as number;
    const model = modelOverride || (creds.model as string) || 'qwen/qwen3-235b-a22b';

    const inlineSkillsRaw = this.getNodeParameter('inlineSkills', 0, { skill: [] }) as {
      skill: Array<{ name: string; description: string; content: string }>;
    };
    const skills: Skill[] = (inlineSkillsRaw.skill ?? [])
      .filter((s) => s.name)
      .map((s) => ({ name: s.name, description: s.description, content: s.content, tags: [] }));

    const systemPrompt = composeSystemPrompt(baseSystemPrompt, skills);

    const guardrailsRaw = this.getNodeParameter('guardrails', 0, { guardrail: [] }) as {
      guardrail: Array<{
        name: string; phase: string; type: string; fallbackResponse: string;
        keywords?: string; pattern?: string; prompt?: string;
      }>;
    };
    const guardrailConfigs: GuardrailConfig[] = (guardrailsRaw.guardrail ?? []).map((g) => ({
      name: g.name,
      phase: g.phase as 'pre' | 'post',
      type: g.type as GuardrailConfig['type'],
      fallbackResponse: g.fallbackResponse,
      keywords: g.keywords,
      pattern: g.pattern,
      prompt: g.prompt,
    }));

    // Per-session in-memory history
    const sessionHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();

    const subAgent: SubAgent = {
      name: agentName,
      description: agentDescription,
      call: async (task: string, sessionId: string) => {
        const preBlock = await runGuardrails(task, guardrailConfigs, 'pre', openai, model);
        if (preBlock !== null) return preBlock;

        const history = sessionHistory.get(sessionId) ?? [];
        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: task },
        ];

        const result = await runAgentLoop({ openai, model, messages, tools: [], maxIterations });
        const response = result.response || 'No response generated.';

        const postBlock = await runGuardrails(response, guardrailConfigs, 'post', openai, model);
        const finalResponse = postBlock ?? response;

        history.push({ role: 'user', content: task });
        history.push({ role: 'assistant', content: finalResponse });
        sessionHistory.set(sessionId, history);

        return finalResponse;
      },
    };

    return { response: subAgent };
  }
}
```

- [ ] **Step 2: Check that `composeSystemPrompt` is exported from `utils/skillParser.ts`**

```bash
grep -n 'composeSystemPrompt\|export' /mnt/dev/n8n-nodes-agent-kit/utils/skillParser.ts | head -20
```

If `composeSystemPrompt` is NOT exported from `utils/skillParser.ts` (it may be a private function in `AgentKit.node.ts`), move it:

Extract the function from `nodes/AgentKit/AgentKit.node.ts`:

```typescript
// This function currently lives in AgentKit.node.ts — move it to utils/skillParser.ts
export function composeSystemPrompt(base: string, skills: Skill[]): string {
  if (skills.length === 0) return base;
  const skillsBlock = skills
    .map((s) => `## Skill: ${s.name}\n${s.content}`)
    .join('\n\n');
  return `${base}\n\n---\n\n${skillsBlock}`;
}
```

And update the import in `AgentKit.node.ts`:
```typescript
import { composeSystemPrompt } from '../../utils/skillParser';
```

Remove the function definition from `AgentKit.node.ts`.

- [ ] **Step 3: Run full test suite — confirm still passing**

```bash
cd /mnt/dev/n8n-nodes-agent-kit && npx jest --no-coverage 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add nodes/SubAgentKit/SubAgentKit.node.ts nodes/AgentKit/AgentKit.node.ts utils/skillParser.ts
git commit -m "feat(subagent): add SubAgentKit supply-data node"
```

---

## Task 3: `OrchestratorKit` supervisor node + tests

**Files:**
- Create: `nodes/OrchestratorKit/OrchestratorKit.node.ts`
- Create: `tests/orchestratorKit.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/orchestratorKit.test.ts
import { runAgentLoop } from '../utils/subAgentRunner';
import type { SubAgent } from '../nodes/SubAgentKit/SubAgentKit.node';
import type { McpTool } from '../nodes/McpGateway/McpGateway.node';

// Test helper: wraps sub-agents as McpTools (same logic as OrchestratorKit)
function subAgentsToTools(subAgents: SubAgent[], sessionId: string): McpTool[] {
  return subAgents.map((agent) => ({
    name: agent.name,
    description: agent.description,
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
    },
    call: async (args: Record<string, unknown>) => agent.call(String(args.task ?? ''), sessionId),
  }));
}

describe('Orchestrator supervisor pattern', () => {
  it('calls a sub-agent tool and returns the final response', async () => {
    const researcher: SubAgent = {
      name: 'researcher',
      description: 'Does research',
      call: async (task) => `Research result for: ${task}`,
    };

    let toolCallCount = 0;
    const openai: any = {
      chat: {
        completions: {
          create: async ({ messages }: any) => {
            toolCallCount++;
            // First call: delegate to researcher
            if (toolCallCount === 1) {
              return {
                choices: [{
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                      id: 'tc1',
                      type: 'function',
                      function: { name: 'researcher', arguments: '{"task":"AI trends"}' },
                    }],
                  },
                }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            }
            // Second call: produce final answer
            return {
              choices: [{
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'Based on research: AI is growing.' },
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          },
        },
      },
    };

    const tools = subAgentsToTools([researcher], 'session-1');
    const result = await runAgentLoop({
      openai,
      model: 'test',
      messages: [
        { role: 'system', content: 'You are a supervisor.' },
        { role: 'user', content: 'Research AI trends and summarize.' },
      ],
      tools,
      maxIterations: 10,
    });

    expect(result.response).toBe('Based on research: AI is growing.');
    expect(result.usage.iterations).toBe(2);
  });

  it('handles multiple sub-agents', async () => {
    const researcher: SubAgent = { name: 'researcher', description: 'research', call: async () => 'facts' };
    const writer: SubAgent = { name: 'writer', description: 'write', call: async () => 'article' };

    const tools = subAgentsToTools([researcher, writer], 'session-2');
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('researcher');
    expect(tools[1].name).toBe('writer');

    const researchResult = await tools[0].call({ task: 'climate' });
    expect(researchResult).toBe('facts');

    const writeResult = await tools[1].call({ task: 'write about climate' });
    expect(writeResult).toBe('article');
  });

  it('passes sessionId to sub-agent call', async () => {
    const calls: string[] = [];
    const agent: SubAgent = {
      name: 'tracker',
      description: 'tracks',
      call: async (task, sessionId) => { calls.push(sessionId); return 'ok'; },
    };
    const tools = subAgentsToTools([agent], 'my-session-id');
    await tools[0].call({ task: 'do something' });
    expect(calls).toEqual(['my-session-id']);
  });
});
```

- [ ] **Step 2: Run test — confirm FAIL with "Cannot find module"**

```bash
cd /mnt/dev/n8n-nodes-agent-kit && npx jest tests/orchestratorKit.test.ts --no-coverage 2>&1 | tail -5
```

Expected: FAIL — `Cannot find module '../nodes/SubAgentKit/SubAgentKit.node'`

- [ ] **Step 3: Create `nodes/OrchestratorKit/OrchestratorKit.node.ts`**

```typescript
// nodes/OrchestratorKit/OrchestratorKit.node.ts
import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import OpenAI from 'openai';
import { runAgentLoop } from '../../utils/subAgentRunner';
import { runGuardrails } from '../AgentKit/guardrails/index';
import type { GuardrailConfig } from '../AgentKit/guardrails/types';
import type { IAgentMemory } from '../AgentMemory/AgentMemory.node';
import type { McpTool } from '../McpGateway/McpGateway.node';
import type { SubAgent } from '../SubAgentKit/SubAgentKit.node';
import { composeSystemPrompt } from '../../utils/skillParser';
import type { Skill } from '../../utils/skillParser';

const AI_AGENT_CONNECTION = 'AiAgent' as any;

function subAgentsToTools(subAgents: SubAgent[], sessionId: string): McpTool[] {
  return subAgents.map((agent) => ({
    name: agent.name,
    description: agent.description,
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Task to delegate to this agent.' } },
      required: ['task'],
    },
    call: async (args: Record<string, unknown>) =>
      agent.call(String(args.task ?? ''), sessionId),
  }));
}

export class OrchestratorKit implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Orchestrator Kit',
    name: 'orchestratorKit',
    icon: 'fa:sitemap',
    group: ['transform'],
    version: 1,
    description: 'Supervisor agent that delegates tasks to connected SubAgentKit nodes.',
    defaults: { name: 'Orchestrator Kit' },
    inputs: [
      NodeConnectionTypes.Main,
      { type: NodeConnectionTypes.AiMemory, required: false },
      { type: NodeConnectionTypes.AiTool, required: false },
      { type: AI_AGENT_CONNECTION, required: false },
    ],
    inputNames: ['input', 'memory', 'tools', 'agents'],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'openRouterApi', required: true }],
    properties: [
      {
        displayName: 'Input Message Field',
        name: 'inputField',
        type: 'string',
        default: 'message',
      },
      {
        displayName: 'Session ID Field',
        name: 'sessionIdField',
        type: 'string',
        default: 'sessionId',
      },
      {
        displayName: 'System Prompt',
        name: 'systemPrompt',
        type: 'string',
        typeOptions: { rows: 6 },
        default: 'You are a supervisor AI. Delegate tasks to your specialized agents as needed.',
      },
      {
        displayName: 'Model Override',
        name: 'modelOverride',
        type: 'string',
        default: '',
      },
      {
        displayName: 'Max Iterations',
        name: 'maxIterations',
        type: 'number',
        default: 20,
      },
      {
        displayName: 'Output Field',
        name: 'outputField',
        type: 'string',
        default: 'response',
      },
      {
        displayName: 'Inline Skills',
        name: 'inlineSkills',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        options: [
          {
            name: 'skill',
            displayName: 'Skill',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              { displayName: 'Description', name: 'description', type: 'string', default: '' },
              { displayName: 'Content', name: 'content', type: 'string', typeOptions: { rows: 6 }, default: '' },
            ],
          },
        ],
      },
      {
        displayName: 'Guardrails',
        name: 'guardrails',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        options: [
          {
            name: 'guardrail',
            displayName: 'Guardrail',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              {
                displayName: 'Phase', name: 'phase', type: 'options',
                options: [{ name: 'Pre', value: 'pre' }, { name: 'Post', value: 'post' }],
                default: 'pre',
              },
              {
                displayName: 'Check Type', name: 'type', type: 'options',
                options: [
                  { name: 'Keywords', value: 'keywords' },
                  { name: 'Custom Regex', value: 'customRegex' },
                  { name: 'Jailbreak Detection', value: 'jailbreak' },
                  { name: 'NSFW Content', value: 'nsfw' },
                ],
                default: 'keywords',
              },
              { displayName: 'Fallback Response', name: 'fallbackResponse', type: 'string', default: 'I cannot respond to that.' },
              { displayName: 'Keywords', name: 'keywords', type: 'string', default: '', displayOptions: { show: { type: ['keywords'] } } },
              { displayName: 'Pattern', name: 'pattern', type: 'string', default: '', displayOptions: { show: { type: ['customRegex'] } } },
            ],
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const results: INodeExecutionData[] = [];

    const creds = await this.getCredentials('openRouterApi');
    const openai = new OpenAI({
      apiKey: creds.apiKey as string,
      baseURL: (creds.baseUrl as string) || 'https://openrouter.ai/api/v1',
      defaultHeaders: creds.httpReferer ? { 'X-Title': creds.httpReferer as string } : undefined,
    });

    // Memory (optional)
    let memory: IAgentMemory | null = null;
    try {
      const memData = await this.getInputConnectionData(NodeConnectionTypes.AiMemory, 0);
      if (Array.isArray(memData) && memData.length > 0) {
        memory = (memData[0] as { response: IAgentMemory }).response ?? null;
      }
    } catch { /* no memory */ }

    // Direct MCP tools (optional)
    let mcpTools: McpTool[] = [];
    try {
      const toolData = await this.getInputConnectionData(NodeConnectionTypes.AiTool, 0);
      if (Array.isArray(toolData) && toolData.length > 0) {
        mcpTools = (toolData[0] as { response: McpTool[] }).response ?? [];
      }
    } catch { /* no tools */ }

    // Sub-agents (optional)
    let subAgents: SubAgent[] = [];
    try {
      const agentData = await this.getInputConnectionData(AI_AGENT_CONNECTION, 0);
      if (Array.isArray(agentData)) {
        subAgents = agentData
          .map((d) => (d as { response: SubAgent }).response)
          .filter(Boolean);
      }
    } catch { /* no sub-agents */ }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const inputField = this.getNodeParameter('inputField', i) as string;
      const sessionIdField = this.getNodeParameter('sessionIdField', i) as string;
      const baseSystemPrompt = this.getNodeParameter('systemPrompt', i) as string;
      const modelOverride = this.getNodeParameter('modelOverride', i, '') as string;
      const maxIterations = this.getNodeParameter('maxIterations', i, 20) as number;
      const outputField = this.getNodeParameter('outputField', i, 'response') as string;
      const model = modelOverride || (creds.model as string) || 'qwen/qwen3-235b-a22b';

      const userMessage = String(item.json[inputField] ?? '');
      const sessionId = String(item.json[sessionIdField] ?? `session-${i}`);

      const inlineSkillsRaw = this.getNodeParameter('inlineSkills', i, { skill: [] }) as {
        skill: Array<{ name: string; description: string; content: string }>;
      };
      const skills: Skill[] = (inlineSkillsRaw.skill ?? [])
        .filter((s) => s.name)
        .map((s) => ({ name: s.name, description: s.description, content: s.content, tags: [] }));

      const guardrailsRaw = this.getNodeParameter('guardrails', i, { guardrail: [] }) as {
        guardrail: Array<{ name: string; phase: string; type: string; fallbackResponse: string; keywords?: string; pattern?: string }>;
      };
      const guardrailConfigs: GuardrailConfig[] = (guardrailsRaw.guardrail ?? []).map((g) => ({
        name: g.name,
        phase: g.phase as 'pre' | 'post',
        type: g.type as GuardrailConfig['type'],
        fallbackResponse: g.fallbackResponse,
        keywords: g.keywords,
        pattern: g.pattern,
      }));

      if (!userMessage) {
        throw new NodeOperationError(
          this.getNode(),
          `Input field "${inputField}" is empty or missing.`,
          { itemIndex: i },
        );
      }

      const preBlock = await runGuardrails(userMessage, guardrailConfigs, 'pre', openai, model);
      if (preBlock !== null) {
        results.push({
          json: { ...item.json, [outputField]: preBlock, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0, model } } as INodeExecutionData['json'],
          pairedItem: { item: i },
        });
        continue;
      }

      const systemPrompt = composeSystemPrompt(baseSystemPrompt, skills);
      const history = memory ? memory.getMessages(sessionId) : [];
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user', content: userMessage },
      ];

      if (memory) memory.addMessage(sessionId, { role: 'user', content: userMessage });

      // Combine sub-agents (as tools) + direct MCP tools
      const agentTools = subAgentsToTools(subAgents, sessionId);
      const allTools = [...agentTools, ...mcpTools];

      const loopResult = await runAgentLoop({ openai, model, messages, tools: allTools, maxIterations });
      let finalResponse = loopResult.response;

      if (!finalResponse) {
        throw new NodeOperationError(
          this.getNode(),
          `Orchestrator did not produce a response after ${maxIterations} iteration(s).`,
          { itemIndex: i },
        );
      }

      const postBlock = await runGuardrails(finalResponse, guardrailConfigs, 'post', openai, model);
      if (postBlock !== null) finalResponse = postBlock;

      if (memory) memory.addMessage(sessionId, { role: 'assistant', content: finalResponse });

      results.push({
        json: {
          ...item.json,
          [outputField]: finalResponse,
          usage: { ...loopResult.usage, model },
        } as INodeExecutionData['json'],
        pairedItem: { item: i },
      });
    }

    return [results];
  }
}
```

- [ ] **Step 4: Run test — confirm 3 PASS**

```bash
cd /mnt/dev/n8n-nodes-agent-kit && npx jest tests/orchestratorKit.test.ts --no-coverage 2>&1 | tail -10
```

- [ ] **Step 5: Run all tests**

```bash
cd /mnt/dev/n8n-nodes-agent-kit && npx jest --no-coverage 2>&1 | tail -10
```

Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add nodes/OrchestratorKit/OrchestratorKit.node.ts tests/orchestratorKit.test.ts
git commit -m "feat(orchestrator): add OrchestratorKit supervisor node"
```

---

## Task 4: Register nodes + build + version bump

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add new nodes to `package.json` `n8n.nodes` array**

Open `package.json`. The current `n8n.nodes` array is:

```json
"nodes": [
  "dist/nodes/AgentKit/AgentKit.node.js",
  "dist/nodes/SkillLoader/SkillLoader.node.js",
  "dist/nodes/AgentMemory/AgentMemory.node.js",
  "dist/nodes/McpGateway/McpGateway.node.js"
]
```

Change it to:

```json
"nodes": [
  "dist/nodes/AgentKit/AgentKit.node.js",
  "dist/nodes/SkillLoader/SkillLoader.node.js",
  "dist/nodes/AgentMemory/AgentMemory.node.js",
  "dist/nodes/McpGateway/McpGateway.node.js",
  "dist/nodes/SubAgentKit/SubAgentKit.node.js",
  "dist/nodes/OrchestratorKit/OrchestratorKit.node.js"
]
```

- [ ] **Step 2: Run full build**

```bash
cd /mnt/dev/n8n-nodes-agent-kit && npm run build 2>&1 | tail -10
```

Expected: exits 0, no errors.

- [ ] **Step 3: Verify dist output**

```bash
ls /mnt/dev/n8n-nodes-agent-kit/dist/nodes/SubAgentKit/
ls /mnt/dev/n8n-nodes-agent-kit/dist/nodes/OrchestratorKit/
```

Expected: `SubAgentKit.node.js`, `OrchestratorKit.node.js` present in each.

- [ ] **Step 4: Run full test suite**

```bash
cd /mnt/dev/n8n-nodes-agent-kit && npx jest --no-coverage 2>&1 | tail -10
```

Expected: all PASS.

- [ ] **Step 5: Bump version to 0.1.7 in `package.json`**

Change `"version": "0.1.6"` to `"version": "0.1.7"`.

- [ ] **Step 6: Final commit**

```bash
git add package.json
git commit -m "chore: register OrchestratorKit + SubAgentKit nodes, bump to 0.1.7"
```
