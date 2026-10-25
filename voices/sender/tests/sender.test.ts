import { describe, it, expect, vi, afterEach } from "vitest";
import type { Tool, ToolContext } from "@tuttiai/types";
import { SenderVoice, SENDER_BASE_URL, createSenderClient } from "../src/index.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };
const KEY = "sender-secret-token-123";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function setup(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return responder(call);
  });
  const voice = new SenderVoice({ api_key: KEY, fetch: fetchMock });
  const tool = (name: string): Tool => {
    const t = voice.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  const run = (name: string, input: Record<string, unknown>) => {
    const t = tool(name);
    return t.execute(t.parameters.parse(input), ctx);
  };
  return { calls, run, voice, fetchMock };
}

const sub = {
  id: "sub1",
  email: "a@example.com",
  firstname: "Ada",
  lastname: "L",
  status: { email: "active" },
  subscriber_tags: [{ id: "g1", title: "News" }],
};
const meta = { current_page: 1, last_page: 2, total: 12 };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SenderVoice contract", () => {
  it("implements the Voice interface", () => {
    const { voice } = setup(() => jsonResponse(200, {}));
    expect(voice.name).toBe("sender");
    expect(typeof voice.description).toBe("string");
    expect(voice.required_permissions).toEqual(["network"]);
    for (const t of voice.tools) {
      expect(typeof t.description).toBe("string");
      expect(typeof t.execute).toBe("function");
      expect(t.parameters).toBeDefined();
    }
  });

  it("exposes exactly the 14 contracted tools", () => {
    const { voice } = setup(() => jsonResponse(200, {}));
    expect(voice.tools.map((t) => t.name).sort()).toEqual(
      [
        "list_groups", "list_subscribers", "get_subscriber", "list_campaigns", "get_campaign",
        "create_subscriber", "update_subscriber", "create_group", "add_subscriber_to_group",
        "remove_subscriber_from_group", "create_campaign", "send_campaign", "schedule_campaign",
        "delete_subscriber",
      ].sort(),
    );
  });

  it("marks exactly send_campaign, schedule_campaign and delete_subscriber destructive", () => {
    const { voice } = setup(() => jsonResponse(200, {}));
    const flagged = voice.tools.filter((t) => t.destructive === true).map((t) => t.name).sort();
    expect(flagged).toEqual(["delete_subscriber", "schedule_campaign", "send_campaign"]);
  });

  it("says in descriptions that create_campaign never sends and send_campaign is irreversible", () => {
    const { voice } = setup(() => jsonResponse(200, {}));
    const d = (n: string) => voice.tools.find((t) => t.name === n)?.description ?? "";
    expect(d("create_campaign")).toMatch(/NEVER sends/);
    expect(d("send_campaign")).toMatch(/real people/);
    expect(d("send_campaign")).toMatch(/CANNOT be undone/);
  });

  it("tears down without error", async () => {
    const { voice } = setup(() => jsonResponse(200, {}));
    await expect(voice.teardown()).resolves.toBeUndefined();
  });
});

