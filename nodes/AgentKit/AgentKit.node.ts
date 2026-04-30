import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import OpenAI from 'openai';
import type { IAgentMemory } from '../AgentMemory/AgentMemory.node';
import type { McpTool } from '../McpGateway/McpGateway.node';
import type { Skill } from '../../utils/skillParser';

function composeSystemPrompt(base: string, skills: Skill[]): string {
  if (skills.length === 0) return base;
  const skillsBlock = skills
    .map((s) => `## Skill: ${s.name}\n${s.content}`)
    .join('\n\n');
  return `${base}\n\n---\n\n${skillsBlock}`;
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

export class AgentKit implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Agent Kit',
    name: 'agentKit',
    icon: 'fa:robot',
    group: ['transform'],
    version: 1,
    description: 'AI agent with dynamic skill loading, persistent memory, and MCP tool support.',
    defaults: { name: 'Agent Kit' },
    inputs: [
      NodeConnectionTypes.Main,
      { type: NodeConnectionTypes.AiMemory, required: false },
      { type: NodeConnectionTypes.AiTool, required: false },
    ],
    inputNames: ['input', 'memory', 'tools'],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'openRouterApi',
        required: true,
      },
    ],
    properties: [
      {
        displayName: 'Input Message Field',
        name: 'inputField',
        type: 'string',
        default: 'message',
        description: 'Field in the input JSON that contains the user message.',
      },
      {
        displayName: 'Session ID Field',
        name: 'sessionIdField',
        type: 'string',
        default: 'sessionId',
        description: 'Field in the input JSON used to identify the session for memory.',
      },
      {
        displayName: 'Base System Prompt',
        name: 'systemPrompt',
        type: 'string',
        typeOptions: { rows: 6 },
        default: 'You are a helpful AI assistant.',
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
        description: 'Maximum tool-calling iterations before returning.',
      },
      {
        displayName: 'Output Field',
        name: 'outputField',
        type: 'string',
        default: 'response',
        description: 'Field name in the output JSON for the agent response.',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const results: INodeExecutionData[] = [];

    // Credentials and sub-node connections are shared across all items
    const creds = await this.getCredentials('openRouterApi');
    const openai = new OpenAI({
      apiKey: creds.apiKey as string,
      baseURL: (creds.baseUrl as string) || 'https://openrouter.ai/api/v1',
      defaultHeaders: creds.httpReferer
        ? { 'X-Title': creds.httpReferer as string }
        : undefined,
    });
    // Get memory sub-node (optional)
    let memory: IAgentMemory | null = null;
    try {
      const memoryData = await this.getInputConnectionData(NodeConnectionTypes.AiMemory, 0);
      if (Array.isArray(memoryData) && memoryData.length > 0) {
        memory = (memoryData[0] as { response: IAgentMemory }).response;
      }
    } catch {
      // no memory connected — ok
    }

    // Get MCP tools sub-node (optional)
    let tools: McpTool[] = [];
    try {
      const toolData = await this.getInputConnectionData(NodeConnectionTypes.AiTool, 0);
      if (Array.isArray(toolData) && toolData.length > 0) {
        tools = (toolData[0] as { response: McpTool[] }).response;
      }
    } catch {
      // no tools connected — ok
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Read per-item to support expression-based property values
      const inputField = this.getNodeParameter('inputField', i) as string;
      const sessionIdField = this.getNodeParameter('sessionIdField', i) as string;
      const baseSystemPrompt = this.getNodeParameter('systemPrompt', i) as string;
      const modelOverride = this.getNodeParameter('modelOverride', i, '') as string;
      const maxIterations = this.getNodeParameter('maxIterations', i, 10) as number;
      const outputField = this.getNodeParameter('outputField', i, 'response') as string;
      const model = modelOverride || (creds.model as string) || 'qwen/qwen3-235b-a22b';

      const userMessage = String(item.json[inputField] ?? '');
      const sessionId = String(item.json[sessionIdField] ?? `session-${i}`);
      const skills = (item.json.__skills__ ?? []) as Skill[];

      if (!userMessage) {
        throw new NodeOperationError(
          this.getNode(),
          `Input field "${inputField}" is empty or missing.`,
          { itemIndex: i },
        );
      }

      const systemPrompt = composeSystemPrompt(baseSystemPrompt, skills);

      const history = memory ? memory.getMessages(sessionId) : [];
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user', content: userMessage },
      ];

      if (memory) memory.addMessage(sessionId, { role: 'user', content: userMessage });

      const openaiTools = tools.length > 0 ? toolsToOpenAI(tools) : undefined;
      let finalResponse = '';
      let iteration = 0;

      while (iteration < Math.max(1, maxIterations)) {
        iteration++;
        const response = await openai.chat.completions.create({
          model,
          messages,
          ...(openaiTools ? { tools: openaiTools, tool_choice: 'auto' } : {}),
        });

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
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResult,
            });
          }
          continue;
        }

        finalResponse = assistantMsg.content ?? '';
        break;
      }

      if (!finalResponse) {
        throw new NodeOperationError(
          this.getNode(),
          `Agent did not produce a response after ${maxIterations} iteration(s). The model may be stuck in a tool-calling loop.`,
          { itemIndex: i },
        );
      }

      if (memory) memory.addMessage(sessionId, { role: 'assistant', content: finalResponse });

      // Remove internal __skills__ field from output
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { __skills__: _unused, ...cleanJson } = item.json as Record<string, unknown>;

      results.push({
        json: { ...cleanJson, [outputField]: finalResponse } as INodeExecutionData['json'],
        pairedItem: { item: i },
      });
    }

    return [results];
  }
}
