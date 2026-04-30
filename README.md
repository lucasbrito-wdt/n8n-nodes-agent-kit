<div align="center">

# 🤖 n8n-nodes-agent-kit

### **Build production-grade AI agents inside n8n. No glue code. No black boxes.**

**Multi-agent orchestration · Persistent memory · MCP tools · Skills as Code · Guardrails — all native n8n nodes.**

[![npm version](https://img.shields.io/npm/v/n8n-nodes-agent-kit.svg?style=for-the-badge&color=ff6d5a)](https://www.npmjs.com/package/n8n-nodes-agent-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![n8n community node](https://img.shields.io/badge/n8n-community%20node-EA4B71?style=for-the-badge&logo=n8n)](https://www.npmjs.com/package/n8n-nodes-agent-kit)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](CONTRIBUTING.md)

[**Quick Start**](#-quick-start) · [**Nodes**](#-the-nodes) · [**Examples**](#-examples) · [**Contributing**](#-contributing) · [**Discord**](https://discord.gg/n8n)

</div>

---

## ⚡ Why Agent Kit?

n8n's built-in AI Agent is great for prototypes. **Agent Kit is what you reach for when you ship to production.**

| | Vanilla n8n AI Agent | **Agent Kit** |
|---|:---:|:---:|
| Multi-agent orchestration (supervisor → subagents) | ❌ | ✅ |
| Persistent SQLite long-term memory | ❌ | ✅ |
| Skills loaded from GitHub (agentskills.io) | ❌ | ✅ |
| MCP client + server gateway in one node | ❌ | ✅ |
| Per-agent token usage trace | ❌ | ✅ |
| Built-in guardrails (PII / regex / length) | ❌ | ✅ |
| Drop-in OpenRouter (400+ models) | ⚠️ | ✅ |

> **One package. Six nodes. Zero magic.** Plug, wire, ship.

---

## 🚀 Quick Start

### 1. Install

In your n8n instance: **Settings → Community Nodes → Install** → paste:

```
n8n-nodes-agent-kit
```

Or via npm in self-hosted:

```bash
npm install n8n-nodes-agent-kit
```

### 2. Add credentials

- **OpenRouter API** — grab one at [openrouter.ai](https://openrouter.ai) (gives you Claude, GPT-4o, Gemini, Llama, Qwen, etc. — one key)
- **GitHub Skills API** *(optional)* — only if you want to load skills from a repo

### 3. Build your first agent (60 seconds)

```
[Webhook] → [Agent Memory] ─┐
                            ├→ [Agent Kit] → [Respond]
            [MCP Gateway] ──┘
```

Done. You have a stateful AI agent with tools.

---

## 🧩 The Nodes

<table>
<tr>
<td width="50%" valign="top">

### 🤖 **Agent Kit**
The workhorse. A single AI agent with tool calling, memory, skills, and guardrails. Use this when one agent is enough.

**Inputs:** Main · AiMemory · AiTool
**Powered by:** any OpenRouter model

</td>
<td width="50%" valign="top">

### 🧠 **Orchestrator Kit**
Supervisor agent that routes tasks to specialist subagents. Returns a full `executionTrace` showing who did what, when, and how many tokens.

**Inputs:** Main · AiMemory · AiTool · **AiAgent**

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎯 **Sub Agent Kit**
A specialized agent that plugs into an Orchestrator as a callable tool. Give it a name, a description, a prompt — done. The orchestrator decides when to call it.

**Output:** AiAgent

</td>
<td width="50%" valign="top">

### 💾 **Agent Memory**
SQLite-backed long-term memory + in-process short-term session buffer. Survives restarts. No external DB required.

**Output:** AiMemory

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🔌 **MCP Gateway**
Speaks Model Context Protocol both ways: **client** (consume external MCP servers as tools) and **server** (expose n8n webhooks as MCP tools).

**Output:** AiTool

</td>
<td width="50%" valign="top">

### 📚 **Skill Loader**
Loads `SKILL.md` files (the [agentskills.io](https://agentskills.io) format) inline or straight from a GitHub repo. Skills compose into the system prompt at runtime.

**Output:** Main (carries skills payload)

</td>
</tr>
</table>

---

## 🎬 Examples

### 🟢 Single agent with memory + tools

```
[Trigger] → [Agent Memory] ─┐
                            ├→ [Agent Kit] → [Output]
            [MCP Gateway] ──┘
```

### 🔵 Multi-agent orchestration

```
                  ┌→ [SubAgent: researcher] ──┐
[Trigger] → [Orchestrator Kit] ←──────────────┤
                  └→ [SubAgent: writer]    ───┘
```

The orchestrator picks which subagent to call. Each subagent has its own prompt, tools, and (optionally) memory. The output includes `executionTrace` with per-agent token usage.

### 🟣 Skills from GitHub (agentskills.io style)

```
[Trigger] → [Skill Loader (GitHub)] → [Agent Kit]
```

Skill Loader fetches `SKILL.md` files from your repo, parses YAML frontmatter, and injects them into the agent's system prompt. **Update your skills repo, no n8n redeploy.**

> A complete demo workflow lives in [`docs/`](docs/) — import it and you're running in 30 seconds.

---

## 🛡️ Guardrails

Agent Kit and Orchestrator Kit ship with built-in input/output guardrails:

- **PII detection** (email, phone, CPF, etc.)
- **Regex blocklists**
- **Length caps**
- **Custom blockers**

Configure them per-node. No middleware. No proxy. Just toggle.

---

## 📊 Observability

Every Orchestrator run returns:

```json
{
  "response": "...",
  "executionTrace": [
    { "step": 1, "agent": "researcher", "task": "...", "durationMs": 1840,
      "usage": { "prompt_tokens": 1230, "completion_tokens": 240, "iterations": 2 } },
    { "step": 2, "agent": "writer", "task": "...", "durationMs": 920,
      "usage": { "prompt_tokens": 800, "completion_tokens": 410, "iterations": 1 } }
  ]
}
```

Wire this straight into your dashboards. No extra instrumentation.

---

## 🛠️ Local Development

```bash
git clone https://github.com/lucasbrito-wdt/n8n-nodes-agent-kit.git
cd n8n-nodes-agent-kit
npm install
npm run build
npm link

# In your n8n install dir:
npm link n8n-nodes-agent-kit
n8n start
```

Run the test suite:

```bash
npm test
```

---

## 🤝 Contributing

**This is the part where you come in.**

Agent Kit is built in the open. PRs, issues, ideas, memes — all welcome.

- 🐛 [Report a bug](https://github.com/lucasbrito-wdt/n8n-nodes-agent-kit/issues/new?template=bug_report.yml)
- 💡 [Request a feature](https://github.com/lucasbrito-wdt/n8n-nodes-agent-kit/issues/new?template=feature_request.yml)
- 📖 Read the [Contributing Guide](CONTRIBUTING.md)
- 🧭 Follow the [Code of Conduct](CODE_OF_CONDUCT.md)

**First-time contributors welcome.** Look for issues tagged `good first issue`.

---

## 🗺️ Roadmap

- [x] Multi-agent orchestration (Orchestrator + SubAgent)
- [x] Per-agent token usage in executionTrace
- [x] MCP client + server in one node
- [x] Skills from GitHub
- [ ] Streaming responses
- [ ] Agent eval harness (golden datasets + regression gates)
- [ ] Built-in vector memory
- [ ] Cost budgets & per-session caps
- [ ] Web UI for inspecting executionTrace

Vote with 👍 reactions on the [roadmap discussion](https://github.com/lucasbrito-wdt/n8n-nodes-agent-kit/discussions).

---

## 📜 License

MIT © [Lucas Brito](https://github.com/lucasbrito-wdt)

---

<div align="center">

### If Agent Kit saved you a week of glue code, **drop a ⭐ — it's the cheapest thank-you in OSS.**

**[⭐ Star on GitHub](https://github.com/lucasbrito-wdt/n8n-nodes-agent-kit)** · **[📦 npm](https://www.npmjs.com/package/n8n-nodes-agent-kit)** · **[🐛 Issues](https://github.com/lucasbrito-wdt/n8n-nodes-agent-kit/issues)**

*Built with ❤️ for the n8n community.*

</div>
