import { runHandoffChain, parseAgentOutput, resolveNextAgent } from '../utils/handoffChain';
import type { SubAgent } from '../nodes/SubAgentKit/SubAgentKit.node';

function makeAgent(name: string, response: string, stateless = true): SubAgent {
  return {
    name,
    description: name,
    stateless,
    call: async () => ({ response, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, iterations: 1 } }),
  };
}

// ─── parseAgentOutput ─────────────────────────────────────────────────────────

describe('parseAgentOutput', () => {
  it('extracts content_raw and action from JSON', () => {
    const raw = JSON.stringify({ content_raw: 'Hello!', crm_instructions: { action: 'route_to_sofia' } });
    expect(parseAgentOutput(raw)).toEqual({ contentRaw: 'Hello!', action: 'route_to_sofia' });
  });

  it('extracts resposta_para_cliente (Sofia output format)', () => {
    const raw = JSON.stringify({ resposta_para_cliente: 'Oi!', crm_instructions: { action: 'none' } });
    expect(parseAgentOutput(raw)).toEqual({ contentRaw: 'Oi!', action: 'none' });
  });

  it('defaults action to none when crm_instructions is missing', () => {
    const raw = JSON.stringify({ content_raw: 'ok' });
    expect(parseAgentOutput(raw)).toEqual({ contentRaw: 'ok', action: 'none' });
  });

  it('falls back to raw string when output is not JSON', () => {
    expect(parseAgentOutput('plain text')).toEqual({ contentRaw: 'plain text', action: 'none' });
  });

  it('prefers content_raw over resposta_para_cliente when both exist', () => {
    const raw = JSON.stringify({ content_raw: 'A', resposta_para_cliente: 'B', crm_instructions: { action: 'none' } });
    expect(parseAgentOutput(raw)).toEqual({ contentRaw: 'A', action: 'none' });
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

  it('resolves route_to_sofia via generic pattern', () => {
    expect(resolveNextAgent('route_to_sofia', agents)).toBe('sofia');
  });

  it('resolves user-defined alias via routingMap', () => {
    expect(resolveNextAgent('route_to_closer', agents, { route_to_closer: 'aurora' })).toBe('aurora');
  });

  it('routingMap takes priority over generic pattern', () => {
    // action "route_to_sofia" remapped to julia via user config
    expect(resolveNextAgent('route_to_sofia', agents, { route_to_sofia: 'julia' })).toBe('julia');
  });

  it('returns undefined when action does not match any agent without routingMap', () => {
    expect(resolveNextAgent('route_to_closer', agents)).toBeUndefined();
  });

  it('returns undefined for unknown agent even with prefix stripped', () => {
    expect(resolveNextAgent('route_to_unknown', agents)).toBeUndefined();
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
      crm_instructions: { action: 'none' },
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

  it('chains gabi → sofia when action is route_to_sofia', async () => {
    const agentsCalled: string[] = [];

    const agentMap = new Map<string, SubAgent>([
      ['gabi', {
        name: 'gabi', description: '', stateless: true,
        call: async (ctx) => {
          agentsCalled.push('gabi');
          return {
            response: JSON.stringify({ content_raw: `Passando para Sofia: ${ctx.task}`, crm_instructions: { action: 'route_to_sofia' } }),
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, iterations: 1 },
          };
        },
      }],
      ['sofia', {
        name: 'sofia', description: '', stateless: true,
        call: async () => {
          agentsCalled.push('sofia');
          return {
            response: JSON.stringify({ resposta_para_cliente: 'Qualificando...', crm_instructions: { action: 'none' } }),
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, iterations: 1 },
          };
        },
      }],
    ]);

    const result = await runHandoffChain({
      entryAgent: 'gabi', message: 'preciso de ajuda', agentMap,
      sessionId: 's1', history: [], maxHops: 5,
    });

    expect(agentsCalled).toEqual(['gabi', 'sofia']);
    expect(result.response).toBe('Qualificando...');
    expect(result.trace).toHaveLength(2);
  });

  it('chains gabi → sofia → aurora using user-defined routingMap', async () => {
    const agentsCalled: string[] = [];

    const agentMap = new Map<string, SubAgent>([
      ['gabi', { name: 'gabi', description: '', stateless: true, call: async () => { agentsCalled.push('gabi'); return { response: JSON.stringify({ content_raw: 'ok', crm_instructions: { action: 'route_to_sofia' } }), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, iterations: 1 } }; } }],
      ['sofia', { name: 'sofia', description: '', stateless: true, call: async () => { agentsCalled.push('sofia'); return { response: JSON.stringify({ resposta_para_cliente: 'qualificado', crm_instructions: { action: 'route_to_closer' } }), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, iterations: 1 } }; } }],
      ['aurora', { name: 'aurora', description: '', stateless: true, call: async () => { agentsCalled.push('aurora'); return { response: JSON.stringify({ content_raw: 'fechando!', crm_instructions: { action: 'none' } }), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, iterations: 1 } }; } }],
    ]);

    const result = await runHandoffChain({
      entryAgent: 'gabi', message: 'quero contratar', agentMap,
      sessionId: 's2', history: [], maxHops: 5,
      routingMap: { route_to_closer: 'aurora' },
      terminalActions: new Set(['none', 'disqualify']),
    });

    expect(agentsCalled).toEqual(['gabi', 'sofia', 'aurora']);
    expect(result.response).toBe('fechando!');
    expect(result.trace).toHaveLength(3);
  });

  it('stops on terminal action defined by user', async () => {
    const agentMap = new Map<string, SubAgent>([
      ['gabi', { name: 'gabi', description: '', stateless: true, call: async () => ({ response: JSON.stringify({ content_raw: 'Sem perfil.', crm_instructions: { action: 'disqualify' } }), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, iterations: 1 } }) }],
      ['sofia', { name: 'sofia', description: '', stateless: true, call: async () => ({ response: JSON.stringify({ resposta_para_cliente: 'should not be called', crm_instructions: { action: 'none' } }), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, iterations: 1 } }) }],
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
    // Agent always routes to itself — infinite loop protection
    const looper: SubAgent = {
      name: 'looper', description: '', stateless: true,
      call: async () => ({ response: JSON.stringify({ content_raw: 'loop', crm_instructions: { action: 'route_to_looper' } }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, iterations: 1 } }),
    };
    const agentMap = new Map([['looper', looper]]);

    const result = await runHandoffChain({
      entryAgent: 'looper', message: 'go', agentMap,
      sessionId: 's4', history: [], maxHops: 3,
    });

    expect(result.trace).toHaveLength(3);
  });

  it('aggregates usage from all hops', async () => {
    const agentMap = new Map<string, SubAgent>([
      ['a', { name: 'a', description: '', stateless: true, call: async () => ({ response: JSON.stringify({ content_raw: 'a', crm_instructions: { action: 'route_to_b' } }), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, iterations: 1 } }) }],
      ['b', { name: 'b', description: '', stateless: true, call: async () => ({ response: JSON.stringify({ content_raw: 'b', crm_instructions: { action: 'none' } }), usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, iterations: 1 } }) }],
    ]);

    const result = await runHandoffChain({
      entryAgent: 'a', message: 'start', agentMap,
      sessionId: 's5', history: [], maxHops: 5,
    });

    expect(result.usage.total_tokens).toBe(45);
    expect(result.usage.prompt_tokens).toBe(30);
    expect(result.usage.iterations).toBe(2);
  });

  it('passes accumulated history to stateless agents', async () => {
    const historySeen: Array<Array<{ role: string; content: string }>> = [];

    const agentMap = new Map<string, SubAgent>([
      ['a', { name: 'a', description: '', stateless: true, call: async (ctx) => { historySeen.push(ctx.history ?? []); return { response: JSON.stringify({ content_raw: 'reply-a', crm_instructions: { action: 'route_to_b' } }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, iterations: 1 } }; } }],
      ['b', { name: 'b', description: '', stateless: true, call: async (ctx) => { historySeen.push(ctx.history ?? []); return { response: JSON.stringify({ content_raw: 'reply-b', crm_instructions: { action: 'none' } }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, iterations: 1 } }; } }],
    ]);

    await runHandoffChain({
      entryAgent: 'a', message: 'hello', agentMap,
      sessionId: 's6', history: [], maxHops: 5,
    });

    // Agent A sees empty history (first call)
    expect(historySeen[0]).toHaveLength(0);
    // Agent B sees the exchange from agent A
    expect(historySeen[1]).toHaveLength(2);
    expect(historySeen[1][0]).toEqual({ role: 'user', content: 'hello' });
    expect(historySeen[1][1]).toEqual({ role: 'assistant', content: 'reply-a' });
  });
});
