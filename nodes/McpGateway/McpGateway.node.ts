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
      'Conecta a servidores MCP externos (modo cliente) e/ou expõe webhooks do n8n como ferramentas MCP (modo servidor).',
    defaults: { name: 'MCP Gateway' },
    inputs: [],
    outputs: [{ type: NodeConnectionTypes.AiTool }],
    outputNames: ['tool'],
    properties: [
      {
        displayName: 'Modo',
        name: 'mode',
        type: 'options',
        options: [
          { name: 'Somente Cliente', value: 'client' },
          { name: 'Somente Servidor', value: 'server' },
          { name: 'Ambos', value: 'both' },
        ],
        default: 'client',
      },
      // ----- Client config -----
      {
        displayName: 'URL do Servidor MCP',
        name: 'serverUrl',
        type: 'string',
        default: 'http://localhost:3000/mcp',
        description: 'Endpoint SSE do servidor MCP ao qual se conectar.',
        displayOptions: { show: { mode: ['client', 'both'] } },
      },
      {
        displayName: 'Autenticação',
        name: 'authType',
        type: 'options',
        options: [
          { name: 'Nenhuma', value: 'none' },
          { name: 'Bearer Token', value: 'bearer' },
          { name: 'Header Customizado', value: 'header' },
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
        displayName: 'Nome do Header',
        name: 'headerName',
        type: 'string',
        default: 'X-API-Key',
        displayOptions: { show: { mode: ['client', 'both'], authType: ['header'] } },
      },
      {
        displayName: 'Valor do Header',
        name: 'headerValue',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        displayOptions: { show: { mode: ['client', 'both'], authType: ['header'] } },
      },
      {
        displayName: 'Ferramentas a Incluir',
        name: 'toolFilter',
        type: 'options',
        options: [
          { name: 'Todas', value: 'all' },
          { name: 'Selecionadas', value: 'selected' },
          { name: 'Todas Exceto', value: 'except' },
        ],
        default: 'all',
        displayOptions: { show: { mode: ['client', 'both'] } },
      },
      {
        displayName: 'Nomes das Ferramentas',
        name: 'toolNames',
        type: 'string',
        default: '',
        description: 'Nomes de ferramentas separados por vírgula para os filtros Selecionadas ou Todas Exceto.',
        displayOptions: {
          show: { mode: ['client', 'both'], toolFilter: ['selected', 'except'] },
        },
      },
      // ----- Server config -----
      {
        displayName: 'Workflows Expostos',
        name: 'exposedWorkflows',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description: 'Workflows com webhook do n8n para expor como ferramentas MCP.',
        displayOptions: { show: { mode: ['server', 'both'] } },
        options: [
          {
            name: 'workflow',
            displayName: 'Workflow',
            values: [
              {
                displayName: 'Nome da Ferramenta',
                name: 'toolName',
                type: 'string',
                default: '',
                description: 'Nome que os clientes MCP verão (snake_case, ex: buscar_leads)',
              },
              {
                displayName: 'Descrição da Ferramenta',
                name: 'toolDescription',
                type: 'string',
                default: '',
              },
              {
                displayName: 'URL do Webhook',
                name: 'webhookUrl',
                type: 'string',
                default: '',
                description: 'URL do webhook do n8n que executa este workflow',
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

      try {
        await client.connect(transport);
      } catch (err) {
        throw new Error(
          `McpGateway: failed to connect to MCP server at "${serverUrl}": ${(err as Error).message}`,
        );
      }

      let mcpTools: Awaited<ReturnType<typeof client.listTools>>['tools'];
      try {
        ({ tools: mcpTools } = await client.listTools());
      } catch (err) {
        throw new Error(
          `McpGateway: failed to list tools from "${serverUrl}": ${(err as Error).message}`,
        );
      }

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
