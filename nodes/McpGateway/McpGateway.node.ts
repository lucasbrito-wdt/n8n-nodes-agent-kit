import type {
  INodeType,
  INodeTypeDescription,
  ISupplyDataFunctions,
  SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<string>;
}

export class McpGateway implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'MCP Gateway',
    name: 'mcpGateway',
    icon: 'fa:plug',
    group: ['transform'],
    version: 1,
    description:
      'Connects to external MCP servers (client mode) and/or exposes n8n webhooks as MCP tools (server mode).',
    defaults: { name: 'MCP Gateway' },
    inputs: [],
    outputs: [{ type: NodeConnectionTypes.AiTool }],
    outputNames: ['tool'],
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        options: [
          { name: 'Client Only', value: 'client' },
          { name: 'Server Only', value: 'server' },
          { name: 'Both', value: 'both' },
        ],
        default: 'client',
      },
      // ----- Client config -----
      {
        displayName: 'MCP Server URL',
        name: 'serverUrl',
        type: 'string',
        default: 'http://localhost:3000/mcp',
        description: 'SSE endpoint of the MCP server to connect to.',
        displayOptions: { show: { mode: ['client', 'both'] } },
      },
      {
        displayName: 'Authentication',
        name: 'authType',
        type: 'options',
        options: [
          { name: 'None', value: 'none' },
          { name: 'Bearer Token', value: 'bearer' },
          { name: 'Custom Header', value: 'header' },
        ],
        default: 'none',
        displayOptions: { show: { mode: ['client', 'both'] } },
      },
      {
        displayName: 'Bearer Token',
        name: 'bearerToken',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        displayOptions: { show: { mode: ['client', 'both'], authType: ['bearer'] } },
      },
      {
        displayName: 'Header Name',
        name: 'headerName',
        type: 'string',
        default: 'X-API-Key',
        displayOptions: { show: { mode: ['client', 'both'], authType: ['header'] } },
      },
      {
        displayName: 'Header Value',
        name: 'headerValue',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        displayOptions: { show: { mode: ['client', 'both'], authType: ['header'] } },
      },
      {
        displayName: 'Tools to Include',
        name: 'toolFilter',
        type: 'options',
        options: [
          { name: 'All', value: 'all' },
          { name: 'Selected', value: 'selected' },
          { name: 'All Except', value: 'except' },
        ],
        default: 'all',
        displayOptions: { show: { mode: ['client', 'both'] } },
      },
      {
        displayName: 'Tool Names',
        name: 'toolNames',
        type: 'string',
        default: '',
        description: 'Comma-separated tool names for Selected or All Except filters.',
        displayOptions: {
          show: { mode: ['client', 'both'], toolFilter: ['selected', 'except'] },
        },
      },
      // ----- Server config -----
      {
        displayName: 'Exposed Workflows',
        name: 'exposedWorkflows',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description: 'n8n webhook workflows to expose as MCP tools.',
        displayOptions: { show: { mode: ['server', 'both'] } },
        options: [
          {
            name: 'workflow',
            displayName: 'Workflow',
            values: [
              {
                displayName: 'Tool Name',
                name: 'toolName',
                type: 'string',
                default: '',
                description: 'Name MCP clients will see (snake_case, e.g. search_leads)',
              },
              {
                displayName: 'Tool Description',
                name: 'toolDescription',
                type: 'string',
                default: '',
              },
              {
                displayName: 'Webhook URL',
                name: 'webhookUrl',
                type: 'string',
                default: '',
                description: 'n8n webhook URL that executes this workflow',
              },
            ],
          },
        ],
      },
    ],
  };

  async supplyData(this: ISupplyDataFunctions): Promise<SupplyData> {
    const mode = this.getNodeParameter('mode', 0) as string;
    const tools: McpTool[] = [];

    if (mode === 'client' || mode === 'both') {
      const serverUrl = this.getNodeParameter('serverUrl', 0) as string;
      const authType = this.getNodeParameter('authType', 0, 'none') as string;
      const toolFilter = this.getNodeParameter('toolFilter', 0, 'all') as string;
      const toolNamesRaw = this.getNodeParameter('toolNames', 0, '') as string;
      const toolNamesList = toolNamesRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const headers: Record<string, string> = {};
      if (authType === 'bearer') {
        const token = this.getNodeParameter('bearerToken', 0, '') as string;
        headers['Authorization'] = `Bearer ${token}`;
      } else if (authType === 'header') {
        const name = this.getNodeParameter('headerName', 0, 'X-API-Key') as string;
        const value = this.getNodeParameter('headerValue', 0, '') as string;
        headers[name] = value;
      }

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

      const client = new Client({ name: 'n8n-agent-kit', version: '0.1.0' });

      const hasHeaders = Object.keys(headers).length > 0;
      const transport = new SSEClientTransport(new URL(serverUrl), {
        ...(hasHeaders && {
          eventSourceInit: { headers } as Record<string, unknown>,
          requestInit: { headers },
        }),
      });

      await client.connect(transport);

      const { tools: mcpTools } = await client.listTools();

      for (const tool of mcpTools) {
        const include =
          toolFilter === 'all' ||
          (toolFilter === 'selected' && toolNamesList.includes(tool.name)) ||
          (toolFilter === 'except' && !toolNamesList.includes(tool.name));

        if (!include) continue;

        tools.push({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
          call: async (args) => {
            const result = await client.callTool({ name: tool.name, arguments: args });
            return JSON.stringify(result.content);
          },
        });
      }
    }

    if (mode === 'server' || mode === 'both') {
      const exposedWorkflows = this.getNodeParameter('exposedWorkflows', 0, {
        workflow: [],
      }) as {
        workflow: Array<{ toolName: string; toolDescription: string; webhookUrl: string }>;
      };

      for (const wf of exposedWorkflows.workflow ?? []) {
        if (!wf.toolName || !wf.webhookUrl) continue;

        tools.push({
          name: wf.toolName,
          description: wf.toolDescription || wf.toolName,
          inputSchema: {
            type: 'object',
            properties: { input: { type: 'string' } },
            additionalProperties: true,
          },
          call: async (args) => {
            const res = await fetch(wf.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(args),
            });
            if (!res.ok) throw new Error(`Webhook error: ${res.status}`);
            return await res.text();
          },
        });
      }
    }

    return { response: tools };
  }
}
