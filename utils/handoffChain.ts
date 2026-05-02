import type { SubAgent, SubAgentContext, SubAgentUsage } from '../nodes/SubAgentKit/SubAgentKit.node';

export interface HandoffTraceEntry {
  step: number;
  agent: string;
  task: string;
  response: string;
  durationMs: number;
  usage: SubAgentUsage;
}

export interface HandoffChainResult {
  response: string;
  trace: HandoffTraceEntry[];
  usage: SubAgentUsage;
}

/**
 * Extracts the user-facing text and routing action from any agent output.
 * Supports multiple output key conventions:
 *   - content_raw            (most agents)
 *   - resposta_para_cliente  (Sofia-style)
 * Falls back to the raw string when the output is not valid JSON.
 */
export function parseAgentOutput(raw: string): { contentRaw: string; action: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const contentRaw = String(
      parsed['content_raw'] ?? parsed['resposta_para_cliente'] ?? raw,
    );
    const crm = parsed['crm_instructions'] as Record<string, unknown> | undefined;
    const action = String(crm?.['action'] ?? 'none');
    return { contentRaw, action };
  } catch {
    return { contentRaw: raw, action: 'none' };
  }
}

/**
 * Resolves the next agent name from a crm_instructions.action value.
 *
 * Resolution order:
 *  1. User-defined routingMap (action → agentName)
 *  2. Generic pattern: strips "route_to_" prefix and checks if the remainder
 *     matches a connected agent name
 *
 * Returns undefined when no match is found (chain stops).
 */
export function resolveNextAgent(
  action: string,
  agentMap: Map<string, SubAgent>,
  routingMap: Record<string, string> = {},
): string | undefined {
  const target = routingMap[action] ?? action.replace(/^route_to_/, '');
  return agentMap.has(target) ? target : undefined;
}

export interface HandoffChainParams {
  entryAgent: string;
  message: string;
  agentMap: Map<string, SubAgent>;
  sessionId: string;
  /** Existing conversation history; extended in-place as the chain progresses. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxHops: number;
  /** User-defined action → agentName routing table. */
  routingMap?: Record<string, string>;
  /** Actions that stop the chain. Defaults to ['none'] if not provided. */
  terminalActions?: Set<string>;
}

/**
 * Runs a deterministic handoff chain.
 *
 * Each agent returns structured JSON with crm_instructions.action.
 * The chain resolves the next agent using the user-defined routingMap
 * (and falls back to the "route_to_<name>" pattern) until a terminal
 * action is reached or maxHops is exceeded.
 * No orchestrator LLM is involved — routing is pure code.
 */
export async function runHandoffChain(params: HandoffChainParams): Promise<HandoffChainResult> {
  const {
    entryAgent, message, agentMap, sessionId, history, maxHops,
    routingMap = {},
    terminalActions = new Set(['none']),
  } = params;

  let currentAgentName = entryAgent;
  let currentTask = message;
  let finalResponse = '';
  const trace: HandoffTraceEntry[] = [];
  const totalUsage: SubAgentUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0 };

  for (let hop = 0; hop < maxHops; hop++) {
    const agent = agentMap.get(currentAgentName);
    if (!agent) break;

    const context: SubAgentContext = {
      task: currentTask,
      history: agent.stateless ? [...history] : undefined,
    };

    const start = Date.now();
    const result = await agent.call(context, sessionId);

    totalUsage.prompt_tokens += result.usage.prompt_tokens;
    totalUsage.completion_tokens += result.usage.completion_tokens;
    totalUsage.total_tokens += result.usage.total_tokens;
    totalUsage.iterations += result.usage.iterations;

    const { contentRaw, action } = parseAgentOutput(result.response);
    finalResponse = contentRaw;

    trace.push({
      step: trace.length + 1,
      agent: currentAgentName,
      task: currentTask.length > 300 ? currentTask.slice(0, 300) + '…' : currentTask,
      response: contentRaw.length > 500 ? contentRaw.slice(0, 500) + '…' : contentRaw,
      durationMs: Date.now() - start,
      usage: result.usage,
    });

    history.push({ role: 'user', content: currentTask });
    history.push({ role: 'assistant', content: contentRaw });

    if (terminalActions.has(action)) break;

    const nextAgent = resolveNextAgent(action, agentMap, routingMap);
    if (!nextAgent) break;

    currentAgentName = nextAgent;
    currentTask = contentRaw;
  }

  return { response: finalResponse, trace, usage: totalUsage };
}
