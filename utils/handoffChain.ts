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
 * Extracts the user-facing text and routing action from an agent's JSON output.
 *
 * @param raw              Raw string returned by the agent.
 * @param contentKey       JSON key for the user-facing message (e.g. "content_raw").
 * @param instructionsKey  JSON key for the routing block (e.g. "routing").
 *
 * Falls back gracefully when the output is not valid JSON.
 */
export function parseAgentOutput(
  raw: string,
  contentKey = 'content_raw',
  instructionsKey = 'instructions',
): { contentRaw: string; action: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const contentRaw = String(parsed[contentKey] ?? raw);
    const block = parsed[instructionsKey] as Record<string, unknown> | undefined;
    const action = String(block?.['action'] ?? 'none');
    return { contentRaw, action };
  } catch {
    return { contentRaw: raw, action: 'none' };
  }
}

/**
 * Resolves the next agent name from a routing action value.
 * Only the user-defined routingMap is consulted — no automatic inference.
 */
export function resolveNextAgent(
  action: string,
  agentMap: Map<string, SubAgent>,
  routingMap: Record<string, string> = {},
): string | undefined {
  const target = routingMap[action];
  if (!target) return undefined;
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
  /** Actions that stop the chain. */
  terminalActions?: Set<string>;
}

/**
 * Runs a deterministic handoff chain.
 *
 * Each agent returns structured JSON parsed using its own configured
 * contentKey and instructionsKey. Routing is driven purely by the
 * user-defined routingMap — no automatic inference.
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

    // Use each agent's own configured keys
    const { contentRaw, action } = parseAgentOutput(
      result.response,
      agent.outputContentKey,
      agent.outputInstructionsKey,
    );
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
