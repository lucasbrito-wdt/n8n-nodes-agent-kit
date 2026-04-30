import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  ISupplyDataFunctions,
  SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import OpenAI from 'openai';
import { runAgentLoop } from '../../utils/subAgentRunner';
import { runGuardrails } from '../AgentKit/guardrails/index';
import type { GuardrailConfig } from '../AgentKit/guardrails/types';
import type { IAgentMemory } from '../AgentMemory/AgentMemory.node';
import type { McpTool } from '../McpGateway/McpGateway.node';
import { composeSystemPrompt } from '../../utils/skillParser';
import type { Skill } from '../../utils/skillParser';

export interface SubAgent {
  name: string;
  description: string;
  call: (task: string, sessionId: string) => Promise<string>;
}

const guardrailProperties = [
  {
    displayName: 'Guardrails',
    name: 'guardrails',
    type: 'fixedCollection' as const,
    typeOptions: { multipleValues: true },
    default: {},
    description: 'Content guardrails evaluated before (pre) or after (post) the LLM loop.',
    options: [
      {
        name: 'guardrail',
        displayName: 'Guardrail',
        values: [
          { displayName: 'Name', name: 'name', type: 'string' as const, default: '' },
          {
            displayName: 'Phase', name: 'phase', type: 'options' as const,
            options: [
              { name: 'Pre (validate input)', value: 'pre' },
              { name: 'Post (validate output)', value: 'post' },
            ],
            default: 'pre',
          },
          {
            displayName: 'Check Type', name: 'type', type: 'options' as const,
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
            displayName: 'Fallback Response', name: 'fallbackResponse', type: 'string' as const,
            default: 'I cannot respond to that.',
          },
          {
            displayName: 'Keywords', name: 'keywords', type: 'string' as const, default: '',
            displayOptions: { show: { type: ['keywords'] } },
          },
          {
            displayName: 'Pattern', name: 'pattern', type: 'string' as const, default: '',
            displayOptions: { show: { type: ['customRegex'] } },
          },
          {
            displayName: 'Evaluation Prompt', name: 'prompt', type: 'string' as const,
            typeOptions: { rows: 4 }, default: '',
            displayOptions: { show: { type: ['customModel'] } },
          },
        ],
      },
    ],
  },
];

type RawGuardrail = {
  name: string; phase: string; type: string; fallbackResponse: string;
  keywords?: string; pattern?: string; prompt?: string;
};

function parseGuardrails(raw: { guardrail: RawGuardrail[] }): GuardrailConfig[] {
  return (raw.guardrail ?? []).map((g) => ({
    name: g.name,
    phase: g.phase as 'pre' | 'post',
    type: g.type as GuardrailConfig['type'],
    fallbackResponse: g.fallbackResponse,
    keywords: g.keywords,
    pattern: g.pattern,
    prompt: g.prompt,
  }));
}

function buildOpenAI(creds: Record<string, unknown>): OpenAI {
  return new OpenAI({
    apiKey: creds.apiKey as string,
    baseURL: (creds.baseUrl as string) || 'https://openrouter.ai/api/v1',
    defaultHeaders: creds.httpReferer ? { 'X-Title': creds.httpReferer as string } : undefined,
  });
}

