# @tuttiai/deploy

Deploy a [Tutti](https://tutti-ai.com) score as a runnable container, Cloudflare Worker, Railway service, or Fly Machine. Bundles the `@tuttiai/server` runtime so the resulting artefact serves your agent over HTTP out of the box.

```bash
npm install @tuttiai/deploy
```

Peer dependencies: `@tuttiai/core`, `@tuttiai/types`.

## Quick start

Declare a `deploy` block on the agent you want to ship:

```typescript
import { defineScore, AnthropicProvider } from "@tuttiai/core";

export default defineScore({
  provider: new AnthropicProvider(),
  agents: {
    api: {
      name: "api",
      system_prompt: "You are helpful.",
      voices: [],
      deploy: {
        target: "fly",
        region: "ams",
        secrets: ["ANTHROPIC_API_KEY"],
        scale: { minInstances: 1, maxInstances: 5, memory: "512mb" },
      },
    },
  },
});
```

Then resolve it into a manifest:

```typescript
import { buildDeployManifest } from "@tuttiai/deploy";

const manifest = await buildDeployManifest("./tutti.score.ts");
// manifest.target          === "fly"
// manifest.name             === "api"           // inferred from agent name
// manifest.region           === "ams"
// manifest.scale.minInstances === 1
// manifest.healthCheck.path === "/health"       // default applied
```

## Validation

`buildDeployManifest` runs the standard score validator first, then layers on:

- The `deploy` block must match `DeployConfigSchema` — known `target`, kebab-case `name`, POSIX-shaped env / secret names, sane `scale` bounds, well-formed `memory` (e.g. `512mb`, `1gb`).
- Exactly one agent in the score may declare `deploy`.
- `env` keys and `secrets` entries must be disjoint.
- `env` values must not look like API keys — those go in `secrets`.

## Targets

| target | artefact |
|---|---|
| `docker` | `Dockerfile` + image build context |
| `cloudflare` | Cloudflare Worker bundle (wrangler-compatible) |
| `railway` | Railway service config (`railway.json`) |
| `fly` | Fly Machine config (`fly.toml`) |

The bundlers themselves are not yet implemented — this package currently provides the manifest contract that bundlers will consume.

## License

Apache-2.0
