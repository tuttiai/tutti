import { describe, expect, it } from "vitest";
import { WhatsAppApiError } from "../src/graph-client.js";
import { whatsappErrorMessage } from "../src/utils/format.js";

describe("whatsappErrorMessage", () => {
  it("explains the 24h window for error 131047", () => {
    const err = new WhatsAppApiError({ message: "Re-engagement message", code: 131047 });
    expect(whatsappErrorMessage(err, "+31600000000")).toContain("24h window expired for +31600000000");
  });

  it("passes other API errors through with their context", () => {
    const err = new WhatsAppApiError({ message: "Bad param", code: 100, error_subcode: 33 });
    expect(whatsappErrorMessage(err, "ctx")).toBe("WhatsApp API error [100/33]: Bad param (context: ctx)");
  });

  it("uses the message of a plain Error", () => {
    expect(whatsappErrorMessage(new Error("socket hang up"), "ctx")).toBe("WhatsApp error for ctx: socket hang up");
  });

  it("uses the message of an error-like object", () => {
    expect(whatsappErrorMessage({ message: "shaped" }, "ctx")).toBe("WhatsApp error for ctx: shaped");
  });

  it("stringifies values without a string message", () => {
    expect(whatsappErrorMessage({ message: 42 }, "ctx")).toBe("WhatsApp error for ctx: [object Object]");
    expect(whatsappErrorMessage("boom", "ctx")).toBe("WhatsApp error for ctx: boom");
    expect(whatsappErrorMessage(null, "ctx")).toBe("WhatsApp error for ctx: null");
  });
});
