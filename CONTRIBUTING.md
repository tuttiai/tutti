# Contributing to Tutti

Welcome, Composer. Every voice you add makes the orchestra richer.

## Ways to contribute

- **Build a voice** — add a new integration to the Repertoire
- **Improve core** — help build the runtime and CLI
- **Write docs** — make Tutti easier to understand
- **Report bugs** — open an issue with a clear reproduction

## Building a voice

\`\`\`bash
tutti-ai create voice my-voice
cd my-voice
# implement the voice interface
tutti-ai publish
\`\`\`

## Development setup

\`\`\`bash
git clone https://github.com/tuttiai/tutti
cd tutti
npm install
npm run dev
\`\`\`

## Pull request guidelines

- One feature or fix per PR
- Add tests for new voices
- Update docs if behaviour changes
- Be kind — we're all composers here
