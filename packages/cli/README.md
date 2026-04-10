# @tuttiai/cli

CLI for [Tutti](https://tutti-ai.com) — scaffold and run multi-agent projects from the command line.

## Install

```bash
npm install -g @tuttiai/cli
```

## Commands

### `tutti-ai init [project-name]`

Scaffold a new Tutti project with a ready-to-run `tutti.score.ts`:

```bash
tutti-ai init my-project
cd my-project
cp .env.example .env    # add your ANTHROPIC_API_KEY
npm install
npm run dev
```

### `tutti-ai run [score]`

Load a score file and open an interactive REPL:

```bash
tutti-ai run                     # defaults to ./tutti.score.ts
tutti-ai run ./custom-score.ts   # specify a score file
```

Features:
- Spinner on LLM calls
- Colored tool execution trace
- Session continuity across messages
- Graceful Ctrl+C handling

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/packages/cli)
- [Docs](https://tutti-ai.com/docs)

## License

MIT
