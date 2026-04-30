import matter from 'gray-matter';

export interface Skill {
  name: string;
  description: string;
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
    version: data.metadata?.version ? String(data.metadata.version) : undefined,
    tags: Array.isArray(data.metadata?.tags) ? data.metadata.tags.map(String) : [],
    content: content.trim(),
  };
}
