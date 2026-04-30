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

interface TraceEntry {
  step: number;
  agent: string;
  task: string;
  response: string;
  durationMs: number;
}

function subAgentsToTools(subAgents: SubAgent[], sessionId: string, trace: TraceEntry[]): McpTool[] {
  return subAgents.map((agent) => ({
    name: agent.name,
    description: agent.description,
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Task to delegate to this agent.' } },
      required: ['task'],
    },
    call: async (args: Record<string, unknown>) => {
      const task = String(args.task ?? '');
      const start = Date.now();
      const response = await agent.call(task, sessionId);
      trace.push({
        step: trace.length + 1,
        agent: agent.name,
        task: task.length > 300 ? task.slice(0, 300) + '…' : task,
        response: response.length > 500 ? response.slice(0, 500) + '…' : response,
        durationMs: Date.now() - start,
      });
      return response;
    },
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
      { type: NodeConnectionTypes.AiAgent, required: false },
    ],
    inputNames: ['input', 'memory', 'tools', 'agents'],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'openRouterApi', required: true }],
    properties: [
      { displayName: 'Input Message Field', name: 'inputField', type: 'string', default: 'message' },
      { displayName: 'Session ID Field', name: 'sessionIdField', type: 'string', default: 'sessionId' },
      {
        displayName: 'System Prompt', name: 'systemPrompt', type: 'string',
        typeOptions: { rows: 6 },
        default: 'You are a supervisor AI. Delegate tasks to your specialized agents as needed.',
      },
      { displayName: 'Model Override', name: 'modelOverride', type: 'string', default: '' },
      { displayName: 'Max Iterations', name: 'maxIterations', type: 'number', default: 20 },
      { displayName: 'Output Field', name: 'outputField', type: 'string', default: 'response' },
      {
        displayName: 'Inline Skills', name: 'inlineSkills', type: 'fixedCollection',
        typeOptions: { multipleValues: true }, default: {},
        options: [{
          name: 'skill', displayName: 'Skill',
          values: [
            { displayName: 'Name', name: 'name', type: 'string', default: '' },
            { displayName: 'Description', name: 'description', type: 'string', default: '' },
            { displayName: 'Content', name: 'content', type: 'string', typeOptions: { rows: 6 }, default: '' },
          ],
        }],
      },
      {
        displayName: 'Guardrails', name: 'guardrails', type: 'fixedCollection',
        typeOptions: { multipleValues: true }, default: {},
        options: [{
          name: 'guardrail', displayName: 'Guardrail',
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
        }],
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

    let memory: IAgentMemory | null = null;
    try {
      const memData = await this.getInputConnectionData(NodeConnectionTypes.AiMemory, 0);
      if (Array.isArray(memData) && memData.length > 0) {
        memory = (memData[0] as IAgentMemory) ?? null;
      }
    } catch { /* no memory */ }

    let mcpTools: McpTool[] = [];
    try {
      const toolData = await this.getInputConnectionData(NodeConnectionTypes.AiTool, 0);
      if (Array.isArray(toolData) && toolData.length > 0) {
        mcpTools = (toolData as McpTool[][]).flat();
      }
    } catch { /* no tools */ }

    let subAgents: SubAgent[] = [];
    try {
      const agentData = await this.getInputConnectionData(NodeConnectionTypes.AiAgent, 0);
      if (Array.isArray(agentData)) {
        subAgents = (agentData as SubAgent[]).filter(Boolean);
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

      const executionTrace: TraceEntry[] = [];
      const agentTools = subAgentsToTools(subAgents, sessionId, executionTrace);
      const allTools = [...agentTools, ...mcpTools];

      const loopResult = await runAgentLoop({
        openai, model, messages, tools: allTools, maxIterations,
        forceToolUse: agentTools.length > 0,
      });
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
          executionTrace,
          usage: { ...loopResult.usage, model },
        } as INodeExecutionData['json'],
        pairedItem: { item: i },
      });
    }

    return [results];
  }
}
