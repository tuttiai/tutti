# @tuttiai/filesystem

Filesystem voice for [Tutti](https://tutti-ai.com) — gives agents the ability to read, write, and search files on the local filesystem.

## Install

```bash
npm install @tuttiai/filesystem
```

## Usage

```ts
import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";
import { FilesystemVoice } from "@tuttiai/filesystem";

const score = defineScore({
  provider: new AnthropicProvider(),
  agents: {
    assistant: {
      name: "assistant",
      model: "claude-sonnet-4-20250514",
      system_prompt: "You are a helpful assistant with filesystem access.",
      voices: [new FilesystemVoice()],
      permissions: ["filesystem"],
    },
  },
});

const tutti = new TuttiRuntime(score);
const result = await tutti.run("assistant", "List all .ts files in ./src");
console.log(result.output);
```

## Tools

| Tool | Description |
|---|---|
| `read_file` | Read file contents (utf-8 or base64) |
| `write_file` | Write or append to files |
| `list_directory` | List files with optional glob filtering |
| `create_directory` | Create directories recursively |
| `delete_file` | Delete files with safety confirmation |
| `move_file` | Move or rename files and directories |
| `search_files` | Search file contents by text pattern |

All tool inputs are validated with Zod. Errors are returned as structured results — never thrown.

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/voices/filesystem)
- [Voice Registry](https://tutti-ai.com/voices)

## License

Apache 2.0
