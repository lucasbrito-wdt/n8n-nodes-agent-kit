import { GitHubLoader, GitHubLoaderConfig } from '../utils/githubLoader';

const CONFIG: GitHubLoaderConfig = {
  owner: 'lucasbrito-wdt',
  repo: 'my-skills',
  branch: 'main',
  path: 'skills/',
  token: 'ghp_test',
  cacheTtlSeconds: 5,
};

// agentskills.io format: skills are FOLDERS containing SKILL.md
const MOCK_ROOT_LISTING = [
  { name: 'laravel-ddd', type: 'dir', url: 'https://api.github.com/repos/owner/repo/contents/skills/laravel-ddd' },
  { name: 'code-reviewer', type: 'dir', url: 'https://api.github.com/repos/owner/repo/contents/skills/code-reviewer' },
  { name: 'readme.md', type: 'file', url: null },
];

const MOCK_SKILL_DIR = [
  { name: 'SKILL.md', type: 'file', download_url: 'https://raw.example.com/SKILL.md' },
  { name: 'references', type: 'dir', download_url: null },
];

const MOCK_SKILL_CONTENT = `---
name: laravel-ddd
description: Expert in Laravel DDD.
---

You are a DDD expert.
`;

describe('GitHubLoader', () => {
  let loader: GitHubLoader;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    loader = new GitHubLoader(CONFIG);
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((url: any) => {
      const urlStr = String(url);
      // Skill folder contents listing
      if (urlStr.includes('/contents/skills/laravel-ddd') || urlStr.includes('/contents/skills/code-reviewer')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SKILL_DIR) } as Response);
      }
      // Root path listing
      if (urlStr.includes('/contents/skills')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_ROOT_LISTING) } as Response);
      }
      // Raw SKILL.md content
      return Promise.resolve({ ok: true, text: () => Promise.resolve(MOCK_SKILL_CONTENT) } as Response);
    });
  });

  afterEach(() => fetchMock.mockRestore());

  it('loads only skill folders (dirs), ignores files at root', async () => {
    const skills = await loader.loadAll();
    expect(skills).toHaveLength(2);
  });

  it('fetches SKILL.md from inside each skill folder', async () => {
    await loader.loadAll();
    const skillMdCalls = fetchMock.mock.calls.filter(([url]: [string]) =>
      String(url).includes('SKILL.md'),
    );
    expect(skillMdCalls.length).toBeGreaterThan(0);
  });

  it('parses skill content correctly', async () => {
    const skills = await loader.loadAll();
    expect(skills[0].name).toBe('laravel-ddd');
    expect(skills[0].description).toBe('Expert in Laravel DDD.');
  });

  it('sends Authorization header on all requests', async () => {
    await loader.loadAll();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('api.github.com'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer ghp_test' }),
      }),
    );
  });

  it('returns cached result within TTL', async () => {
    await loader.loadAll();
    await loader.loadAll();
    const rootCalls = fetchMock.mock.calls.filter(([url]: [string]) =>
      String(url).includes('/contents/skills?') || String(url).endsWith('/contents/skills/'),
    );
    expect(rootCalls).toHaveLength(1);
  });

  it('re-fetches after TTL expires', async () => {
    jest.useFakeTimers();
    await loader.loadAll();
    jest.advanceTimersByTime(6000);
    await loader.loadAll();
    const rootCalls = fetchMock.mock.calls.filter(([url]: [string]) =>
      String(url).includes('/contents/skills'),
    );
    // Should have called at least the root listing twice
    expect(rootCalls.length).toBeGreaterThanOrEqual(2);
    jest.useRealTimers();
  });

  it('loads only selected skill names', async () => {
    const skills = await loader.loadSelected(['laravel-ddd']);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('laravel-ddd');
  });

  it('throws on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    await expect(loader.loadAll()).rejects.toThrow('GitHub API error: 404');
  });
});
