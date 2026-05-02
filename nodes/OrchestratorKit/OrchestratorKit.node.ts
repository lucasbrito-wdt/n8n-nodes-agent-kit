import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { resolveField } from '../../utils/fieldResolver';
import OpenAI from 'openai';
import { runAgentLoop } from '../../utils/subAgentRunner';
import { runGuardrails } from '../AgentKit/guardrails/index';
import type { GuardrailConfig } from '../AgentKit/guardrails/types';
import type { IAgentMemory } from '../AgentMemory/AgentMemory.node';
import type { McpTool } from '../McpGateway/McpGateway.node';
import type { SubAgent, SubAgentContext, SubAgentUsage } from '../SubAgentKit/SubAgentKit.node';
import { composeSystemPrompt, buildSkillTool } from '../../utils/skillParser';
import type { Skill } from '../../utils/skillParser';
import { runHandoffChain, parseAgentOutput } from '../../utils/handoffChain';
import type { HandoffTraceEntry } from '../../utils/handoffChain';

type TraceEntry = HandoffTraceEntry;

// ─── Orchestrator loop (free LLM routing) ────────────────────────────────────

function subAgentsToTools(
  subAgents: SubAgent[],
  sessionId: string,
  trace: TraceEntry[],
  orchestratorMessages: OpenAI.Chat.ChatCompletionMessageParam[],
): McpTool[] {
  return subAgents.map((agent) => ({
    name: agent.name,
    description: agent.description,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task to delegate to this agent.' },
        context: {
          type: 'string',
          description: 'Optional JSON string with relevant state to pass (e.g. contact info, CRM data, lead details).',
        },
      },
      required: ['task'],
    },
    call: async (args: Record<string, unknown>) => {
      const task = String(args.task ?? '');

      let state: Record<string, unknown> | undefined;
      if (args.context) {
        try { state = JSON.parse(String(args.context)) as Record<string, unknown>; }
        catch { /* ignore malformed context */ }
      }

      const history = agent.stateless
        ? orchestratorMessages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content ?? '') }))
        : undefined;

      const subAgentContext: SubAgentContext = { task, history, state };

      const start = Date.now();
      const result = await agent.call(subAgentContext, sessionId);
      const { contentRaw } = parseAgentOutput(result.response, agent.outputContentKey, agent.outputInstructionsKey);

      trace.push({
        step: trace.length + 1,
        agent: agent.name,
        task: task.length > 300 ? task.slice(0, 300) + '…' : task,
        response: contentRaw.length > 500 ? contentRaw.slice(0, 500) + '…' : contentRaw,
        durationMs: Date.now() - start,
        usage: result.usage,
      });

      // Return parsed content_raw so the orchestrator LLM sees clean text, not raw JSON
      return contentRaw;
    },
  }));
}

// ─── Node ─────────────────────────────────────────────────────────────────────

