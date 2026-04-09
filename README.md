<div align="center">
  <h1>🎼 Tutti</h1>
  <p><strong>All agents. All together.</strong></p>
  <p>The open-source multi-agent orchestration framework built for TypeScript.</p>

  <p>
    <a href="https://tutti-ai.com">Website</a> ·
    <a href="https://tutti-ai.com/docs">Docs</a> ·
    <a href="https://tutti-ai.com/voices">Voice Registry</a> ·
    <a href="https://discord.gg/tuttiai">Discord</a>
  </p>

  <img src="https://img.shields.io/npm/v/tutti-ai?color=0F6E56&label=tutti-ai" alt="npm" />
  <img src="https://img.shields.io/github/license/tuttiai/tutti?color=0F6E56" alt="license" />
  <img src="https://img.shields.io/github/stars/tuttiai/tutti?color=0F6E56" alt="stars" />
</div>

---

> **Tutti is under active development.** Star the repo to follow along.

## What is Tutti?

Tutti is a modular, open-source agent orchestration runtime for TypeScript.
Compose AI agents from reusable **voices** — pluggable modules that give
your agents new skills and connections.

\`\`\`bash
npx tutti-ai init my-project
cd my-project
tutti-ai add voice-notion
tutti-ai add voice-github
tutti-ai run score.ts
\`\`\`

## Core concepts

| Concept | Tutti term | Example |
|---|---|---|
| Plugin / module | **Voice** | \`@tuttiai/voice-notion\` |
| Configuration | **Score** | \`tutti.score.ts\` |
| Plugin registry | **Repertoire** | tutti-ai.com/voices |
| Agent team | **Section** | \`qa-section\` |
| Contributor | **Composer** | you |

## Roadmap

- [ ] Core runtime
- [ ] CLI (\`tutti-ai\`)
- [ ] Voice interface spec
- [ ] First-party voices (Notion, GitHub, Playwright, Slack)
- [ ] Visual Studio UI
- [ ] Voice registry (the Repertoire)
- [ ] Docs site

## Contributing

Tutti is built for contributors. Every voice you add
makes the whole orchestra richer.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

MIT © [Tutti AI](https://tutti-ai.com)
