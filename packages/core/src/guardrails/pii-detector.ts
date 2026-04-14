/**
 * Built-in guardrail: detects PII patterns (email, phone, SSN, credit card).
 *
 * Two modes:
 * - `"redact"` — replaces matched PII with `[PII]`.
 * - `"block"`  — throws {@link GuardrailError} on the first match.
 */

import type { GuardrailHook } from "@tuttiai/types";
import { GuardrailError } from "../errors.js";

/** Named PII patterns — order matters (more specific first). */
const PII_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "credit_card", regex: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g },
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // eslint-disable-next-line security/detect-unsafe-regex -- phone regex is bounded: max 15 digits, no nested quantifiers
  { name: "phone", regex: /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/g },
];

/**
 * Creates a guardrail hook that detects PII in text.
 *
 * @param action - `"redact"` replaces PII with `[PII]`; `"block"` throws.
 * @returns A {@link GuardrailHook} suitable for {@link AgentConfig.afterRun}.
 *
 * @example
 * const agent: AgentConfig = {
 *   // ...
 *   afterRun: piiDetector("redact"),
 * };
 */
export function piiDetector(action: "redact" | "block"): GuardrailHook {
  return (text: string): Promise<string> => {
    if (action === "block") {
      for (const { name, regex } of PII_PATTERNS) {
        // Reset lastIndex for stateful regexes
        regex.lastIndex = 0;
        if (regex.test(text)) {
          return Promise.reject(
            new GuardrailError(
              `PII detected in output (${name}). The response has been blocked to protect sensitive information.`,
              { guardrail: "pii_detector", pii_type: name },
            ),
          );
        }
      }
      return Promise.resolve(text);
    }

    // Redact mode — replace all matches with [PII]
    let result = text;
    for (const { regex } of PII_PATTERNS) {
      regex.lastIndex = 0;
      result = result.replace(regex, "[PII]");
    }
    return Promise.resolve(result);
  };
}