export class SubAgentKit implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Sub Agent Kit',
    name: 'subAgentKit',
    icon: 'fa:robot',
    group: ['transform'],
    version: 1,
    description: 'A specialized agent. Connect to OrchestratorKit via AiAgent, or run standalone via Main.',
    defaults: { name: 'Sub Agent Kit' },
    inputs: [
      { type: NodeConnectionTypes.AiMemory, required: false },
      { type: NodeConnectionTypes.AiTool, required: false },
    ],
    inputNames: ['memory', 'tools'],
    outputs: [NodeConnectionTypes.AiAgent],
    outputNames: ['agent'],
    credentials: [{ name: 'openRouterApi', required: true }],
    properties: [
      // ── Orchestrator identity ──────────────────────────────────────────────
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
      // ── Standalone execution ───────────────────────────────────────────────
      {
        displayName: 'Input Message Field',
        name: 'inputField',
        type: 'string',
        default: 'message',
        description: 'Field in the input JSON that contains the user message (standalone mode).',
      },
      {
        displayName: 'Session ID Field',
        name: 'sessionIdField',
        type: 'string',
        default: 'sessionId',
        description: 'Field in the input JSON used to identify the session for memory (standalone mode).',
      },
      {
        displayName: 'Output Field',
        name: 'outputField',
        type: 'string',
        default: 'response',
        description: 'Field name in the output JSON for the agent response (standalone mode).',
      },
      // ── Shared ────────────────────────────────────────────────────────────
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
        description: 'Skills defined inline. Skills from a connected Skill Loader node are merged and take precedence.',
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
      ...guardrailProperties,
    ],
  };

  // ── Standalone execution ─────────────────────────────────────────────────

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const results: INodeExecutionData[] = [];

    const creds = await this.getCredentials('openRouterApi');
    const openai = buildOpenAI(creds as Record<string, unknown>);

    let memory: IAgentMemory | null = null;
    try {
      const memData = await this.getInputConnectionData(NodeConnectionTypes.AiMemory, 0);
      if (Array.isArray(memData) && memData.length > 0) {
        memory = (memData[0] as { response: IAgentMemory }).response ?? null;
      }
    } catch { /* no memory */ }

    let tools: McpTool[] = [];
    try {
      const toolData = await this.getInputConnectionData(NodeConnectionTypes.AiTool, 0);
      if (Array.isArray(toolData) && toolData.length > 0) {
        tools = (toolData[0] as { response: McpTool[] }).response ?? [];
      }
    } catch { /* no tools */ }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      const inputField = this.getNodeParameter('inputField', i) as string;
      const sessionIdField = this.getNodeParameter('sessionIdField', i) as string;
      const baseSystemPrompt = this.getNodeParameter('systemPrompt', i) as string;
      const modelOverride = this.getNodeParameter('modelOverride', i, '') as string;
      const maxIterations = this.getNodeParameter('maxIterations', i, 10) as number;
      const outputField = this.getNodeParameter('outputField', i, 'response') as string;
      const model = modelOverride || (creds.model as string) || 'qwen/qwen3-235b-a22b';

      const userMessage = String(item.json[inputField] ?? '');
      const sessionId = String(item.json[sessionIdField] ?? `session-${i}`);

      if (!userMessage) {
        throw new NodeOperationError(
          this.getNode(),
          `Input field "${inputField}" is empty or missing.`,
          { itemIndex: i },
        );
      }

      const inlineSkillsRaw = this.getNodeParameter('inlineSkills', i, { skill: [] }) as {
        skill: Array<{ name: string; description: string; content: string }>;
      };
      const inlineSkills: Skill[] = (inlineSkillsRaw.skill ?? [])
        .filter((s) => s.name)
        .map((s) => ({ name: s.name, description: s.description, content: s.content, tags: [] }));

      const loaderSkills = (item.json.__skills__ ?? []) as Skill[];
      const loaderNames = new Set(loaderSkills.map((s) => s.name));
      const skills: Skill[] = [
        ...inlineSkills.filter((s) => !loaderNames.has(s.name)),
        ...loaderSkills,
      ];

      const guardrailsRaw = this.getNodeParameter('guardrails', i, { guardrail: [] }) as { guardrail: RawGuardrail[] };
      const guardrailConfigs = parseGuardrails(guardrailsRaw);

      const preBlock = await runGuardrails(userMessage, guardrailConfigs, 'pre', openai, model);
      if (preBlock !== null) {
        const { __skills__: _s, ...cleanJson } = item.json as Record<string, unknown>;
        results.push({
          json: {
            ...cleanJson,
            [outputField]: preBlock,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0, model },
          } as INodeExecutionData['json'],
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

      const loopResult = await runAgentLoop({ openai, model, messages, tools, maxIterations });
      let finalResponse = loopResult.response;
      const usage = loopResult.usage;

      if (!finalResponse) {
        throw new NodeOperationError(
          this.getNode(),
          `Agent did not produce a response after ${maxIterations} iteration(s).`,
          { itemIndex: i },
        );
      }

      const postBlock = await runGuardrails(finalResponse, guardrailConfigs, 'post', openai, model);
      if (postBlock !== null) finalResponse = postBlock;

      if (memory) memory.addMessage(sessionId, { role: 'assistant', content: finalResponse });

      const { __skills__: _unused, ...cleanJson } = item.json as Record<string, unknown>;
      results.push({
        json: {
          ...cleanJson,
          [outputField]: finalResponse,
          usage: { ...usage, model },
        } as INodeExecutionData['json'],
        pairedItem: { item: i },
      });
    }

    return [results];
  }

  // ── Supply to OrchestratorKit ────────────────────────────────────────────

  async supplyData(this: ISupplyDataFunctions): Promise<SupplyData> {
    const creds = await this.getCredentials('openRouterApi');
    const openai = buildOpenAI(creds as Record<string, unknown>);

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

    const guardrailsRaw = this.getNodeParameter('guardrails', 0, { guardrail: [] }) as { guardrail: RawGuardrail[] };
    const guardrailConfigs = parseGuardrails(guardrailsRaw);

    let memory: IAgentMemory | null = null;
    try {
      const memData = await this.getInputConnectionData(NodeConnectionTypes.AiMemory, 0);
      if (Array.isArray(memData) && memData.length > 0) {
        memory = (memData[0] as { response: IAgentMemory }).response ?? null;
      }
    } catch { /* no memory */ }

    let tools: McpTool[] = [];
    try {
      const toolData = await this.getInputConnectionData(NodeConnectionTypes.AiTool, 0);
      if (Array.isArray(toolData) && toolData.length > 0) {
        tools = (toolData[0] as { response: McpTool[] }).response ?? [];
      }
    } catch { /* no tools */ }

    const sessionHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();

    const subAgent: SubAgent = {
      name: agentName,
      description: agentDescription,
      call: async (task: string, sessionId: string) => {
        const preBlock = await runGuardrails(task, guardrailConfigs, 'pre', openai, model);
        if (preBlock !== null) return preBlock;

        const history = memory
          ? memory.getMessages(sessionId).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
          : (sessionHistory.get(sessionId) ?? []);

        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: task },
        ];

        if (memory) memory.addMessage(sessionId, { role: 'user', content: task });

        const result = await runAgentLoop({ openai, model, messages, tools, maxIterations });
        const response = result.response || 'No response generated.';

        const postBlock = await runGuardrails(response, guardrailConfigs, 'post', openai, model);
        const finalResponse = postBlock ?? response;

        if (memory) {
          memory.addMessage(sessionId, { role: 'assistant', content: finalResponse });
        } else {
          const h = sessionHistory.get(sessionId) ?? [];
          h.push({ role: 'user', content: task });
          h.push({ role: 'assistant', content: finalResponse });
          sessionHistory.set(sessionId, h);
        }

        return finalResponse;
      },
    };

    return { response: subAgent };
  }
}
