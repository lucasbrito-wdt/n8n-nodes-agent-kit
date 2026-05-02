import type {
  INodeType,
  INodeTypeDescription,
  ISupplyDataFunctions,
  SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import OpenAI from 'openai';
import { runAgentLoop } from '../../utils/subAgentRunner';
import { runGuardrails } from '../AgentKit/guardrails/index';
import type { GuardrailConfig } from '../AgentKit/guardrails/types';
import type { IAgentMemory } from '../AgentMemory/AgentMemory.node';
import type { McpTool } from '../McpGateway/McpGateway.node';
import { composeSystemPrompt, buildSkillTool } from '../../utils/skillParser';
import type { Skill } from '../../utils/skillParser';

export interface SubAgentUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  iterations: number;
}

export interface SubAgentResult {
  response: string;
  usage: SubAgentUsage;
}

export interface SubAgentContext {
  task: string;
  /** Conversation history injected by the orchestrator (for stateless agents). */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Arbitrary state passed from the orchestrator (CRM data, contact info, etc.). */
  state?: Record<string, unknown>;
}

export interface SubAgentAction {
  action: string;
  description: string;
}

export interface SubAgent {
  name: string;
  description: string;
  /** When true the agent uses orchestrator-provided history; it does not maintain its own session state. */
  stateless: boolean;
  /** Declared output actions — routing and terminal values this agent can return. */
  actions: SubAgentAction[];
  /** The JSON key used for the user-facing message in the agent's output. */
  outputContentKey: string;
  call: (context: SubAgentContext, sessionId: string) => Promise<SubAgentResult>;
}

