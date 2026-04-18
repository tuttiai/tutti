# Marketing Agent Example

An illustration of what you can build with Tutti. One orchestrator
delegates to three specialists:

- **twitter** — manages your X/Twitter account.
- **discord** — manages your community Discord.
- **content** — researches the web and drafts copy grounded in the
  markdown files under [brand/](./brand/).

Every destructive tool (post, delete, DM, edit, react) is marked
`destructive: true` by the upstream voice, so Tutti pauses for
operator approval before anything goes live.

Fork this directory, fill in `brand/*.md` with your own content, set
the env vars, and run.

## Setup

```bash
# From the repo root
npm install
npm run build

# Copy the env template and fill it in
cp examples/marketing-agent/.env.example examples/marketing-agent/.env
$EDITOR examples/marketing-agent/.env

# Fill in your brand docs
$EDITOR examples/marketing-agent/brand/*.md

# Sanity-check the score file
npx tsx examples/marketing-agent/tutti.score.ts --check
```

The `--check` output lists every agent, its role, model, delegates,
voices, destructive tool list, and `requireApproval` config.

## Run

```bash
tutti-ai run --score examples/marketing-agent/tutti.score.ts
```

That drops you into a REPL with the orchestrator as the active
agent.

### Example prompts

```
> Draft an announcement thread and post it
```

The orchestrator delegates to **content** → drafts grounded in
`talking-points.md` → hands to **twitter** → `post_thread` triggers
an HITL prompt in the CLI. Approve and it goes live.

```
> Welcome new members in Discord this week
```

Delegates to **discord** → `list_members` filtered by recent joins →
**content** drafts a welcome using `brand-voice.md` → `post_message`
is approval-gated for each.

```
> Turn this blog post into a thread: <url>
```

**content** → `web_fetch` the URL → summarise under the tone rules
in `brand-voice.md` → **twitter** → `post_thread` asks for approval.

## How HITL approval works

When any destructive tool fires:

1. Tutti persists an `InterruptRequest` in the configured
   `InterruptStore` and emits `interrupt:requested`.
2. The agent pauses mid-run.
3. In the CLI, the prompt switches to an approve / deny / view-args
   dialog showing the exact tool arguments.
4. Approve and execution resumes; deny and the run aborts.

To scale review beyond the CLI, point Tutti at a Postgres
`InterruptStore` and use a dashboard against the `/interrupts/*`
endpoints on `@tuttiai/server`.

## Scheduling

Run the agent every weekday at 9am:

```ts
// in tutti.score.ts, on the marketing agent:
schedule: {
  cron: "0 9 * * 1-5",
  input: "Post today's update",
},
```

HITL gating still fires on scheduled runs.

## Files

- [tutti.score.ts](./tutti.score.ts) — the four-agent score
  definition plus a `--check` CLI block.
- [brand/](./brand/) — markdown ingested by the content agent's RAG
  voice on first use. **Replace the placeholder content with your
  own.**
- [.env.example](./.env.example) — required env vars, grouped by
  agent.

## Defaults you may want to change

- **RAG storage** is in-memory, so re-ingestion happens on every
  fresh process. Swap the `storage` block in
  [tutti.score.ts](./tutti.score.ts) to `{ provider: "pgvector" }`
  with a `connection_string` to persist.
- **Embeddings** default to OpenAI. Swap to Voyage AI
  (`provider: "anthropic"`, requires `VOYAGE_API_KEY`) or a local
  Ollama instance if that's not a fit.
- **Models** are set to `claude-sonnet-4-6`. Switch to a cheaper
  model on the content agent if you're cost-sensitive — it does the
  bulk of the token work.

## License

Apache 2.0 (part of the Tutti monorepo).
