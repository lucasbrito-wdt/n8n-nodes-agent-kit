import matter from 'gray-matter';

export interface Skill {
  name: string;
  description: string;
  summary?: string;
  version?: string;
  tags: string[];
  content: string;
}

export function parseSkill(raw: string): Skill {
  const { data, content } = matter(raw);

  if (data.name == null) throw new Error('Skill missing required field: name');
  if (data.description == null) throw new Error('Skill missing required field: description');

  return {
    name: String(data.name),
    description: String(data.description),
    summary: data.summary ? String(data.summary).trim() : undefined,
    version: data.metadata?.version ? String(data.metadata.version) : undefined,
    tags: Array.isArray(data.metadata?.tags) ? data.metadata.tags.map(String) : [],
    content: content.trim(),
  };
}

/**
 * Hybrid system prompt composition:
 * - Skills with `summary` get their core rules inlined (model always follows them)
 * - All skills are listed with name + description
 * - Full content is deferred to the load_skill tool (saves tokens on every loop iteration)
 */
export function composeSystemPrompt(base: string, skills: Skill[]): string {
  if (skills.length === 0) return base;

  const skillList = skills
    .map((s) => {
      const line = `- **${s.name}**: ${s.description}`;
      return s.summary ? `${line}\n  > ${s.summary.replace(/\n/g, '\n  > ')}` : line;
    })
    .join('\n');

  return (
    `${base}\n\n` +
    `You have access to the following skills.\n` +
    `The rules under each skill (if any) are mandatory and always apply.\n` +
    `Call \`load_skill\` for the full instructions and examples when you need them:\n` +
    skillList
  );
}

export function buildSkillTool(skills: Skill[]): import('../nodes/McpGateway/McpGateway.node').McpTool {
  const index = new Map(skills.map((s) => [s.name, s]));
  return {
    name: 'load_skill',
    description: `Load a skill's full instructions and examples on demand. Available: ${skills.map((s) => s.name).join(', ')}`,
    inputSchema: {
      type: 'object',
      properties: {
        skillName: { type: 'string', description: 'Exact name of the skill to load.' },
      },
      required: ['skillName'],
    },
    call: async (args: Record<string, unknown>) => {
      const name = String(args.skillName ?? '').trim();
      const skill = index.get(name);
      if (!skill) {
        return `Skill "${name}" not found. Available: ${skills.map((s) => s.name).join(', ')}`;
      }
      return `# Skill: ${skill.name}\n\n${skill.content}`;
    },
  };
}
