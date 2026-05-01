import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.tutti-ai.com",
  integrations: [
    starlight({
      title: "Tutti AI",
      description: "All agents. All together.",
      logo: {
        light: "./src/assets/logo.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: false,
      },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/tuttiai/tutti" },
      ],
      editLink: {
        baseUrl: "https://github.com/tuttiai/tutti/edit/main/docs/",
      },
      customCss: ["./src/styles/custom.css"],
      head: [
        { tag: "link", attrs: { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" } },
        { tag: "link", attrs: { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32.png" } },
        { tag: "link", attrs: { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16.png" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://docs.tutti-ai.com/og-image.png" } },
        { tag: "meta", attrs: { property: "og:title", content: "Tutti AI" } },
        { tag: "meta", attrs: { property: "og:description", content: "All agents. All together." } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
      ],
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
            { label: "Smart Routing", slug: "guides/smart-routing" },
            { label: "Memory & Sessions", slug: "guides/memory-sessions" },
            { label: "Tool Result Caching", slug: "guides/tool-caching" },
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
            { label: "Discord", slug: "voices/discord" },
            { label: "Slack", slug: "voices/slack" },
            { label: "Postgres", slug: "voices/postgres" },
            { label: "Stripe", slug: "voices/stripe" },
            { label: "Twitter / X", slug: "voices/twitter" },
            { label: "Web", slug: "voices/web" },
            { label: "Sandbox", slug: "voices/sandbox" },
            { label: "RAG", slug: "voices/rag" },
            { label: "MCP bridge", slug: "voices/mcp" },
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
