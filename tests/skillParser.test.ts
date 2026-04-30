import { parseSkill, Skill } from '../utils/skillParser';

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
