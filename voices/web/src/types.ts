/**
 * Normalised search result returned by every provider.
 *
 * All three backends (Brave, Serper, DuckDuckGo) map their native
 * response shapes to this common type before the tool returns it.
 */
export interface SearchResult {
  /** Page title. */
  title: string;
  /** Canonical URL. */
  url: string;
  /** Brief description or snippet. */
  snippet: string;
  /** ISO-8601 date string, or `undefined` when not provided. */
  published_date?: string;
}

/**
 * A web search backend that can execute a query and return normalised
 * results. Implementations live in `src/providers/`.
 */
export interface SearchProvider {
  /** Short identifier shown in logs and tool output. */
  readonly name: string;
  /** Execute a query and return up to `limit` results. */
  search(query: string, limit: number): Promise<SearchResult[]>;
}

/** Options shared across all provider constructors. */
export interface ProviderOptions {
  /** HTTP request timeout in milliseconds. */
  timeout_ms: number;
}

/** Default HTTP timeout for all search providers. */
export const DEFAULT_TIMEOUT_MS = 5_000;