/** Builds the output format block injected at the end of the system prompt. */
function buildOutputFormatBlock(
  actions: SubAgentAction[],
  outputContentKey: string,
): string {
  if (actions.length === 0) return '';
  const actionList = actions
    .map((a) => `- "${a.action}"${a.description ? ` — ${a.description}` : ''}`)
    .join('\n');
  return [
    '',
    '---',
    'OUTPUT FORMAT — always return valid JSON, nothing else:',
    '{',
    `  "${outputContentKey}": "[message to the user]",`,
    '  "crm_instructions": {',
    '    "action": "<one of the actions listed below>"',
    '  }',
    '}',
    '',
    'Available actions:',
    actionList,
  ].join('\n');
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
    inputs: [
      { type: NodeConnectionTypes.AiMemory, required: false },
      { type: NodeConnectionTypes.AiTool, required: false },
    ],
    inputNames: ['memory', 'tools'],
    outputs: [NodeConnectionTypes.AiAgent],
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
        displayName: 'Stateless Mode',
        name: 'stateless',
        type: 'boolean',
        default: false,
        description: 'When enabled, the agent receives conversation history from the orchestrator instead of maintaining its own session memory. Recommended for agents that do not use tools (e.g. Gabi, Sofia, Aurora).',
      },

      // ── Output Actions ────────────────────────────────────────────────────
      {
        displayName: 'Output Content Key',
        name: 'outputContentKey',
        type: 'string',
        default: 'content_raw',
        description: 'The JSON key used for the user-facing message in the agent output (e.g. content_raw). The output format block is auto-injected into the system prompt.',
      },
      {
        displayName: 'Output Actions',
        name: 'outputActions',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description: 'Declare the possible crm_instructions.action values this agent can return. The list is auto-injected into the system prompt as the output format — no need to write it manually.',
        options: [{
          name: 'outputAction',
          displayName: 'Action',
          values: [
            {
              displayName: 'Action Value',
              name: 'action',
              type: 'string',
              default: '',
              description: 'The action string the agent will return (e.g. none, disqualify, route_to_sofia).',
            },
            {
              displayName: 'Description',
              name: 'description',
              type: 'string',
              default: '',
              description: 'What this action means — shown to the LLM to guide its decision.',
            },
          ],
        }],
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
                options: [{ name: 'Pre (validate input)', value: 'pre' }, { name: 'Post (validate output)', value: 'post' }],
                default: 'pre',
              },
              {
                displayName: 'Check Type', name: 'type', type: 'options',
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
              { displayName: 'Fallback Response', name: 'fallbackResponse', type: 'string', default: 'I cannot respond to that.' },
              { displayName: 'Keywords', name: 'keywords', type: 'string', default: '', displayOptions: { show: { type: ['keywords'] } } },
              { displayName: 'Pattern', name: 'pattern', type: 'string', default: '', displayOptions: { show: { type: ['customRegex'] } } },
              { displayName: 'Evaluation Prompt', name: 'prompt', type: 'string', typeOptions: { rows: 4 }, default: '', displayOptions: { show: { type: ['customModel'] } } },
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
    const stateless = this.getNodeParameter('stateless', 0, false) as boolean;
    const model = modelOverride || (creds.model as string) || 'qwen/qwen3-235b-a22b';

    const outputContentKey = this.getNodeParameter('outputContentKey', 0, 'content_raw') as string;

    const outputActionsRaw = this.getNodeParameter('outputActions', 0, { outputAction: [] }) as {
      outputAction: Array<{ action: string; description: string }>;
    };
    const outputActions: SubAgentAction[] = (outputActionsRaw.outputAction ?? [])
      .filter((a) => a.action)
      .map((a) => ({ action: a.action, description: a.description ?? '' }));

    const inlineSkillsRaw = this.getNodeParameter('inlineSkills', 0, { skill: [] }) as {
      skill: Array<{ name: string; description: string; content: string }>;
    };
    const skills: Skill[] = (inlineSkillsRaw.skill ?? [])
      .filter((s) => s.name)
      .map((s) => ({ name: s.name, description: s.description, content: s.content, tags: [] }));

    const outputFormatBlock = buildOutputFormatBlock(outputActions, outputContentKey);
    const systemPrompt = composeSystemPrompt(baseSystemPrompt, skills) + outputFormatBlock;

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

    let memory: IAgentMemory | null = null;
    if (!stateless) {
      try {
        const memData = await this.getInputConnectionData(NodeConnectionTypes.AiMemory, 0);
        if (Array.isArray(memData) && memData.length > 0) {
          memory = (memData[0] as IAgentMemory) ?? null;
        }
      } catch { /* no memory */ }
    }

    let tools: McpTool[] = [];
    try {
      const toolData = await this.getInputConnectionData(NodeConnectionTypes.AiTool, 0);
      if (Array.isArray(toolData) && toolData.length > 0) {
        tools = (toolData as McpTool[][]).flat();
      }
    } catch { /* no tools */ }

    // Internal session history only used when stateless=false and no external memory
    const sessionHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();

    const subAgent: SubAgent = {
      name: agentName,
      description: agentDescription,
      stateless,
      actions: outputActions,
      outputContentKey,
      call: async (context: SubAgentContext, sessionId: string) => {
        const { task, history: injectedHistory, state } = context;

        const preBlock = await runGuardrails(task, guardrailConfigs, 'pre', openai, model);
        if (preBlock !== null) {
          return { response: preBlock, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0 } };
        }

        let history: Array<{ role: 'user' | 'assistant'; content: string }>;

        if (stateless) {
          // Stateless: use orchestrator-provided history (no internal state)
          history = injectedHistory ?? [];
        } else {
          // Stateful: read from memory or internal session map
          history = memory
            ? memory.getMessages(sessionId).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
            : (sessionHistory.get(sessionId) ?? []);
        }

        // Prepend state as a system context block if provided
        const stateBlock = state && Object.keys(state).length > 0
          ? `\n\n[Context from orchestrator]\n${JSON.stringify(state, null, 2)}`
          : '';

        const userContent = stateBlock ? `${task}\n${stateBlock}` : task;

        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: userContent },
        ];

        const allTools = skills.length > 0 ? [...tools, buildSkillTool(skills)] : tools;
        const result = await runAgentLoop({ openai, model, messages, tools: allTools, maxIterations });
        const response = result.response || 'No response generated.';

        const postBlock = await runGuardrails(response, guardrailConfigs, 'post', openai, model);
        const finalResponse = postBlock ?? response;

        if (!stateless) {
          if (memory) {
            memory.addMessage(sessionId, { role: 'user', content: task });
            memory.addMessage(sessionId, { role: 'assistant', content: finalResponse });
          } else {
            const h = sessionHistory.get(sessionId) ?? [];
            h.push({ role: 'user', content: task });
            h.push({ role: 'assistant', content: finalResponse });
            sessionHistory.set(sessionId, h);
          }
        }

        return { response: finalResponse, usage: result.usage };
      },
    };

    return { response: subAgent };
  }
}
