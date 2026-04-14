import { describe, it, expect } from "vitest";
import {
  renderList,
  renderShow,
  renderInspect,
  exportJSON,
  exportMarkdown,
  messageToText,
} from "../../src/commands/replay.js";
import type { ChatMessage, Session } from "@tuttiai/types";

const mockMessages: ChatMessage[] = [
  {
    role: "user",
    content: "What is the capital of France?",
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "The capital of France is Paris." },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tool-1",
        name: "web_search",
        input: { query: "France population 2026" },
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "France population: 68.4 million",
        is_error: false,
      },
    ],
  },
];

const mockSession: Session = {
  id: "test-session-abc123",
  agent_name: "researcher",
  messages: mockMessages,
  created_at: new Date("2026-04-14T10:00:00Z"),
  updated_at: new Date("2026-04-14T10:05:00Z"),
};

describe("replay — renderShow", () => {
  it("prints the correct content for show 0 (user text message)", () => {
    const output = renderShow(mockMessages, 0);

    expect(output).toContain("Turn 0");
    expect(output).toContain("user");
    expect(output).toContain("What is the capital of France?");
  });

  it("prints the correct content for show 1 (assistant text block)", () => {
    const output = renderShow(mockMessages, 1);

    expect(output).toContain("Turn 1");
    expect(output).toContain("assistant");
    expect(output).toContain("The capital of France is Paris.");
  });

  it("prints tool_use details for show 2", () => {
    const output = renderShow(mockMessages, 2);

    expect(output).toContain("tool_use: web_search");
    expect(output).toContain("tool-1");
    expect(output).toContain("France population 2026");
  });

  it("prints tool_result for show 3", () => {
    const output = renderShow(mockMessages, 3);

    expect(output).toContain("tool_result");
    expect(output).toContain("68.4 million");
  });

  it("returns error for out-of-range index", () => {
    const output = renderShow(mockMessages, 99);

    expect(output).toContain("out of range");
  });
});

describe("replay — renderList", () => {
  it("lists all messages with index and role", () => {
    const output = renderList(mockMessages);

    expect(output).toContain("0");
    expect(output).toContain("user");
    expect(output).toContain("capital of France");
    expect(output).toContain("1");
    expect(output).toContain("assistant");
    expect(output).toContain("Paris");
  });
});

describe("replay — renderInspect", () => {
  it("returns raw JSON for the message", () => {
    const output = renderInspect(mockMessages, 0);
    const parsed = JSON.parse(output) as ChatMessage;

    expect(parsed.role).toBe("user");
    expect(parsed.content).toBe("What is the capital of France?");
  });
});

describe("replay — messageToText", () => {
  it("handles plain string content", () => {
    const text = messageToText(mockMessages[0]!);
    expect(text).toBe("What is the capital of France?");
  });

  it("handles ContentBlock array", () => {
    const text = messageToText(mockMessages[1]!);
    expect(text).toBe("The capital of France is Paris.");
  });

  it("extracts text from array-based text content", () => {
    const text = messageToText(mockMessages[1]!);
    expect(text).toBe("The capital of France is Paris.");
  });

  it("renders tool_use as bracket notation", () => {
    const text = messageToText(mockMessages[2]!);
    expect(text).toContain("[tool_use web_search]");
  });

  it("renders tool_result as bracket notation with preview text", () => {
    const text = messageToText(mockMessages[3]!);
    expect(text).toContain("[tool_result");
    expect(text).toContain("68.4 million");
  });
});

describe("replay — exportJSON", () => {
  it("exports valid JSON with session metadata", () => {
    const json = exportJSON(mockSession);
    const parsed = JSON.parse(json) as {
      id: string;
      agent_name: string;
      created_at: string;
      messages: unknown[];
    };

    expect(parsed.id).toBe("test-session-abc123");
    expect(parsed.agent_name).toBe("researcher");
    expect(parsed.created_at).toBe("2026-04-14T10:00:00.000Z");
    expect(parsed.messages).toHaveLength(4);
  });
});

describe("replay — exportMarkdown", () => {
  it("exports markdown with session header and all turns", () => {
    const md = exportMarkdown(mockSession);

    expect(md).toContain("# Session test-session-abc123");
    expect(md).toContain("**Agent:** researcher");
    expect(md).toContain("## Turn 0 (user)");
    expect(md).toContain("## Turn 1 (assistant)");
    expect(md).toContain("capital of France");
    expect(md).toContain("**Tool call:** `web_search`");
  });
});
