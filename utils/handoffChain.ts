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

/** Terminal actions that stop the handoff chain. */
export const TERMINAL_ACTIONS = new Set([
  'none', 'disqualify', 'human_handoff',
  'contract_generated', 'awaiting_signature', 'generate_financial',
  'follow_up_closer', 'follow_up_sdr',
]);

/**
 * Resolves the next agent name from a crm_instructions.action value.
 * Supports built-in aliases (route_to_closer → aurora) and generic
 * "route_to_<name>" patterns where <name> matches a connected agent.
 */
export function resolveNextAgent(action: string, agentMap: Map<string, SubAgent>): string | undefined {
  const aliases: Record<string, string> = {
    route_to_closer: 'aurora',
    route_to_sdr: 'sofia',
  };
  const target = aliases[action] ?? action.replace(/^route_to_/, '');
  return agentMap.has(target) ? target : undefined;
}

/**
 * Extracts the user-facing text and routing action from any agent output.
 * Handles all output key conventions used across agents:
 *   - content_raw   (Gabi, Aurora, Julia)
 *   - resposta_para_cliente  (Sofia)
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

export interface HandoffChainParams {
  entryAgent: string;
  message: string;
  agentMap: Map<string, SubAgent>;
  sessionId: string;
  /** Existing conversation history; will be extended in-place as the chain progresses. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxHops: number;
}

/**
 * Runs a deterministic handoff chain.
 *
 * Each agent returns structured JSON with crm_instructions.action.
 * The chain resolves the next agent from the action value and continues
 * until a terminal action is reached or maxHops is exceeded.
 * No orchestrator LLM is involved — routing is pure code.
 */
export async function runHandoffChain(params: HandoffChainParams): Promise<HandoffChainResult> {
  const { entryAgent, message, agentMap, sessionId, history, maxHops } = params;

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

    // Accumulate history so the next stateless agent has full context
    history.push({ role: 'user', content: currentTask });
    history.push({ role: 'assistant', content: contentRaw });

    if (TERMINAL_ACTIONS.has(action)) break;

    const nextAgent = resolveNextAgent(action, agentMap);
    if (!nextAgent) break;

    currentAgentName = nextAgent;
    currentTask = contentRaw;
  }

  return { response: finalResponse, trace, usage: totalUsage };
}
