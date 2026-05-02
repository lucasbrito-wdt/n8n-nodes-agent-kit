import { runHandoffChain, parseAgentOutput, resolveNextAgent } from '../utils/handoffChain';
import type { SubAgent } from '../nodes/SubAgentKit/SubAgentKit.node';

function makeAgent(name: string, response: string, stateless = true): SubAgent {
  return {
    name,
    description: name,
    stateless,
    actions: [],
    outputContentKey: 'content_raw', outputInstructionsKey: 'instructions',
    call: async () => ({ response, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, iterations: 1 } }),
  };
}

// ─── parseAgentOutput ─────────────────────────────────────────────────────────

describe('parseAgentOutput', () => {
  it('extracts content and action using explicit keys', () => {
    const raw = JSON.stringify({ reply: 'Hello!', routing: { action: 'go_sofia' } });
    expect(parseAgentOutput(raw, 'reply', 'routing')).toEqual({ contentRaw: 'Hello!', action: 'go_sofia' });
  });

  it('uses default keys (content_raw, instructions) when none provided', () => {
    const raw = JSON.stringify({ content_raw: 'Hi', instructions: { action: 'done' } });
    expect(parseAgentOutput(raw)).toEqual({ contentRaw: 'Hi', action: 'done' });
  });

  it('defaults action to none when instructions block is missing', () => {
    const raw = JSON.stringify({ content_raw: 'ok' });
    expect(parseAgentOutput(raw)).toEqual({ contentRaw: 'ok', action: 'none' });
  });

  it('falls back to raw string when output is not JSON', () => {
    expect(parseAgentOutput('plain text')).toEqual({ contentRaw: 'plain text', action: 'none' });
  });

  it('uses the configured contentKey to extract the message', () => {
    const raw = JSON.stringify({ message: 'Olá!', ctrl: { action: 'stop' } });
    expect(parseAgentOutput(raw, 'message', 'ctrl')).toEqual({ contentRaw: 'Olá!', action: 'stop' });
  });

  it('falls back to raw string when contentKey is not found', () => {
    const raw = JSON.stringify({ other: 'x', instructions: { action: 'none' } });
    expect(parseAgentOutput(raw, 'content_raw', 'instructions')).toEqual({ contentRaw: raw, action: 'none' });
  });
});

// ─── resolveNextAgent ─────────────────────────────────────────────────────────

describe('resolveNextAgent', () => {
  const agents = new Map([
    ['gabi', makeAgent('gabi', '')],
    ['sofia', makeAgent('sofia', '')],
    ['aurora', makeAgent('aurora', '')],
    ['julia', makeAgent('julia', '')],
  ]);

  it('returns undefined for route_to_sofia without routingMap', () => {
    expect(resolveNextAgent('route_to_sofia', agents)).toBeUndefined();
  });

  it('resolves user-defined alias via routingMap', () => {
    expect(resolveNextAgent('route_to_closer', agents, { route_to_closer: 'aurora' })).toBe('aurora');
  });

  it('routingMap takes priority over generic pattern', () => {
    // action "route_to_sofia" remapped to julia via user config
    expect(resolveNextAgent('route_to_sofia', agents, { route_to_sofia: 'julia' })).toBe('julia');
  });

  it('returns undefined for any action without routingMap entry', () => {
    expect(resolveNextAgent('route_to_closer', agents)).toBeUndefined();
    expect(resolveNextAgent('route_to_unknown', agents)).toBeUndefined();
    expect(resolveNextAgent('anything', agents)).toBeUndefined();
  });

  it('returns undefined when no routingMap entry and name not in agentMap', () => {
    expect(resolveNextAgent('escalate', agents)).toBeUndefined();
  });

  it('resolves arbitrary action via routingMap (no route_to_ prefix)', () => {
    expect(resolveNextAgent('escalate', agents, { escalate: 'julia' })).toBe('julia');
  });
});

// ─── runHandoffChain ──────────────────────────────────────────────────────────