describe("auth and request shape", () => {
  it("sends the bearer token and JSON headers to the v2 base URL", async () => {
    const { run, calls } = setup(() => jsonResponse(200, { data: [] }));
    await run("list_groups", {});
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/groups`);
    expect(calls[0]?.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.headers["Accept"]).toBe("application/json");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
  });

  it("falls back to SENDER_API_KEY when no api_key is given", async () => {
    vi.stubEnv("SENDER_API_KEY", "env-token-9");
    const calls: Call[] = [];
    const voice = new SenderVoice({
      fetch: async (url, init) => {
        calls.push({ url, method: "GET", headers: init?.headers as Record<string, string>, body: undefined });
        return jsonResponse(200, { data: [] });
      },
    });
    const t = voice.tools[0];
    await t?.execute(t.parameters.parse({}), ctx);
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer env-token-9");
  });

  it("reports setup instructions, not a throw, when no key is configured", async () => {
    vi.stubEnv("SENDER_API_KEY", "");
    const voice = new SenderVoice({ fetch: vi.fn() });
    const t = voice.tools[0];
    const res = await t?.execute(t.parameters.parse({}), ctx);
    expect(res?.is_error).toBe(true);
    expect(res?.content).toMatch(/SENDER_API_KEY/);
    expect(createSenderClient({}).kind).toBe("missing");
  });

  it("uses the real global fetch by default without calling it at construction", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    new SenderVoice({ api_key: KEY });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("read tools", () => {
  it("list_groups lists groups with pagination hint", async () => {
    const { run, calls } = setup(() =>
      jsonResponse(200, { data: [{ id: "g1", title: "News", recipient_count: 5 }], meta }),
    );
    const res = await run("list_groups", { page: 2 });
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/groups?page=2`);
    expect(res.content).toContain("g1 · News · 5 subscribers");
    expect(res.content).toContain("pass page=2");
    expect(res.is_error).toBeUndefined();
  });

  it("list_groups handles an empty account", async () => {
    const { run } = setup(() => jsonResponse(200, { data: [] }));
    expect((await run("list_groups", {})).content).toBe("No groups found.");
  });

  it("list_subscribers uses the group endpoint when a group is given", async () => {
    const { run, calls } = setup(() => jsonResponse(200, { data: [sub], meta }));
    const res = await run("list_subscribers", { group_id: "g1", page: 1 });
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/groups/g1/subscribers?page=1`);
    expect(res.content).toContain("a@example.com");
    expect(res.content).toContain("Ada L");
  });

  it("list_subscribers uses the account endpoint without a group", async () => {
    const { run, calls } = setup(() => jsonResponse(200, { data: [sub] }));
    await run("list_subscribers", {});
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/subscribers`);
  });

  it("list_subscribers reports none found", async () => {
    const { run } = setup(() => jsonResponse(200, { data: [] }));
    expect((await run("list_subscribers", {})).content).toBe("No subscribers found.");
  });

  it("get_subscriber encodes an email into the path", async () => {
    const { run, calls } = setup(() =>
      jsonResponse(200, { data: { ...sub, columns: [{ id: "c", title: "Company", value: "Acme" }] } }),
    );
    const res = await run("get_subscriber", { subscriber: "a+b@example.com" });
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/subscribers/a%2Bb%40example.com`);
    expect(res.content).toContain("Acme");
  });

  it("list_campaigns passes status, limit and page", async () => {
    const { run, calls } = setup(() =>
      jsonResponse(200, { data: [{ id: "c1", status: "DRAFT", subject: "Hi", title: "Spring" }], meta }),
    );
    const res = await run("list_campaigns", { status: "DRAFT", limit: 5, page: 1 });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v2/campaigns");
    expect(url.searchParams.get("status")).toBe("DRAFT");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(res.content).toContain("c1 · DRAFT · Hi");
  });

  it("list_campaigns reports none found", async () => {
    const { run } = setup(() => jsonResponse(200, { data: [] }));
    expect((await run("list_campaigns", {})).content).toBe("No campaigns found.");
  });

  it("get_campaign summarises status, schedule and counts", async () => {
    const { run, calls } = setup(() =>
      jsonResponse(200, {
        data: { id: "c1", status: "SCHEDULED", subject: "Hi", from: "Shop", reply_to: "r@example.com", schedule_time: "2026-11-01 09:00:00", sent_count: 0 },
      }),
    );
    const res = await run("get_campaign", { campaign_id: "c1" });
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/campaigns/c1`);
    expect(res.content).toContain("scheduled: 2026-11-01 09:00:00");
    expect(res.content).toContain("from: Shop");
  });
});

