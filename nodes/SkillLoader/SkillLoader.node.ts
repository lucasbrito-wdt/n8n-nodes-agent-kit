import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { parseSkill } from '../../utils/skillParser';
import type { Skill } from '../../utils/skillParser';
import { GitHubLoader } from '../../utils/githubLoader';
import { resolveField } from '../../utils/fieldResolver';

interface InlineSkillEntry {
  content: string;
}

export class SkillLoader implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Skill Loader',
    name: 'skillLoader',
    icon: 'fa:book',
    group: ['transform'],
    version: 1,
    description: 'Carrega skills de IA (formato agentskills.io) e as anexa aos dados do workflow para o AgentKit.',
    defaults: { name: 'Skill Loader' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'githubSkillsApi',
        required: false,
        displayOptions: { show: { enableGithub: [true] } },
      },
    ],
    properties: [
      {
        displayName: 'Skills Inline',
        name: 'inlineSkills',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description: 'Skills definidas diretamente no nó (formato SKILL.md com frontmatter YAML). Suporta expressões e caminhos de campo (ex: msg.skillContent).',
        options: [
          {
            name: 'skill',
            displayName: 'Skill',
            values: [
              {
                displayName: 'Conteúdo SKILL.md',
                name: 'content',
                type: 'string',
                typeOptions: { rows: 10 },
                default: '---\nname: minha-skill\ndescription: O que esta skill faz.\n---\n\n# Minha Skill\n\nInstruções aqui.',
                description: 'Conteúdo SKILL.md ou caminho de campo/expressão que resolve para ele (ex: {{ $json["skillContent"] }} ou skills.mySkill).',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Campo de Skills',
        name: 'skillsField',
        type: 'string',
        default: '',
        description: 'Opcional. Caminho do campo no JSON de entrada que contém um array de objetos skill (ex: __skills__, data.skills). Deixe vazio para ignorar.',
      },
      {
        displayName: 'Carregar do GitHub',
        name: 'enableGithub',
        type: 'boolean',
        default: false,
        description: 'Carrega skills de um repositório GitHub (formato de pasta agentskills.io).',
      },
      {
        displayName: 'Dono do Repositório',
        name: 'githubOwner',
        type: 'string',
        default: '',
        description: 'Usuário ou organização do GitHub. Usa o padrão da credencial se vazio.',
        displayOptions: { show: { enableGithub: [true] } },
      },
      {
        displayName: 'Nome do Repositório',
        name: 'githubRepo',
        type: 'string',
        default: 'my-skills',
        displayOptions: { show: { enableGithub: [true] } },
      },
      {
        displayName: 'Branch',
        name: 'githubBranch',
        type: 'string',
        default: 'main',
        displayOptions: { show: { enableGithub: [true] } },
      },
      {
        displayName: 'Caminho das Skills',
        name: 'githubPath',
        type: 'string',
        default: 'skills/',
        description: 'Caminho no repositório onde ficam as pastas de skills.',
        displayOptions: { show: { enableGithub: [true] } },
      },
      {
        displayName: 'Skills para Carregar',
        name: 'githubSelected',
        type: 'string',
        default: '*',
        description: 'Nomes das pastas de skills separados por vírgula, ou * para todas. Ex: laravel-ddd,code-reviewer',
        displayOptions: { show: { enableGithub: [true] } },
      },
      {
        displayName: 'TTL do Cache (segundos)',
        name: 'githubCacheTtl',
        type: 'number',
        default: 300,
        displayOptions: { show: { enableGithub: [true] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();

    // GitHub skills are loaded once and shared across all items
    let githubSkills: Skill[] = [];
    const enableGithub = this.getNodeParameter('enableGithub', 0, false) as boolean;
    if (enableGithub) {
      const credentials = await this.getCredentials('githubSkillsApi');

      if (!credentials.token) {
        throw new NodeOperationError(
          this.getNode(),
          'GitHub credential token is required when "Load from GitHub" is enabled.',
        );
      }

      const owner =
        (this.getNodeParameter('githubOwner', 0, '') as string) ||
        (credentials.owner as string);
      const repo = this.getNodeParameter('githubRepo', 0, 'my-skills') as string;
      const branch = this.getNodeParameter('githubBranch', 0, 'main') as string;
      const path = this.getNodeParameter('githubPath', 0, 'skills/') as string;
      const selected = this.getNodeParameter('githubSelected', 0, '*') as string;
      const cacheTtl = this.getNodeParameter('githubCacheTtl', 0, 300) as number;

      const loader = new GitHubLoader({
        owner,
        repo,
        branch,
        path,
        token: credentials.token as string,
        cacheTtlSeconds: cacheTtl,
      });

      try {
        githubSkills =
          selected.trim() === '*'
            ? await loader.loadAll()
            : await loader.loadSelected(selected.split(',').map((s) => s.trim()));
      } catch (err) {
        throw new NodeOperationError(
          this.getNode(),
          `GitHub skill loading failed: ${(err as Error).message}`,
        );
      }
    }

    const results: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Inline skills are resolved per-item so expressions like {{ $json.skillContent }}
      // and field paths like "msg.skillContent" work correctly for each item.
      const inlineSkillsRaw = this.getNodeParameter('inlineSkills', i, { skill: [] }) as {
        skill: InlineSkillEntry[];
      };

      const inlineSkills: Skill[] = [];
      for (const entry of inlineSkillsRaw.skill ?? []) {
        // Support field path resolution: if content looks like a path, resolve it from item.json
        const rawContent = entry.content ?? '';
        const content = String(resolveField(item.json, rawContent) ?? rawContent);
        if (!content.trim()) continue;
        try {
          inlineSkills.push(parseSkill(content));
        } catch (err) {
          throw new NodeOperationError(
            this.getNode(),
            `Invalid inline skill: ${(err as Error).message}`,
            { itemIndex: i },
          );
        }
      }

      // Optional: pull additional skills from a configurable field in item.json
      const skillsField = this.getNodeParameter('skillsField', i, '') as string;
      let fieldSkills: Skill[] = [];
      if (skillsField) {
        const raw = resolveField(item.json, skillsField);
        if (Array.isArray(raw)) {
          fieldSkills = raw as Skill[];
        }
      }

      // Merge: inline first, then field skills, then GitHub — later entries override by name
      const merged = new Map<string, Skill>();
      for (const s of [...inlineSkills, ...fieldSkills, ...githubSkills]) {
        merged.set(s.name, s);
      }

      results.push({
        ...item,
        json: { ...item.json, __skills__: Array.from(merged.values()) },
      });
    }

    return [results];
  }
}
