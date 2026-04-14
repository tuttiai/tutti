export class SecretsManager {
  private static redactPatterns = [
    /sk-ant-[a-zA-Z0-9-_]{20,}/g, // Anthropic keys
    /sk-[a-zA-Z0-9]{20,}/g, // OpenAI keys
    /ghp_[a-zA-Z0-9]{36}/g, // GitHub tokens
    /AIza[a-zA-Z0-9-_]{35}/g, // Google API keys
    /Bearer [a-zA-Z0-9-_.]{20,}/g, // Bearer tokens
  ];

  static redact(text: string): string {
    let result = text;
    for (const pattern of this.redactPatterns) {
      result = result.replace(pattern, "[REDACTED]");
    }
    return result;
  }

  static redactObject(obj: unknown): unknown {
    const str = JSON.stringify(obj);
    const redacted = this.redact(str);
    return JSON.parse(redacted) as unknown;
  }

  static require(key: string): string {
    const env = new Map(Object.entries(process.env));
    const val = env.get(key);
    if (!val)
      throw new Error(
        "Missing required env var: " +
          key +
          "\n" +
          "Add it to your .env file: " +
          key +
          "=your_value_here",
      );
    return val;
  }

  static optional(key: string, fallback?: string): string | undefined {
    const env = new Map(Object.entries(process.env));
    return env.get(key) ?? fallback;
  }
}