describe('runHandoffChain', () => {
  it('calls entry agent and returns response when action is none', async () => {
    const gabi = makeAgent('gabi', JSON.stringify({
      content_raw: 'Olá!',
      instructions: { action: 'none' },
    }));
    const agentMap = new Map([['gabi', gabi]]);

    const result = await runHandoffChain({
      entryAgent: 'gabi', message: 'oi', agentMap,
      sessionId: 's1', history: [], maxHops: 5,
    });

    expect(result.response).toBe('Olá!');
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0].agent).toBe('gabi');
  });

  it('chains gabi → sofia via explicit routingMap', async () => {
    const agentsCalled: string[] = [];

    const agentMap = new Map<string, SubAgent>([
      ['gabi', {
        name: 'gabi', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions',
        call: async (ctx) => {
          agentsCalled.push('gabi');
          return {
            response: JSON.stringify({ content_raw: `Passando para Sofia: ${ctx.task}`, instructions: { action: 'route_to_sofia' } }),
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, iterations: 1 },
          };
        },
      }],
      ['sofia', {
        name: 'sofia', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions',
        call: async () => {
          agentsCalled.push('sofia');
          return {
            response: JSON.stringify({ content_raw: 'Qualificando...', instructions: { action: 'none' } }),
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, iterations: 1 },
          };
        },
      }],
    ]);

    const result = await runHandoffChain({
      entryAgent: 'gabi', message: 'preciso de ajuda', agentMap,
      sessionId: 's1', history: [], maxHops: 5,
      routingMap: { route_to_sofia: 'sofia' },
      terminalActions: new Set(['none']),
    });

    expect(agentsCalled).toEqual(['gabi', 'sofia']);
    expect(result.response).toBe('Qualificando...');
    expect(result.trace).toHaveLength(2);
  });

  it('chains gabi → sofia → aurora using user-defined routingMap', async () => {
    const agentsCalled: string[] = [];

    const agentMap = new Map<string, SubAgent>([
      ['gabi', { name: 'gabi', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions', call: async () => { agentsCalled.push('gabi'); return { response: JSON.stringify({ content_raw: 'ok', instructions: { action: 'route_to_sofia' } }), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, iterations: 1 } }; } }],
      ['sofia', { name: 'sofia', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions', call: async () => { agentsCalled.push('sofia'); return { response: JSON.stringify({ content_raw: 'qualificado', instructions: { action: 'route_to_closer' } }), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, iterations: 1 } }; } }],
      ['aurora', { name: 'aurora', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions', call: async () => { agentsCalled.push('aurora'); return { response: JSON.stringify({ content_raw: 'fechando!', instructions: { action: 'none' } }), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, iterations: 1 } }; } }],
    ]);

    const result = await runHandoffChain({
      entryAgent: 'gabi', message: 'quero contratar', agentMap,
      sessionId: 's2', history: [], maxHops: 5,
      routingMap: { route_to_sofia: 'sofia', route_to_closer: 'aurora' },
      terminalActions: new Set(['none', 'disqualify']),
    });

    expect(agentsCalled).toEqual(['gabi', 'sofia', 'aurora']);
    expect(result.response).toBe('fechando!');
    expect(result.trace).toHaveLength(3);
  });

  it('stops on terminal action defined by user', async () => {
    const agentMap = new Map<string, SubAgent>([
      ['gabi', { name: 'gabi', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions', call: async () => ({ response: JSON.stringify({ content_raw: 'Sem perfil.', instructions: { action: 'disqualify' } }), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, iterations: 1 } }) }],
      ['sofia', { name: 'sofia', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions', call: async () => ({ response: JSON.stringify({ content_raw: 'should not be called', instructions: { action: 'none' } }), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, iterations: 1 } }) }],
    ]);

    const result = await runHandoffChain({
      entryAgent: 'gabi', message: 'oi', agentMap,
      sessionId: 's3', history: [], maxHops: 5,
      terminalActions: new Set(['none', 'disqualify']),
    });

    expect(result.trace).toHaveLength(1);
    expect(result.response).toBe('Sem perfil.');
  });

  it('respects maxHops limit', async () => {
    const looper: SubAgent = {
      name: 'looper', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions',
      call: async () => ({ response: JSON.stringify({ content_raw: 'loop', instructions: { action: 'self' } }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, iterations: 1 } }),
    };
    const agentMap = new Map([['looper', looper]]);

    const result = await runHandoffChain({
      entryAgent: 'looper', message: 'go', agentMap,
      sessionId: 's4', history: [], maxHops: 3,
      routingMap: { self: 'looper' },
      terminalActions: new Set([]),
    });

    expect(result.trace).toHaveLength(3);
  });

  it('aggregates usage from all hops', async () => {
    const agentMap = new Map<string, SubAgent>([
      ['a', { name: 'a', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions', call: async () => ({ response: JSON.stringify({ content_raw: 'a', instructions: { action: 'go_b' } }), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, iterations: 1 } }) }],
      ['b', { name: 'b', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions', call: async () => ({ response: JSON.stringify({ content_raw: 'b', instructions: { action: 'done' } }), usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, iterations: 1 } }) }],
    ]);

    const result = await runHandoffChain({
      entryAgent: 'a', message: 'start', agentMap,
      sessionId: 's5', history: [], maxHops: 5,
      routingMap: { go_b: 'b' },
      terminalActions: new Set(['done']),
    });

    expect(result.usage.total_tokens).toBe(45);
    expect(result.usage.prompt_tokens).toBe(30);
    expect(result.usage.iterations).toBe(2);
  });

  it('passes accumulated history to stateless agents', async () => {
    const historySeen: Array<Array<{ role: string; content: string }>> = [];

    const agentMap = new Map<string, SubAgent>([
      ['a', { name: 'a', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions', call: async (ctx) => { historySeen.push(ctx.history ?? []); return { response: JSON.stringify({ content_raw: 'reply-a', instructions: { action: 'go_b' } }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, iterations: 1 } }; } }],
      ['b', { name: 'b', description: '', stateless: true, actions: [], outputContentKey: 'content_raw', outputInstructionsKey: 'instructions', call: async (ctx) => { historySeen.push(ctx.history ?? []); return { response: JSON.stringify({ content_raw: 'reply-b', instructions: { action: 'done' } }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, iterations: 1 } }; } }],
    ]);

    await runHandoffChain({
      entryAgent: 'a', message: 'hello', agentMap,
      sessionId: 's6', history: [], maxHops: 5,
      routingMap: { go_b: 'b' },
      terminalActions: new Set(['done']),
    });

    expect(historySeen[0]).toHaveLength(0);
    expect(historySeen[1]).toHaveLength(2);
    expect(historySeen[1][0]).toEqual({ role: 'user', content: 'hello' });
    expect(historySeen[1][1]).toEqual({ role: 'assistant', content: 'reply-a' });
  });
});
