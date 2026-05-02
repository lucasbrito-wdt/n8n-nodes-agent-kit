import { parseSkill, composeSystemPrompt, buildSkillTool, Skill } from '../utils/skillParser';

const VALID_SKILL = `---
name: laravel-ddd
description: Expert in Laravel DDD. Use when building domain models.
license: MIT
metadata:
  author: lucasbrito
  version: "1.0"
  tags:
    - backend
    - laravel
---

# Laravel DDD Expert

You are an expert in Domain-Driven Design with Laravel.
Always use repositories and value objects.
`;

const MINIMAL_SKILL = `---
name: code-reviewer
description: Reviews code for quality.
---

Review the provided code carefully.
`;

const NO_FRONTMATTER = `# Just content

No frontmatter here.
`;

describe('parseSkill', () => {
  it('parses name and description from frontmatter', () => {
    const skill = parseSkill(VALID_SKILL);
    expect(skill.name).toBe('laravel-ddd');
    expect(skill.description).toBe('Expert in Laravel DDD. Use when building domain models.');
  });

  it('parses metadata tags', () => {
    const skill = parseSkill(VALID_SKILL);
    expect(skill.tags).toEqual(['backend', 'laravel']);
  });

  it('parses version from metadata', () => {
    const skill = parseSkill(VALID_SKILL);
    expect(skill.version).toBe('1.0');
  });

  it('extracts content without frontmatter', () => {
    const skill = parseSkill(VALID_SKILL);
    expect(skill.content).toContain('# Laravel DDD Expert');
    expect(skill.content).not.toContain('name: laravel-ddd');
  });

  it('handles minimal frontmatter (no metadata)', () => {
    const skill = parseSkill(MINIMAL_SKILL);
    expect(skill.name).toBe('code-reviewer');
    expect(skill.tags).toEqual([]);
    expect(skill.version).toBeUndefined();
    expect(skill.content).toBe('Review the provided code carefully.');
  });

  it('throws if name is missing', () => {
    const noName = `---\ndescription: test\n---\ncontent`;
    expect(() => parseSkill(noName)).toThrow('Skill missing required field: name');
  });

  it('throws if description is missing', () => {
    const noDesc = `---\nname: test\n---\ncontent`;
    expect(() => parseSkill(noDesc)).toThrow('Skill missing required field: description');
  });

  it('throws on no frontmatter', () => {
    expect(() => parseSkill(NO_FRONTMATTER)).toThrow('Skill missing required field: name');
  });
});

const skill1: Skill = { name: 'laravel-ddd', description: 'Laravel DDD expert.', tags: [], content: '# Laravel DDD\nInstructions here.' };
const skill2: Skill = { name: 'code-reviewer', description: 'Reviews code quality.', tags: [], content: '# Code Review\nReview carefully.' };
const skillWithSummary: Skill = {
  name: 'sql-writer',
  description: 'SQL query expert.',
  summary: 'Always use parameterized queries.\nNever use SELECT *.',
  tags: [],
  content: '# SQL Writer\nFull detailed instructions here.',
};

describe('composeSystemPrompt', () => {
  it('returns base prompt unchanged when no skills', () => {
    expect(composeSystemPrompt('You are an assistant.', [])).toBe('You are an assistant.');
  });

  it('lists skill names and descriptions — full content NOT inlined', () => {
    const result = composeSystemPrompt('Base.', [skill1, skill2]);
    expect(result).toContain('laravel-ddd');
    expect(result).toContain('Laravel DDD expert.');
    expect(result).toContain('code-reviewer');
    expect(result).toContain('load_skill');
    expect(result).not.toContain('# Laravel DDD\nInstructions here.');
    expect(result).not.toContain('# Code Review\nReview carefully.');
  });

  it('inlines summary for skills that have one', () => {
    const result = composeSystemPrompt('Base.', [skillWithSummary]);
    expect(result).toContain('Always use parameterized queries.');
    expect(result).toContain('Never use SELECT *.');
    // Full content still NOT inlined
    expect(result).not.toContain('Full detailed instructions here.');
  });

  it('skills without summary show only name + description', () => {
    const result = composeSystemPrompt('Base.', [skill1]);
    expect(result).toContain('laravel-ddd');
    expect(result).toContain('Laravel DDD expert.');
    expect(result).not.toContain('>'); // no summary block
  });
});

describe('parseSkill — summary field', () => {
  it('parses summary from frontmatter when present', () => {
    const raw = `---
name: sql-writer
description: SQL expert.
summary: Always use parameterized queries.
---
Full instructions here.`;
    const skill = parseSkill(raw);
    expect(skill.summary).toBe('Always use parameterized queries.');
    expect(skill.content).toBe('Full instructions here.');
  });

  it('summary is undefined when not present', () => {
    const raw = `---\nname: test\ndescription: test desc\n---\nContent.`;
    expect(parseSkill(raw).summary).toBeUndefined();
  });
});

describe('buildSkillTool', () => {
  it('returns a tool named load_skill', () => {
    const tool = buildSkillTool([skill1, skill2]);
    expect(tool.name).toBe('load_skill');
  });

  it('returns full skill content when called with valid name', async () => {
    const tool = buildSkillTool([skill1]);
    const result = await tool.call({ skillName: 'laravel-ddd' });
    expect(result).toContain('# Laravel DDD');
    expect(result).toContain('Instructions here.');
  });

  it('returns error message for unknown skill name', async () => {
    const tool = buildSkillTool([skill1]);
    const result = await tool.call({ skillName: 'nonexistent' });
    expect(result).toContain('not found');
    expect(result).toContain('laravel-ddd');
  });

  it('lists available skills in description', () => {
    const tool = buildSkillTool([skill1, skill2]);
    expect(tool.description).toContain('laravel-ddd');
    expect(tool.description).toContain('code-reviewer');
  });
});
