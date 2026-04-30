# Security Policy

## Supported Versions

Only the latest minor version receives security fixes. Pin and update.

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a Vulnerability

**Please do not open a public issue for security problems.**

Instead:

1. Open a [private security advisory](https://github.com/lucasbrito-wdt/n8n-nodes-agent-kit/security/advisories/new), **or**
2. Email the maintainer directly via the address on the GitHub profile.

Include:

- A description of the issue and impact
- Steps to reproduce (a minimal workflow JSON helps a lot)
- Affected version(s)
- Any suggested mitigations

You'll get an acknowledgment within **72 hours** and a status update within **7 days**. We'll coordinate a fix and disclosure timeline with you. Credit is given to reporters in the release notes unless you prefer to stay anonymous.

## Scope

In scope:

- Code execution, prompt injection, or credential leakage paths in any of the nodes
- Memory store (SQLite) data integrity issues
- MCP Gateway client/server vulnerabilities
- Supply-chain concerns in shipped dependencies

Out of scope:

- Issues in upstream `n8n` itself — please report those to the n8n team
- Issues in third-party MCP servers you connect to
- LLM provider issues (report to OpenRouter / Anthropic / OpenAI / etc.)

Thanks for helping keep the community safe.
