import { runAgentLoop } from '../utils/subAgentRunner';
import type { SubAgent } from '../nodes/SubAgentKit/SubAgentKit.node';
import type { McpTool } from '../nodes/McpGateway/McpGateway.node';

function subAgentsToTools(subAgents: SubAgent[], sessionId: string): McpTool[] {
  return subAgents.map((agent) => ({
    name: agent.name,
    description: agent.description,
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
    },
    call: async (args: Record<string, unknown>) => {
      const result = await agent.call(String(args.task ?? ''), sessionId);
      return typeof result === 'string' ? result : result.response;
    },
  }));
}

describe('Orchestrator supervisor pattern', () => {
  it('calls a sub-agent tool and returns the final response', async () => {
    const researcher: SubAgent = {
      name: 'researcher',
      description: 'Does research',
      call: async (task) => ({ response: `Research result for: ${task}`, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0 } }),
    };

    let toolCallCount = 0;
    const openai: any = {
      chat: {
        completions: {
          create: async () => {
            toolCallCount++;
            if (toolCallCount === 1) {
              return {
                choices: [{
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant', content: null,
                    tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'researcher', arguments: '{"task":"AI trends"}' } }],
                  },
                }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            }
            return {
              choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Based on research: AI is growing.' } }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          },
        },
      },
    };

    const tools = subAgentsToTools([researcher], 'session-1');
    const result = await runAgentLoop({
      openai, model: 'test',
      messages: [
        { role: 'system', content: 'You are a supervisor.' },
        { role: 'user', content: 'Research AI trends and summarize.' },
      ],
      tools, maxIterations: 10,
    });

    expect(result.response).toBe('Based on research: AI is growing.');
    expect(result.usage.iterations).toBe(2);
  });

  it('handles multiple sub-agents', async () => {
    const researcher: SubAgent = { name: 'researcher', description: 'research', call: async () => ({ response: 'facts', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0 } }) };
    const writer: SubAgent = { name: 'writer', description: 'write', call: async () => ({ response: 'article', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0 } }) };

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
      name: 'tracker', description: 'tracks',
      call: async (task, sessionId) => { calls.push(sessionId); return { response: 'ok', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0 } }; },
    };
    const tools = subAgentsToTools([agent], 'my-session-id');
    await tools[0].call({ task: 'do something' });
    expect(calls).toEqual(['my-session-id']);
  });
});
