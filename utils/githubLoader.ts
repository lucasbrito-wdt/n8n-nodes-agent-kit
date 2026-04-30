import { parseSkill, Skill } from './skillParser';

export interface GitHubLoaderConfig {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
  cacheTtlSeconds: number;
}

interface CacheEntry {
  skills: Skill[];
  fetchedAt: number;
}

interface GithubContentItem {
  name: string;
  type: string;
  url: string | null;
  download_url: string | null;
}

export class GitHubLoader {
  private cache: CacheEntry | null = null;
  private readonly headers: Record<string, string>;

  constructor(private config: GitHubLoaderConfig) {
    this.headers = {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
    };
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async fetchSkillFromDir(dir: GithubContentItem, branch: string): Promise<Skill | null> {
    if (!dir.url) return null;
    try {
      const dirItems = await this.fetchJson<GithubContentItem[]>(`${dir.url}?ref=${branch}`);
      const skillMd = dirItems.find((f) => f.type === 'file' && f.name === 'SKILL.md');
      if (!skillMd?.download_url) return null;

      const contentRes = await fetch(skillMd.download_url, { headers: this.headers });
      if (!contentRes.ok) return null;
      const raw = await contentRes.text();
      return parseSkill(raw);
    } catch {
      return null;
    }
  }

  async loadAll(): Promise<Skill[]> {
    if (this.cache && Date.now() - this.cache.fetchedAt < this.config.cacheTtlSeconds * 1000) {
      return this.cache.skills;
    }

    const { owner, repo, branch, path } = this.config;
    // Strip trailing slash so URL matches /contents/skills?ref=... pattern
    const normalizedPath = path.replace(/\/$/, '');
    // agentskills.io: skills are FOLDERS each containing SKILL.md
    const listUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${normalizedPath}?ref=${branch}`;
    const items = await this.fetchJson<GithubContentItem[]>(listUrl);
    const skillDirs = items.filter((i) => i.type === 'dir');

    const skills: Skill[] = [];
    for (const dir of skillDirs) {
      const skill = await this.fetchSkillFromDir(dir, branch);
      if (skill) skills.push(skill);
    }

    this.cache = { skills, fetchedAt: Date.now() };
    return skills;
  }

  async loadSelected(names: string[]): Promise<Skill[]> {
    const { owner, repo, branch, path } = this.config;
    const normalizedPath = path.replace(/\/$/, '');
    const baseUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${normalizedPath}`;

    const skills: Skill[] = [];
    for (const name of names) {
      const dir: GithubContentItem = {
        name,
        type: 'dir',
        url: `${baseUrl}/${name}`,
        download_url: null,
      };
      const skill = await this.fetchSkillFromDir(dir, branch);
      if (skill) skills.push(skill);
    }
    return skills;
  }
}
