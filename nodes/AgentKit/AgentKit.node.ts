import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { resolveField } from '../../utils/fieldResolver';
import OpenAI from 'openai';
import type { IAgentMemory } from '../AgentMemory/AgentMemory.node';
import type { McpTool } from '../McpGateway/McpGateway.node';
import { composeSystemPrompt, buildSkillTool } from '../../utils/skillParser';
import type { Skill } from '../../utils/skillParser';
import { runAgentLoop } from '../../utils/subAgentRunner';
import { runGuardrails } from './guardrails/index';
import type { GuardrailConfig } from './guardrails/types';


export class AgentKit implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Agent Kit',
    name: 'agentKit',
    icon: 'fa:robot',
    group: ['transform'],
    version: 1,
    description: 'Agente de IA com carregamento dinâmico de skills, memória persistente e suporte a ferramentas MCP.',
    defaults: { name: 'Agent Kit' },
    inputs: [
      NodeConnectionTypes.Main,
      { type: NodeConnectionTypes.AiMemory, required: false },
      { type: NodeConnectionTypes.AiTool, required: false },
    ],
    inputNames: ['input', 'memory', 'tools'],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'openRouterApi',
        required: true,
      },
    ],
    properties: [
      {
        displayName: 'Campo da Mensagem de Entrada',
        name: 'inputField',
        type: 'string',
        default: 'message',
        description: 'Campo no JSON de entrada que contém a mensagem do usuário.',
      },
      {
        displayName: 'Campo do ID de Sessão',
        name: 'sessionIdField',
        type: 'string',
        default: 'sessionId',
        description: 'Campo no JSON de entrada usado para identificar a sessão na memória.',
      },
      {
        displayName: 'System Prompt Base',
        name: 'systemPrompt',
        type: 'string',
        typeOptions: { rows: 6 },
        default: 'Você é um assistente de IA prestativo.',
      },
      {
        displayName: 'Modelo Alternativo',
        name: 'modelOverride',
        type: 'string',
        default: '',
        description: 'Substitui o modelo das credenciais (ex: anthropic/claude-sonnet-4-5).',
      },
      {
        displayName: 'Máximo de Iterações',
        name: 'maxIterations',
        type: 'number',
        default: 10,
        description: 'Número máximo de iterações com ferramentas antes de retornar.',
      },
      {
        displayName: 'Campo de Saída',
        name: 'outputField',
        type: 'string',
        default: 'response',
        description: 'Nome do campo no JSON de saída para a resposta do agente.',
      },
      {
        displayName: 'Campo de Skills',
        name: 'skillsField',
        type: 'string',
        default: '__skills__',
        description: 'Caminho do campo no JSON de entrada que carrega skills do nó Skill Loader. Suporta notação de ponto/colchete (ex: __skills__, data.skills).',
      },
      {
        displayName: 'Skills Inline',
        name: 'inlineSkills',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description: 'Skills definidas diretamente. Skills de um nó Skill Loader conectado são mescladas e têm prioridade.',
        options: [
          {
            name: 'skill',
            displayName: 'Skill',
            values: [
              {
                displayName: 'Nome',
                name: 'name',
                type: 'string',
                default: '',
                description: 'Nome da skill (ex: resumir_texto)',
              },
              {
                displayName: 'Descrição',
                name: 'description',
                type: 'string',
                default: '',
              },
              {
                displayName: 'Conteúdo',
                name: 'content',
                type: 'string',
                typeOptions: { rows: 6 },
                default: '',
                description: 'Instruções da skill injetadas no system prompt.',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Guardrails',
        name: 'guardrails',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description: 'Guardrails de conteúdo avaliados antes (pré) ou depois (pós) do loop LLM.',
        options: [
          {
            name: 'guardrail',
            displayName: 'Guardrail',
            values: [
              {
                displayName: 'Nome',
                name: 'name',
                type: 'string',
                default: '',
              },
              {
                displayName: 'Fase',
                name: 'phase',
                type: 'options',
                options: [
                  { name: 'Pré (valida entrada)', value: 'pre' },
                  { name: 'Pós (valida saída)', value: 'post' },
                ],
                default: 'pre',
              },
              {
                displayName: 'Tipo de Verificação',
                name: 'type',
                type: 'options',
                options: [
                  { name: 'Palavras-chave', value: 'keywords' },
                  { name: 'Detecção de PII', value: 'pii' },
                  { name: 'Chaves Secretas', value: 'secretKeys' },
                  { name: 'Lista de URLs Permitidas', value: 'urls' },
                  { name: 'Detecção de Jailbreak', value: 'jailbreak' },
                  { name: 'Conteúdo NSFW', value: 'nsfw' },
                  { name: 'Alinhamento de Tópico', value: 'topicalAlignment' },
                  { name: 'Regex Customizado', value: 'customRegex' },
                  { name: 'Prompt de Modelo Customizado', value: 'customModel' },
                ],
                default: 'keywords',
              },
              {
                displayName: 'Resposta de Fallback',
                name: 'fallbackResponse',
                type: 'string',
                default: 'Não posso responder a isso.',
                description: 'Retornada no lugar da resposta do agente quando este guardrail é acionado.',
              },
              {
                displayName: 'Palavras-chave',
                name: 'keywords',
                type: 'string',
                default: '',
                description: 'Lista de palavras-chave separadas por vírgula para bloquear.',
                displayOptions: { show: { type: ['keywords'] } },
              },
              {
                displayName: 'Entidades PII',
                name: 'piiEntities',
                type: 'multiOptions',
                default: [],
                description: 'Tipos de entidade para detectar. Deixe vazio para detectar todos.',
                options: [
                  { name: 'Cartão de Crédito', value: 'CREDIT_CARD' },
                  { name: 'Endereço de E-mail', value: 'EMAIL_ADDRESS' },
                  { name: 'Endereço IP', value: 'IP_ADDRESS' },
                  { name: 'Número de Telefone', value: 'PHONE_NUMBER' },
                  { name: 'Código IBAN', value: 'IBAN_CODE' },
                  { name: 'US SSN', value: 'US_SSN' },
                  { name: 'US Passport', value: 'US_PASSPORT' },
                  { name: 'US Driver License', value: 'US_DRIVER_LICENSE' },
                  { name: 'UK NINO', value: 'UK_NINO' },
                  { name: 'UK NHS', value: 'UK_NHS' },
                  { name: 'IT Fiscal Code', value: 'IT_FISCAL_CODE' },
                  { name: 'IN PAN', value: 'IN_PAN' },
                  { name: 'IN Aadhaar', value: 'IN_AADHAAR' },
                ],
                displayOptions: { show: { type: ['pii'] } },
              },
              {
                displayName: 'Nível de Detecção',
                name: 'secretKeysThreshold',
                type: 'options',
                options: [
                  { name: 'Rigoroso (mais falsos positivos, detecta mais)', value: 'strict' },
                  { name: 'Equilibrado', value: 'balanced' },
                  { name: 'Permissivo (menos falsos positivos)', value: 'permissive' },
                ],
                default: 'balanced',
                displayOptions: { show: { type: ['secretKeys'] } },
              },
              {
                displayName: 'URLs Permitidas',
                name: 'allowedUrls',
                type: 'string',
                typeOptions: { rows: 4 },
                default: '',
                description: 'Uma URL ou domínio por linha. URLs fora desta lista serão bloqueadas.',
                displayOptions: { show: { type: ['urls'] } },
              },
              {
                displayName: 'Esquemas Permitidos',
                name: 'allowedSchemes',
                type: 'string',
                default: 'https,http',
                description: 'Lista de esquemas de URL permitidos, separados por vírgula.',
                displayOptions: { show: { type: ['urls'] } },
              },
              {
                displayName: 'Bloquear Credenciais na URL',
                name: 'blockUserinfo',
                type: 'boolean',
                default: true,
                description: 'Bloquear URLs que contenham credenciais usuario:senha.',
                displayOptions: { show: { type: ['urls'] } },
              },
              {
                displayName: 'Permitir Subdomínios',
                name: 'allowSubdomains',
                type: 'boolean',
                default: false,
                displayOptions: { show: { type: ['urls'] } },
              },
              {
                displayName: 'Escopo de Negócio',
                name: 'businessScope',
                type: 'string',
                typeOptions: { rows: 4 },
                default: '',
                description: 'Descreva os tópicos permitidos. Conteúdo fora deste escopo será bloqueado.',
                displayOptions: { show: { type: ['topicalAlignment'] } },
              },
              {
                displayName: 'Padrão (Regex)',
                name: 'pattern',
                type: 'string',
                default: '',
                description: 'Padrão regex. Uma correspondência aciona o guardrail.',
                displayOptions: { show: { type: ['customRegex'] } },
              },
              {
                displayName: 'Prompt de Avaliação',
                name: 'prompt',
                type: 'string',
                typeOptions: { rows: 5 },
                default: '',
                description: 'Prompt de sistema enviado ao LLM com o conteúdo. Deve retornar "yes" (acionado) ou "no".',
                displayOptions: { show: { type: ['customModel'] } },
              },
            ],
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const results: INodeExecutionData[] = [];

    // Credentials and sub-node connections are shared across all items
    const creds = await this.getCredentials('openRouterApi');
    const openai = new OpenAI({
      apiKey: creds.apiKey as string,
      baseURL: (creds.baseUrl as string) || 'https://openrouter.ai/api/v1',
      defaultHeaders: creds.httpReferer
        ? { 'X-Title': creds.httpReferer as string }
        : undefined,
    });
    // Get memory sub-node (optional)
    let memory: IAgentMemory | null = null;
    try {
      const memoryData = await this.getInputConnectionData(NodeConnectionTypes.AiMemory, 0);
      if (Array.isArray(memoryData) && memoryData.length > 0) {
        memory = (memoryData[0] as IAgentMemory) ?? null;
      }
    } catch {
      // no memory connected — ok
    }

    // Get MCP tools sub-node (optional)
    let tools: McpTool[] = [];
    try {
      const toolData = await this.getInputConnectionData(NodeConnectionTypes.AiTool, 0);
      if (Array.isArray(toolData) && toolData.length > 0) {
        tools = (toolData as McpTool[][]).flat();
      }
    } catch {
      // no tools connected — ok
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Read per-item to support expression-based property values
      const inputField = this.getNodeParameter('inputField', i) as string;
      const sessionIdField = this.getNodeParameter('sessionIdField', i) as string;
      const baseSystemPrompt = this.getNodeParameter('systemPrompt', i) as string;
      const modelOverride = this.getNodeParameter('modelOverride', i, '') as string;
      const maxIterations = this.getNodeParameter('maxIterations', i, 10) as number;
      const outputField = this.getNodeParameter('outputField', i, 'response') as string;
      const skillsField = this.getNodeParameter('skillsField', i, '__skills__') as string;
      const model = modelOverride || (creds.model as string) || 'qwen/qwen3-235b-a22b';

      const userMessage = String(resolveField(item.json, inputField) ?? '');
      const sessionId = String(resolveField(item.json, sessionIdField) ?? `session-${i}`);

      const inlineSkillsRaw = this.getNodeParameter('inlineSkills', i, { skill: [] }) as {
        skill: Array<{ name: string; description: string; content: string }>;
      };
      const inlineSkills: Skill[] = (inlineSkillsRaw.skill ?? [])
        .filter((s) => s.name)
        .map((s) => {
          const rawContent = s.content ?? '';
          const content = String(resolveField(item.json, rawContent) ?? rawContent);
          return { name: s.name, description: s.description, content, tags: [] };
        });

      const rawLoaderSkills = resolveField(item.json, skillsField);
      const loaderSkills = (Array.isArray(rawLoaderSkills) ? rawLoaderSkills : []) as Skill[];
      // Loader skills override inline skills with the same name
      const loaderNames = new Set(loaderSkills.map((s) => s.name));
      const skills: Skill[] = [
        ...inlineSkills.filter((s) => !loaderNames.has(s.name)),
        ...loaderSkills,
      ];

      const guardrailsRaw = this.getNodeParameter('guardrails', i, { guardrail: [] }) as {
        guardrail: Array<{
          name: string;
          phase: string;
          type: string;
          fallbackResponse: string;
          keywords?: string;
          piiEntities?: string[];
          secretKeysThreshold?: string;
          allowedUrls?: string;
          allowedSchemes?: string;
          blockUserinfo?: boolean;
          allowSubdomains?: boolean;
          businessScope?: string;
          pattern?: string;
          prompt?: string;
        }>;
      };
      const guardrailConfigs: GuardrailConfig[] = (guardrailsRaw.guardrail ?? []).map((g) => ({
        name: g.name,
        phase: g.phase as 'pre' | 'post',
        type: g.type as GuardrailConfig['type'],
        fallbackResponse: g.fallbackResponse,
        keywords: g.keywords,
        piiEntities: g.piiEntities,
        secretKeysThreshold: g.secretKeysThreshold as GuardrailConfig['secretKeysThreshold'],
        allowedUrls: g.allowedUrls,
        allowedSchemes: g.allowedSchemes,
        blockUserinfo: g.blockUserinfo,
        allowSubdomains: g.allowSubdomains,
        businessScope: g.businessScope,
        pattern: g.pattern,
        prompt: g.prompt,
      }));

      if (!userMessage) {
        throw new NodeOperationError(
          this.getNode(),
          `Input field "${inputField}" is empty or missing.`,
          { itemIndex: i },
        );
      }

      const preBlock = await runGuardrails(userMessage, guardrailConfigs, 'pre', openai, model);
      if (preBlock !== null) {
        const { __skills__: _s, ...cleanJsonPre } = item.json as Record<string, unknown>;
        results.push({
          json: {
            ...cleanJsonPre,
            [outputField]: preBlock,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, iterations: 0, model },
          } as INodeExecutionData['json'],
          pairedItem: { item: i },
        });
        continue;
      }

      const systemPrompt = composeSystemPrompt(baseSystemPrompt, skills);

      const history = memory ? memory.getMessages(sessionId) : [];
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user', content: userMessage },
      ];

      if (memory) memory.addMessage(sessionId, { role: 'user', content: userMessage });

      const allTools = skills.length > 0 ? [...tools, buildSkillTool(skills)] : tools;
      const loopResult = await runAgentLoop({ openai, model, messages, tools: allTools, maxIterations });
      let finalResponse = loopResult.response;
      const usage = loopResult.usage;

      if (!finalResponse) {
        throw new NodeOperationError(
          this.getNode(),
          `Agent did not produce a response after ${maxIterations} iteration(s). The model may be stuck in a tool-calling loop.`,
          { itemIndex: i },
        );
      }

      const postBlock = await runGuardrails(finalResponse, guardrailConfigs, 'post', openai, model);
      if (postBlock !== null) {
        finalResponse = postBlock;
      }

      if (memory) memory.addMessage(sessionId, { role: 'assistant', content: finalResponse });

      // Remove internal __skills__ field from output
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { __skills__: _unused, ...cleanJson } = item.json as Record<string, unknown>;

      results.push({
        json: {
          ...cleanJson,
          [outputField]: finalResponse,
          usage: { ...usage, model },
        } as INodeExecutionData['json'],
        pairedItem: { item: i },
      });
    }

    return [results];
  }
}
