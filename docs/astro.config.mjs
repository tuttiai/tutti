import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.tutti-ai.com",
  integrations: [
    starlight({
      title: "Tutti",
      description:
        "Open-source multi-agent orchestration framework for TypeScript",
      // logo: { src: "./public/logo.svg" },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/tuttiai/tutti" },
      ],
      editLink: {
        baseUrl: "https://github.com/tuttiai/tutti/edit/main/docs/",
      },
      customCss: [],
      // Algolia search — uncomment when ready:
      // head: [
      //   { tag: 'link', attrs: { rel: 'stylesheet', href: 'https://cdn.jsdelivr.net/npm/@docsearch/css@3' } },
      // ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Quick Start", slug: "getting-started/quick-start" },
            { label: "Core Concepts", slug: "getting-started/core-concepts" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Your First Agent", slug: "guides/your-first-agent" },
            { label: "Multi-Agent Orchestration", slug: "guides/multi-agent" },
            { label: "Adding Voices", slug: "guides/adding-voices" },
            { label: "Building a Voice", slug: "guides/building-a-voice" },
            { label: "Providers", slug: "guides/providers" },
            { label: "Memory & Sessions", slug: "guides/memory-sessions" },
            { label: "Security", slug: "guides/security" },
          ],
        },
        {
          label: "Voices",
          items: [
            { label: "Overview", slug: "voices/overview" },
            { label: "Filesystem", slug: "voices/filesystem" },
            { label: "GitHub", slug: "voices/github" },
            { label: "Playwright", slug: "voices/playwright" },
          ],
        },
        {
          label: "CLI",
          items: [{ label: "Reference", slug: "cli/reference" }],
        },
        {
          label: "API",
          items: [{ label: "Overview", slug: "api/overview" }],
        },
        {
          label: "Contributing",
          items: [
            { label: "Overview", slug: "contributing/overview" },
            { label: "Development Setup", slug: "contributing/development-setup" },
            { label: "Voice Authoring", slug: "contributing/voice-authoring" },
          ],
        },
      ],
    }),
  ],
});
