import type {
  INodeType,
  INodeTypeDescription,
  ISupplyDataFunctions,
  SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { MemoryStore } from '../../utils/memoryStore';
import * as path from 'path';
import * as os from 'os';
import { mkdirSync } from 'fs';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface IAgentMemory {
  getMessages(sessionId: string): ChatMessage[];
  addMessage(sessionId: string, message: ChatMessage): void;
  get(key: string): string | null;
  set(key: string, value: string, ttlSeconds?: number): void;
  search(query: string): Array<{ key: string; value: string }>;
}

// Session buffers live in-process (not persisted to SQLite)
const sessionBuffers = new Map<string, ChatMessage[]>();

export class AgentMemory implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Agent Memory',
    name: 'agentMemory',
    icon: 'fa:database',
    group: ['transform'],
    version: 1,
    description: 'Provides short-term session memory and long-term SQLite storage for AgentKit.',
    defaults: { name: 'Agent Memory' },
    inputs: [],
    outputs: [{ type: NodeConnectionTypes.AiMemory }],
    outputNames: ['memory'],
    properties: [
      {
        displayName: 'SQLite Database Path',
        name: 'dbPath',
        type: 'string',
        default: path.join(os.homedir(), '.agentkit', 'memory.db'),
        description:
          'Absolute path to the SQLite database file. Directory will be created if it does not exist.',
      },
      {
        displayName: 'Session Window Size',
        name: 'windowSize',
        type: 'number',
        default: 20,
        description: 'Maximum number of messages to retain per session (short-term buffer).',
      },
    ],
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const dbPath = this.getNodeParameter('dbPath', itemIndex) as string;
    const windowSize = this.getNodeParameter('windowSize', itemIndex, 20) as number;

    mkdirSync(path.dirname(dbPath), { recursive: true });

    const store = new MemoryStore(dbPath);

    const memory: IAgentMemory = {
      getMessages(sessionId: string): ChatMessage[] {
        return sessionBuffers.get(sessionId) ?? [];
      },

      addMessage(sessionId: string, message: ChatMessage): void {
        const buffer = sessionBuffers.get(sessionId) ?? [];
        buffer.push(message);
        if (buffer.length > windowSize) {
          buffer.splice(0, buffer.length - windowSize);
        }
        sessionBuffers.set(sessionId, buffer);
      },

      get(key: string): string | null {
        return store.get(key);
      },

      set(key: string, value: string, ttlSeconds?: number): void {
        store.set(key, value, ttlSeconds);
      },

      search(query: string) {
        return store.search(query);
      },
    };

    return {
      response: memory,
      closeFunction: async () => store.close(),
    };
  }
}
