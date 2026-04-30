# Contributing to n8n-nodes-agent-kit

First — thanks. Seriously. Every issue, PR, and 👍 helps.

This doc tells you how to contribute productively. Read it once; it's short.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Ways to Contribute](#ways-to-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Pull Request Process](#pull-request-process)
- [Commit Convention](#commit-convention)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Releasing](#releasing) *(maintainers)*

---

## Code of Conduct

By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Be kind. Assume good intent. Receive feedback gracefully.

---

## Ways to Contribute

You don't have to write code to help.

| Contribution | How |
|---|---|
| 🐛 **Report a bug** | Open an [issue](https://github.com/lucasbrito-wdt/n8n-nodes-agent-kit/issues/new?template=bug_report.yml) with repro steps |
| 💡 **Suggest a feature** | Open a [feature request](https://github.com/lucasbrito-wdt/n8n-nodes-agent-kit/issues/new?template=feature_request.yml) |
| 📖 **Improve docs** | PR against `README.md` or anything in `docs/` |
| 🧪 **Add tests** | Coverage in `tests/` is always welcome |
| 🔌 **Build a node** | Got an idea for a new node? Open a feature request first to align |
| ⭐ **Star the repo** | It honestly helps a lot |
| 💬 **Help others** | Answer questions in Issues / Discussions |

---

## Development Setup

**Requirements:** Node.js ≥ 18, npm ≥ 9, an n8n instance for testing.

```bash
# 1. Fork → clone your fork
git clone https://github.com/<your-username>/n8n-nodes-agent-kit.git
cd n8n-nodes-agent-kit

# 2. Install
npm install

# 3. Build (or watch)
npm run build       # one-shot
npm run dev         # watch mode

# 4. Link into your n8n install
npm link
cd /path/to/your/n8n
npm link n8n-nodes-agent-kit
n8n start
```

> **Tip:** `npm run dev` + a fresh `n8n start` after each rebuild gives you the tightest loop.

### Running tests

```bash
npm test            # full suite
npm test -- --watch # watch
```

### Linting

```bash
npm run lint
```

---

## Project Structure

```
n8n-nodes-agent-kit/
├── credentials/              # Credential definitions (OpenRouter, GitHub Skills)
├── nodes/
│   ├── AgentKit/             # Single-agent node + guardrails/
│   ├── OrchestratorKit/      # Supervisor agent
│   ├── SubAgentKit/          # Specialist agent (AiAgent output)
│   ├── AgentMemory/          # SQLite + session buffer
│   ├── McpGateway/           # MCP client + server
│   └── SkillLoader/          # SKILL.md loader (inline + GitHub)
├── utils/
│   ├── subAgentRunner.ts     # Shared agent loop (tool calling)
│   ├── skillParser.ts        # Frontmatter + system-prompt composition
│   ├── githubLoader.ts       # GitHub raw content fetcher
│   └── memoryStore.ts        # SQLite wrapper
├── tests/                    # Jest specs
├── docs/                     # Demo workflows + extra docs
└── dist/                     # Build output (gitignored)
```

**Where to put your change:**
- New node? → `nodes/<YourNode>/<YourNode>.node.ts` + register in `package.json` `n8n.nodes`.
- New credential? → `credentials/` + register in `package.json` `n8n.credentials`.
- Shared logic across nodes? → `utils/`.

---

## Pull Request Process

1. **Open an issue first** for non-trivial work. Saves everyone time.
2. **Fork** and create a branch: `feat/<short-name>` or `fix/<short-name>`.
3. **Make the change.** Keep it focused — one PR, one concern.
4. **Add or update tests.** If it's a bug fix, write the failing test first.
5. **Run the checks locally:**
   ```bash
   npm run lint
   npm test
   npm run build
   ```
6. **Update docs** if behavior changes (README, node descriptions, etc.).
7. **Bump the version** if you're a maintainer; otherwise leave it.
8. **Open the PR** using the [PR template](.github/PULL_REQUEST_TEMPLATE.md). Link the issue.
9. **Respond to review.** We aim for first review within 72 hours.

### What gets a PR merged fast

- Focused scope
- Tests included
- Clear description with before/after or screenshots
- Conventional commit messages
- No unrelated reformatting

### What gets a PR sent back

- "Refactored everything while I was at it"
- Behavior change with no test
- Breaking change without discussion
- Mixing fixes + features in one PR

---

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/). The prefix matters — it drives the changelog.

```
<type>(<scope>): <subject>

<body>            # optional, why not what

<footer>          # optional, BREAKING CHANGE / Refs #123
```

**Types:**
- `feat` — new feature
- `fix` — bug fix
- `docs` — docs only
- `refactor` — code change, no behavior change
- `test` — tests only
- `chore` — tooling, deps, build
- `perf` — perf improvement

**Examples:**
```
feat(orchestrator): add executionTrace to output
fix(memory): correct getInputConnectionData unwrapping
docs(readme): add multi-agent example
```

---

## Coding Standards

- **TypeScript strict mode.** No `any` unless truly unavoidable; comment why.
- **No magic.** A future contributor reading the file should understand it without git blame.
- **No dead code.** Delete it; we have git.
- **Comments explain *why*, not *what*.** Good names handle the *what*.
- **Match existing style.** ESLint enforces most of it; run `npm run lint`.
- **No new runtime deps without discussion.** This package stays lean on purpose.

### Node-specific

- Every node ships with a clear `description` and `displayName`.
- Properties have helpful `description` strings — they show up in the n8n UI.
- Errors thrown to the user use `NodeOperationError` with actionable messages.
- Don't break input/output connection types without a major version bump.

---

## Testing

We use **Jest**. Tests live in `tests/`, mirroring the source structure.

- **Unit tests** for `utils/` — fast, no I/O.
- **Integration-ish tests** for nodes — exercise `execute` / `supplyData` with mocked n8n contexts.

Aim for: every bug fix gets a regression test; every new feature gets at least a happy-path test.

---

## Releasing

*(maintainers only)*

1. Make sure `master` is green.
2. Bump version: `npm version <patch|minor|major> -m "chore: release v%s"`.
3. Push tags: `git push --follow-tags`.
4. Publish: `npm publish`.
5. Create a GitHub Release with the changelog.

---

## Questions?

- Open a [Discussion](https://github.com/lucasbrito-wdt/n8n-nodes-agent-kit/discussions)
- Or ping in the [n8n Discord](https://discord.gg/n8n) (#community-nodes)

**Thanks again for being here. Now go ship something.** 🚀
