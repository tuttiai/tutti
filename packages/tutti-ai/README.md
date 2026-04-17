# tutti-ai

**All agents. All together.**

Open-source multi-agent orchestration framework for TypeScript.

This is the unscoped wrapper for [`@tuttiai/cli`](https://www.npmjs.com/package/@tuttiai/cli). Both packages provide the same `tutti-ai` binary.

## Install

```bash
npm install -g tutti-ai
```

## Usage

```bash
tutti-ai init my-project     # scaffold a new project
cd my-project
cp .env.example .env         # add your ANTHROPIC_API_KEY
npm install
tutti-ai run                 # interactive REPL
```

Or skip the REPL for a one-shot prompt:

```bash
tutti-ai run -p "What is 2 + 2?"
```

See the [CLI reference](https://tutti-ai.com/cli/reference) for the
full command list — `run`, `serve`, `studio`, `info`, `check`,
`schedule`, `eval`, and more.

## Links

- [Website](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti)
- [Docs](https://tutti-ai.com/docs)

## License

Apache 2.0
