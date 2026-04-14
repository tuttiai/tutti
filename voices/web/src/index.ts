import type { Permission, Tool, Voice } from "@tuttiai/types";
import { resolveProvider } from "./providers/index.js";
import { createWebSearchTool } from "./tools/web-search.js";
import type { SearchProvider } from "./types.js";
import { DEFAULT_TIMEOUT_MS } from "./types.js";

export type { SearchResult, SearchProvider, ProviderOptions } from "./types.js";
export { DEFAULT_TIMEOUT_MS } from "./types.js";
export { resolveProvider, BraveProvider, SerperProvider, DuckDuckGoProvider } from "./providers/index.js";
export { createWebSearchTool } from "./tools/web-search.js";

/**
 * Options for {@link WebVoice}.
 */
export interface WebVoiceOptions {
  /**
   * Explicit search provider instance. When omitted the voice
   * auto-selects based on available API keys
   * (Brave > Serper > DuckDuckGo).
   */
  provider?: SearchProvider;
  /** HTTP request timeout in milliseconds. Default: 5000. */
  timeout_ms?: number;
}

/**
 * Web search voice — gives agents the ability to search the internet.
 *
 * @example
 * ```ts
 * import { WebVoice } from "@tuttiai/web";
 *
 * const score = defineScore({
 *   agents: {
 *     researcher: {
 *       voices: [new WebVoice()],
 *       permissions: ["network"],
 *       // ...
 *     },
 *   },
 * });
 * ```
 */
export class WebVoice implements Voice {
  readonly name = "web";
  readonly description = "Search the web for current information";
  readonly required_permissions: Permission[] = ["network"];
  readonly tools: Tool[];

  constructor(options: WebVoiceOptions = {}) {
    const provider =
      options.provider ?? resolveProvider(options.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    this.tools = [createWebSearchTool(provider)];
  }
}
