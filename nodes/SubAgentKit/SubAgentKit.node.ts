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
