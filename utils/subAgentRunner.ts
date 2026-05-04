import type OpenAI from 'openai';
import type { McpTool } from '../nodes/McpGateway/McpGateway.node';

export interface AgentLoopParams {
  openai: OpenAI;
  model: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools: McpTool[];
  maxIterations: number;
  forceToolUse?: boolean;
}

export interface AgentLoopResult {
  response: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; iterations: number };
}

function toolsToOpenAI(tools: McpTool[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown> },
  }));
}

export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const { openai, model, tools, maxIterations, forceToolUse = false } = params;
  const messages = [...params.messages];
  const openaiTools = tools.length > 0 ? toolsToOpenAI(tools) : undefined;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0 };
  let finalResponse = '';
  let toolChoiceUnsupported = false;

  while (usage.iterations < Math.max(1, maxIterations)) {
    usage.iterations++;
    const isFirstIteration = usage.iterations === 1;
    const toolChoice = openaiTools && !toolChoiceUnsupported
      ? (forceToolUse && isFirstIteration ? 'required' : 'auto')
      : undefined;
    let response;
    try {
      response = await openai.chat.completions.create({
        model, messages,
        ...(openaiTools ? { tools: openaiTools, ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}),
      });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!toolChoiceUnsupported && /tool_choice/i.test(msg)) {
        toolChoiceUnsupported = true;
        usage.iterations--;
        continue;
      }
      throw err;
    }

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
