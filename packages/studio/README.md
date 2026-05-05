# @tuttiai/studio

Web-based visual IDE for Tutti agents.

The studio is a static React SPA built with Vite. It is served by the
[`@tuttiai/server`](../server) Fastify app at `/studio/*` when started via
`tutti-ai serve --studio` or, more commonly, via the `tutti-ai studio`
shorthand.

## Scripts

```bash
npm run dev     # Vite dev server on http://localhost:5173
npm run build   # Production build to ./dist
```

## Layout

The shell is a three-panel layout:

- **Left** — agent / graph list sidebar (240 px).
- **Centre** — graph canvas (placeholder; populated in step 2).
- **Right** — run details / inspector (320 px).

## Mount path

The Vite `base` is `/studio/` so generated asset URLs in `dist/index.html`
resolve correctly behind the Tutti server's `/studio/*` route.