describe("write tools", () => {
  it("create_subscriber posts the contract body", async () => {
    const { run, calls } = setup(() => jsonResponse(200, { success: true, data: sub }));
    const res = await run("create_subscriber", {
      email: "a@example.com", firstname: "Ada", groups: ["g1"], fields: { "{$company}": "Acme" }, trigger_automation: false,
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/subscribers`);
    expect(calls[0]?.body).toEqual({
      email: "a@example.com", firstname: "Ada", groups: ["g1"], fields: { "{$company}": "Acme" }, trigger_automation: false,
    });
    expect(res.content).toContain("Created subscriber");
  });

  it("update_subscriber patches by identifier without sending the identifier in the body", async () => {
    const { run, calls } = setup(() => jsonResponse(200, { success: true, data: [] }));
    const res = await run("update_subscriber", { subscriber: "a@example.com", lastname: "Lovelace", subscriber_status: "UNSUBSCRIBED" });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/subscribers/a%40example.com`);
    expect(calls[0]?.body).toEqual({ lastname: "Lovelace", subscriber_status: "UNSUBSCRIBED" });
    expect(res.content).toContain("Updated subscriber");
  });

  it("create_group posts the title", async () => {
    const { run, calls } = setup(() => jsonResponse(200, { success: true, data: { id: "g9", title: "VIP" } }));
    const res = await run("create_group", { title: "VIP" });
    expect(calls[0]?.body).toEqual({ title: "VIP" });
    expect(res.content).toBe("Created group g9 · VIP");
  });

  it("add_subscriber_to_group posts the email array to the group path", async () => {
    const { run, calls } = setup(() =>
      jsonResponse(200, { success: true, message: { subscribers_added_to_group: ["a@example.com"], non_existing_subscribers: [] } }),
    );
    const res = await run("add_subscriber_to_group", { group_id: "g1", email: "a@example.com" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/subscribers/groups/g1`);
    expect(calls[0]?.body).toEqual({ subscribers: ["a@example.com"] });
    expect(res.is_error).toBeUndefined();
  });

  it("add_subscriber_to_group flags a non-existent subscriber as an error", async () => {
    const { run } = setup(() =>
      jsonResponse(200, { success: true, message: { subscribers_added_to_group: [], non_existing_subscribers: ["a@example.com"] } }),
    );
    const res = await run("add_subscriber_to_group", { group_id: "g1", email: "a@example.com", trigger_automation: false });
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/create_subscriber/);
  });

  it("remove_subscriber_from_group sends DELETE with a body", async () => {
    const { run, calls } = setup(() => jsonResponse(200, { success: true, message: "Removed tag" }));
    const res = await run("remove_subscriber_from_group", { group_id: "g1", email: "a@example.com", trigger_automation: false });
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.body).toEqual({ subscribers: ["a@example.com"], trigger_automation: false });
    expect(res.content).toContain("Removed a@example.com from group g1");
  });

  it("create_campaign creates an html draft and says nothing was sent", async () => {
    const { run, calls } = setup(() => jsonResponse(200, { success: true, data: { id: "c7", status: "DRAFT" } }));
    const res = await run("create_campaign", {
      title: "Spring", subject: "Hi", from: "Shop", reply_to: "r@example.com", content: "<p>Hello</p>", groups: ["g1"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/campaigns`);
    expect(calls[0]?.body).toEqual({
      title: "Spring", subject: "Hi", from: "Shop", reply_to: "r@example.com", content: "<p>Hello</p>", groups: ["g1"], content_type: "html",
    });
    expect(res.content).toContain("Nothing has been sent");
  });
});

describe("destructive tools", () => {
  it("send_campaign posts to /send with no body", async () => {
    const { run, calls } = setup(() => jsonResponse(200, { success: true, message: "Campaign started to send" }));
    const res = await run("send_campaign", { campaign_id: "c7" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/campaigns/c7/send`);
    expect(calls[0]?.body).toBeUndefined();
    expect(res.content).toContain("started sending");
  });

  it("schedule_campaign posts schedule_time to /schedule", async () => {
    const { run, calls } = setup(() => jsonResponse(200, { success: true, message: "Success scheduled" }));
    const res = await run("schedule_campaign", { campaign_id: "c7", schedule_time: "2026-11-01 09:00:00" });
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/campaigns/c7/schedule`);
    expect(calls[0]?.body).toEqual({ schedule_time: "2026-11-01 09:00:00" });
    expect(res.content).toContain("scheduled for 2026-11-01 09:00:00");
  });

  it("schedule_campaign rejects a malformed time before any request", () => {
    const { voice, fetchMock } = setup(() => jsonResponse(200, {}));
    const t = voice.tools.find((x) => x.name === "schedule_campaign");
    expect(t?.parameters.safeParse({ campaign_id: "c7", schedule_time: "tomorrow" }).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delete_subscriber sends DELETE with the email in subscribers", async () => {
    const { run, calls } = setup(() => jsonResponse(200, { message: "Selected subscribers will be deleted shortly", delete_instance: "x" }));
    const res = await run("delete_subscriber", { email: "a@example.com" });
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${SENDER_BASE_URL}/subscribers`);
    expect(calls[0]?.body).toEqual({ subscribers: ["a@example.com"] });
    expect(res.content).toContain("queued");
  });
});

const TOOL_INPUTS: Record<string, Record<string, unknown>> = {
  list_groups: {},
  list_subscribers: {},
  get_subscriber: { subscriber: "a@example.com" },
  list_campaigns: {},
  get_campaign: { campaign_id: "c1" },
  create_subscriber: { email: "a@example.com" },
  update_subscriber: { subscriber: "a@example.com", firstname: "A" },
  create_group: { title: "VIP" },
  add_subscriber_to_group: { group_id: "g1", email: "a@example.com" },
  remove_subscriber_from_group: { group_id: "g1", email: "a@example.com" },
  create_campaign: { title: "T", subject: "S", from: "F", reply_to: "r@example.com", content: "<p>x</p>" },
  send_campaign: { campaign_id: "c1" },
  schedule_campaign: { campaign_id: "c1", schedule_time: "2026-11-01 09:00:00" },
  delete_subscriber: { email: "a@example.com" },
};

describe("error paths", () => {
  const names = Object.keys(TOOL_INPUTS);

  it.each(names)("%s returns is_error on a 401 without leaking the key", async (name) => {
    const { run } = setup(() => jsonResponse(401, { message: `Unauthenticated with ${KEY}` }));
    const res = await run(name, TOOL_INPUTS[name] ?? {});
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("[401]");
    expect(res.content).not.toContain(KEY);
  });

  it.each(names)("%s returns is_error when fetch rejects, without leaking the key", async (name) => {
    const { run } = setup(() => {
      throw new Error(`socket hang up for Bearer ${KEY}`);
    });
    const res = await run(name, TOOL_INPUTS[name] ?? {});
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("Could not reach Sender");
    expect(res.content).not.toContain(KEY);
  });

  it("surfaces 422 validation messages", async () => {
    const { run } = setup(() =>
      jsonResponse(422, { message: "The given data was invalid.", errors: { reply_to: ["The reply to domain is not verified."] } }),
    );
    const res = await run("create_campaign", TOOL_INPUTS["create_campaign"] ?? {});
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("[422]");
    expect(res.content).toContain("reply_to: The reply to domain is not verified.");
  });

  it("surfaces 429 with Retry-After", async () => {
    const { run } = setup(() => jsonResponse(429, { message: "Too Many Attempts." }, { "retry-after": "30" }));
    const res = await run("list_groups", {});
    expect(res.content).toContain("[429]");
    expect(res.content).toContain("Retry after 30 seconds");
  });

  it("covers 403, 404 and 5xx messages", async () => {
    for (const [status, text] of [[403, "refused"], [404, "find"], [500, "server error"], [400, "Sender error"]] as const) {
      const { run } = setup(() => jsonResponse(status, { message: "x" }));
      const res = await run("get_campaign", { campaign_id: "c1" });
      expect(res.is_error).toBe(true);
      expect(res.content).toContain(`[${status}]`);
      expect(res.content).toContain(text);
    }
  });

  it("treats success:false in a 200 body as an error", async () => {
    const { run } = setup(() => jsonResponse(200, { success: false, message: "Group not found" }));
    const res = await run("create_group", { title: "X" });
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("Group not found");
  });

  it("handles a non-JSON error body and a non-JSON success body", async () => {
    const bad = setup(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    const r1 = await bad.run("list_groups", {});
    expect(r1.is_error).toBe(true);
    expect(r1.content).toContain("[502]");
    const ok = setup(() => new Response("not json", { status: 200 }));
    expect((await ok.run("list_groups", {})).content).toBe("No groups found.");
  });

  it("never throws even when reading the body fails", async () => {
    const { run } = setup(() => {
      const res = new Response("x", { status: 200 });
      Object.defineProperty(res, "text", { value: async () => { throw new Error("boom"); } });
      return res;
    });
    const res = await run("list_groups", {});
    expect(res.is_error).toBeUndefined();
  });

  it("returns an error result when a tool body throws unexpectedly", async () => {
    const { voice } = setup(() => jsonResponse(200, {}));
    const t = voice.tools.find((x) => x.name === "list_groups");
    // Bypass the schema so input is not an object: the tool must still not throw.
    const res = await t?.execute(null as never, ctx);
    expect(res?.is_error).toBe(true);
    expect(res?.content).not.toContain(KEY);
  });
});

describe("secret never in output", () => {
  it("does not echo the key in any successful result", async () => {
    for (const [name, input] of Object.entries(TOOL_INPUTS)) {
      const { run } = setup(() => jsonResponse(200, { success: true, data: { id: "1", title: "t", email: "a@example.com" }, message: "ok" }));
      const res = await run(name, input);
      expect(res.content).not.toContain(KEY);
    }
  });
});
