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
    description: 'Loads AI skills (agentskills.io format) and attaches them to workflow data for AgentKit.',
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
        displayName: 'Inline Skills',
        name: 'inlineSkills',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description: 'Skills defined directly in the node (SKILL.md format with YAML frontmatter).',
        options: [
          {
            name: 'skill',
            displayName: 'Skill',
            values: [
              {
                displayName: 'SKILL.md Content',
                name: 'content',
                type: 'string',
                typeOptions: { rows: 10 },
                default: '---\nname: my-skill\ndescription: What this skill does.\n---\n\n# My Skill\n\nInstructions here.',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Load from GitHub',
        name: 'enableGithub',
        type: 'boolean',
        default: false,
        description: 'Load skills from a GitHub repository (agentskills.io folder format).',
      },
      {
        displayName: 'Repository Owner',
        name: 'githubOwner',
        type: 'string',
        default: '',
        description: 'GitHub user or org. Falls back to credential default if empty.',
        displayOptions: { show: { enableGithub: [true] } },
      },
      {
        displayName: 'Repository Name',
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
        displayName: 'Skills Path',
        name: 'githubPath',
        type: 'string',
        default: 'skills/',
        description: 'Path in the repo where skill folders live.',
        displayOptions: { show: { enableGithub: [true] } },
      },
      {
        displayName: 'Skills to Load',
        name: 'githubSelected',
        type: 'string',
        default: '*',
        description: 'Comma-separated skill folder names, or * for all. E.g.: laravel-ddd,code-reviewer',
        displayOptions: { show: { enableGithub: [true] } },
      },
      {
        displayName: 'Cache TTL (seconds)',
        name: 'githubCacheTtl',
        type: 'number',
        default: 300,
        displayOptions: { show: { enableGithub: [true] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const skills: Skill[] = [];

    // Load inline skills
    const inlineSkills = this.getNodeParameter('inlineSkills', 0, { skill: [] }) as {
      skill: InlineSkillEntry[];
    };
    for (const entry of inlineSkills.skill ?? []) {
      try {
        skills.push(parseSkill(entry.content));
      } catch (err) {
        throw new NodeOperationError(
          this.getNode(),
          `Invalid inline skill: ${(err as Error).message}`,
        );
      }
    }

    // Load GitHub skills
    const enableGithub = this.getNodeParameter('enableGithub', 0, false) as boolean;
    if (enableGithub) {
      const credentials = await this.getCredentials('githubSkillsApi');
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

      const githubSkills =
        selected.trim() === '*'
          ? await loader.loadAll()
          : await loader.loadSelected(selected.split(',').map((s) => s.trim()));

      skills.push(...githubSkills);
    }

    // Attach skills to every item
    return [
      items.map((item) => ({
        ...item,
        json: { ...item.json, __skills__: skills },
      })),
    ];
  }
}
