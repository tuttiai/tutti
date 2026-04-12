export class UrlValidationError extends Error {
  public readonly code = "URL_BLOCKED";
  constructor(public readonly url: string, message?: string) {
    super(message ?? `URL blocked: "${url}".`);
    this.name = "UrlValidationError";
  }
}

export class UrlSanitizer {
  private static blocked = [
    /^file:/i,
    /^javascript:/i,
    /^data:/i,
    /^https?:\/\/10\./,
    /^https?:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^https?:\/\/192\.168\./,
  ];

  static validate(url: string): string {
    for (const pattern of this.blocked) {
      if (pattern.test(url)) {
        throw new UrlValidationError(url, "URL not allowed: " + url);
      }
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new UrlValidationError(url, "URL must use http:// or https:// protocol");
    }
    return url;
  }
}
