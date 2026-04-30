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
                  role: 'assistant', content: null,
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
      openai, model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [], maxIterations: 5,
    });
    expect(result.response).toBe('Hello!');
    expect(result.usage.iterations).toBe(1);
    expect(result.usage.total_tokens).toBe(15);
  });

  it('returns empty string if LLM returns no content', async () => {
    const openai = makeOpenAI(['']);
    const result = await runAgentLoop({
      openai, model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [], maxIterations: 5,
    });
    expect(result.response).toBe('');
  });

  it('calls a tool and returns the final reply', async () => {
    const tool: McpTool = {
      name: 'get_weather', description: 'Get weather',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      call: async () => 'sunny',
    };
    const openai = makeToolCallOpenAI('get_weather', '{"city":"Paris"}', 'The weather is sunny.');
    const result = await runAgentLoop({
      openai, model: 'test-model',
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      tools: [tool], maxIterations: 5,
    });
    expect(result.response).toBe('The weather is sunny.');
    expect(result.usage.iterations).toBe(2);
  });

  it('returns tool-not-found message when tool is missing', async () => {
    const openai = makeToolCallOpenAI('missing_tool', '{}', 'ok');
    const result = await runAgentLoop({
      openai, model: 'test-model',
      messages: [{ role: 'user', content: 'go' }],
      tools: [], maxIterations: 5,
    });
    expect(result.response).toBe('ok');
  });

  it('stops after maxIterations', async () => {
    const tool: McpTool = { name: 'loop_tool', description: 'loops', inputSchema: {}, call: async () => 'result' };
    const openai = makeToolCallOpenAI('loop_tool', '{}', 'never');
    const result = await runAgentLoop({
      openai, model: 'test-model',
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool], maxIterations: 1,
    });
    expect(result.usage.iterations).toBe(1);
    expect(result.response).toBe('');
  });
});