export class OrchestratorKit implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Orchestrator Kit',
    name: 'orchestratorKit',
    icon: 'fa:brain',
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
      // ── Mode ──────────────────────────────────────────────────────────────
      {
        displayName: 'Execution Mode',
        name: 'executionMode',
        type: 'options',
        options: [
          {
            name: 'Orchestrator (LLM decides routing)',
            value: 'orchestrator',
            description: 'A supervisor LLM reads all agents as tools and decides when to call each one.',
          },
          {
            name: 'Handoff Chain (deterministic routing)',
            value: 'handoff',
            description: 'Agents route themselves via crm_instructions.action. No orchestrator LLM overhead.',
          },
        ],
        default: 'orchestrator',
      },

      // ── Common ────────────────────────────────────────────────────────────
      { displayName: 'Input Message Field', name: 'inputField', type: 'string', default: 'message' },
      { displayName: 'Session ID Field', name: 'sessionIdField', type: 'string', default: 'sessionId' },
      { displayName: 'Output Field', name: 'outputField', type: 'string', default: 'response' },
      { displayName: 'Model Override', name: 'modelOverride', type: 'string', default: '' },

      // ── Orchestrator mode only ────────────────────────────────────────────
      {
        displayName: 'System Prompt',
        name: 'systemPrompt',
        type: 'string',
        typeOptions: { rows: 6 },
        default: 'You are a supervisor AI. Delegate tasks to your specialized agents as needed.',
        displayOptions: { show: { executionMode: ['orchestrator'] } },
      },
      {
        displayName: 'Max Iterations',
        name: 'maxIterations',
        type: 'number',
        default: 20,
        displayOptions: { show: { executionMode: ['orchestrator'] } },
      },

      // ── Handoff mode only ─────────────────────────────────────────────────
      {
        displayName: 'Entry Agent',
        name: 'entryAgent',
        type: 'string',
        default: '',
        description: 'Name of the first SubAgent to call. Must match the Agent Name set in the SubAgentKit node.',
        displayOptions: { show: { executionMode: ['handoff'] } },
      },
      {
        displayName: 'Max Hops',
        name: 'maxHops',
        type: 'number',
        default: 5,
        description: 'Maximum number of agent-to-agent handoffs before stopping.',
        displayOptions: { show: { executionMode: ['handoff'] } },
      },
      {
        displayName: 'Routing Map',
        name: 'routingMap',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description: 'Maps crm_instructions.action values to agent names. If an action is not listed here, the chain tries to strip "route_to_" from the value and match an agent by name.',
        displayOptions: { show: { executionMode: ['handoff'] } },
        options: [{
          name: 'route',
          displayName: 'Route',
          values: [
            {
              displayName: 'Action',
              name: 'action',
              type: 'string',
              default: '',
              description: 'The crm_instructions.action value returned by an agent (e.g. route_to_closer, escalate).',
            },
            {
              displayName: 'Agent Name',
              name: 'agentName',
              type: 'string',
              default: '',
              description: 'The SubAgent to call when this action is returned.',
            },
          ],
        }],
      },
      {
        displayName: 'Terminal Actions',
        name: 'terminalActions',
        type: 'string',
        default: 'none, disqualify, human_handoff, contract_generated, awaiting_signature, generate_financial, follow_up_closer, follow_up_sdr',
        description: 'Comma-separated list of crm_instructions.action values that stop the chain. Edit to match your agents\' output.',
        displayOptions: { show: { executionMode: ['handoff'] } },
      },

      // ── Skills ────────────────────────────────────────────────────────────
      {
        displayName: 'Skills Field',
        name: 'skillsField',
        type: 'string',
        default: '__skills__',
        description: 'Field path in the input JSON that carries skills from a Skill Loader node.',
        displayOptions: { show: { executionMode: ['orchestrator'] } },
      },
      {
        displayName: 'Inline Skills',
        name: 'inlineSkills',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        displayOptions: { show: { executionMode: ['orchestrator'] } },
        options: [{
          name: 'skill', displayName: 'Skill',
          values: [
            { displayName: 'Name', name: 'name', type: 'string', default: '' },
            { displayName: 'Description', name: 'description', type: 'string', default: '' },
            { displayName: 'Content', name: 'content', type: 'string', typeOptions: { rows: 6 }, default: '' },
          ],
        }],
      },

      // ── Guardrails ────────────────────────────────────────────────────────
      {
        displayName: 'Guardrails',
        name: 'guardrails',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
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
      if (Array.isArray(memData) && memData.length > 0) memory = (memData[0] as IAgentMemory) ?? null;
    } catch { /* no memory */ }

    let mcpTools: McpTool[] = [];
    try {
      const toolData = await this.getInputConnectionData(NodeConnectionTypes.AiTool, 0);
      if (Array.isArray(toolData) && toolData.length > 0) mcpTools = (toolData as McpTool[][]).flat();
    } catch { /* no tools */ }

    let subAgents: SubAgent[] = [];
    try {
      const agentData = await this.getInputConnectionData(NodeConnectionTypes.AiAgent, 0);
      if (Array.isArray(agentData)) subAgents = (agentData as SubAgent[]).filter(Boolean);
    } catch { /* no sub-agents */ }

    const agentMap = new Map(subAgents.map((a) => [a.name, a]));

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const executionMode = this.getNodeParameter('executionMode', i, 'orchestrator') as 'orchestrator' | 'handoff';
      const inputField = this.getNodeParameter('inputField', i) as string;
      const sessionIdField = this.getNodeParameter('sessionIdField', i) as string;
      const modelOverride = this.getNodeParameter('modelOverride', i, '') as string;
      const outputField = this.getNodeParameter('outputField', i, 'response') as string;
      const model = modelOverride || (creds.model as string) || 'qwen/qwen3-235b-a22b';

      const userMessage = String(resolveField(item.json, inputField) ?? '');
      const sessionId = String(resolveField(item.json, sessionIdField) ?? `session-${i}`);

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

      // ── Memory: shared by both modes ───────────────────────────────────────
      const memHistory = memory ? memory.getMessages(sessionId).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })) : [];
      if (memory) memory.addMessage(sessionId, { role: 'user', content: userMessage });

      let finalResponse: string;
      let executionTrace: TraceEntry[];
      let orchestratorUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0 };
      let subagentUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      // ── HANDOFF MODE ───────────────────────────────────────────────────────
      if (executionMode === 'handoff') {
        const entryAgent = this.getNodeParameter('entryAgent', i, '') as string;
        const maxHops = this.getNodeParameter('maxHops', i, 5) as number;

        if (!entryAgent) {
          throw new NodeOperationError(
            this.getNode(),
            'Entry Agent is required in Handoff Chain mode.',
            { itemIndex: i },
          );
        }
        if (!agentMap.has(entryAgent)) {
          throw new NodeOperationError(
            this.getNode(),
            `Entry agent "${entryAgent}" not found. Available: ${[...agentMap.keys()].join(', ') || 'none connected'}`,
            { itemIndex: i },
          );
        }

        // Build user-defined routing map
        const routingMapRaw = this.getNodeParameter('routingMap', i, { route: [] }) as {
          route: Array<{ action: string; agentName: string }>;
        };
        const routingMap: Record<string, string> = {};
        for (const r of routingMapRaw.route ?? []) {
          if (r.action && r.agentName) routingMap[r.action] = r.agentName;
        }

        // Build terminal actions set from the user-defined comma-separated string
        const terminalActionsRaw = this.getNodeParameter('terminalActions', i, 'none') as string;
        const terminalActions = new Set(
          terminalActionsRaw.split(',').map((s) => s.trim()).filter(Boolean),
        );

        const chainResult = await runHandoffChain({
          entryAgent,
          message: userMessage,
          agentMap,
          sessionId,
          history: memHistory,
          maxHops,
          routingMap,
          terminalActions,
        });

        finalResponse = chainResult.response;
        executionTrace = chainResult.trace;
        subagentUsage = {
          prompt_tokens: chainResult.usage.prompt_tokens,
          completion_tokens: chainResult.usage.completion_tokens,
          total_tokens: chainResult.usage.total_tokens,
        };

      // ── ORCHESTRATOR MODE ──────────────────────────────────────────────────
      } else {
        const baseSystemPrompt = this.getNodeParameter('systemPrompt', i) as string;
        const maxIterations = this.getNodeParameter('maxIterations', i, 20) as number;
        const skillsField = this.getNodeParameter('skillsField', i, '__skills__') as string;

        const inlineSkillsRaw = this.getNodeParameter('inlineSkills', i, { skill: [] }) as {
          skill: Array<{ name: string; description: string; content: string }>;
        };
        const inlineSkills: Skill[] = (inlineSkillsRaw.skill ?? [])
          .filter((s) => s.name)
          .map((s) => {
            const rawContent = s.content ?? '';
            const content = String(resolveField(item.json, rawContent) ?? rawContent);
            return { name: s.name, description: s.description, content, tags: [] };
          });

        const rawLoaderSkills = resolveField(item.json, skillsField);
        const loaderSkills = (Array.isArray(rawLoaderSkills) ? rawLoaderSkills : []) as Skill[];
        const loaderNames = new Set(loaderSkills.map((s) => s.name));
        const skills: Skill[] = [
          ...inlineSkills.filter((s) => !loaderNames.has(s.name)),
          ...loaderSkills,
        ];

        const systemPrompt = composeSystemPrompt(baseSystemPrompt, skills);
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          { role: 'system', content: systemPrompt },
          ...memHistory.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          { role: 'user', content: userMessage },
        ];

        executionTrace = [];
        const agentTools = subAgentsToTools(subAgents, sessionId, executionTrace, messages);
        const skillTool = skills.length > 0 ? [buildSkillTool(skills)] : [];
        const allTools = [...agentTools, ...mcpTools, ...skillTool];

        const loopResult = await runAgentLoop({
          openai, model, messages, tools: allTools, maxIterations,
          forceToolUse: agentTools.length > 0,
        });

        finalResponse = loopResult.response;
        orchestratorUsage = loopResult.usage;

        if (!finalResponse) {
          throw new NodeOperationError(
            this.getNode(),
            `Orchestrator did not produce a response after ${maxIterations} iteration(s).`,
            { itemIndex: i },
          );
        }

        subagentUsage = executionTrace.reduce(
          (acc, t) => ({
            prompt_tokens: acc.prompt_tokens + t.usage.prompt_tokens,
            completion_tokens: acc.completion_tokens + t.usage.completion_tokens,
            total_tokens: acc.total_tokens + t.usage.total_tokens,
          }),
          { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        );
      }

      // ── Post guardrails + memory write (both modes) ────────────────────────
      const postBlock = await runGuardrails(finalResponse, guardrailConfigs, 'post', openai, model);
      if (postBlock !== null) finalResponse = postBlock;

      if (memory) memory.addMessage(sessionId, { role: 'assistant', content: finalResponse });

      results.push({
        json: {
          ...item.json,
          [outputField]: finalResponse,
          executionTrace,
          usage: {
            ...orchestratorUsage,
            model,
            mode: executionMode,
            subagent_prompt_tokens: subagentUsage.prompt_tokens,
            subagent_completion_tokens: subagentUsage.completion_tokens,
            subagent_total_tokens: subagentUsage.total_tokens,
            grand_total_tokens: orchestratorUsage.total_tokens + subagentUsage.total_tokens,
          },
        } as INodeExecutionData['json'],
        pairedItem: { item: i },
      });
    }

    return [results];
  }
}
