import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import { GitHubVoice } from "../src/index.js";
import { createOctokit } from "../src/client.js";
import { createListIssuesTool } from "../src/tools/list-issues.js";
import { createGetIssueTool } from "../src/tools/get-issue.js";
import { createCreateIssueTool } from "../src/tools/create-issue.js";
import { createCommentOnIssueTool } from "../src/tools/comment-on-issue.js";
import { createListPullRequestsTool } from "../src/tools/list-pull-requests.js";
import { createGetPullRequestTool } from "../src/tools/get-pull-request.js";
import { createGetFileContentsTool } from "../src/tools/get-file-contents.js";
import { createSearchCodeTool } from "../src/tools/search-code.js";
import { createListRepositoriesTool } from "../src/tools/list-repositories.js";
import { createGetRepositoryTool } from "../src/tools/get-repository.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// Mock Octokit — we intercept every API method
function createMockOctokit() {
  return {
    issues: {
      listForRepo: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      createComment: vi.fn(),
    },
    pulls: {
      list: vi.fn(),
      get: vi.fn(),
    },
    repos: {
      getContent: vi.fn(),
      get: vi.fn(),
      listForOrg: vi.fn(),
      listForUser: vi.fn(),
    },
    search: {
      code: vi.fn(),
    },
  } as any;
}

let octokit: ReturnType<typeof createMockOctokit>;

beforeEach(() => {
  octokit = createMockOctokit();
});

// ---------------------------------------------------------------------------
// GitHubVoice
// ---------------------------------------------------------------------------

describe("GitHubVoice", () => {
  it("implements Voice with 10 tools", () => {
    const voice = new GitHubVoice({ token: "fake" });
    expect(voice.name).toBe("github");
    expect(voice.tools).toHaveLength(10);
    const names = voice.tools.map((t) => t.name);
    expect(names).toContain("list_issues");
    expect(names).toContain("get_issue");
    expect(names).toContain("create_issue");
    expect(names).toContain("comment_on_issue");
    expect(names).toContain("list_pull_requests");
    expect(names).toContain("get_pull_request");
    expect(names).toContain("get_file_contents");
    expect(names).toContain("search_code");
    expect(names).toContain("list_repositories");
    expect(names).toContain("get_repository");
  });
});

// ---------------------------------------------------------------------------
// list_issues
// ---------------------------------------------------------------------------

describe("list_issues", () => {
  it("returns formatted issue list", async () => {
    octokit.issues.listForRepo.mockResolvedValue({
      data: [
        { number: 1, title: "Bug fix", state: "open", labels: [{ name: "bug" }] },
        { number: 2, title: "Feature", state: "open", labels: [] },
      ],
    });

    const tool = createListIssuesTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "org", repo: "app" }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("#1");
    expect(result.content).toContain("Bug fix");
    expect(result.content).toContain("[bug]");
    expect(result.content).toContain("#2");
  });

  it("filters out pull requests from issue list", async () => {
    octokit.issues.listForRepo.mockResolvedValue({
      data: [
        { number: 1, title: "Issue", state: "open", labels: [] },
        { number: 2, title: "PR", state: "open", labels: [], pull_request: {} },
      ],
    });

    const tool = createListIssuesTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r" }),
      ctx,
    );

    expect(result.content).toContain("#1");
    expect(result.content).not.toContain("#2");
  });

  it("explains when all results are PRs, not issues", async () => {
    octokit.issues.listForRepo.mockResolvedValue({
      data: [
        { number: 1, title: "PR only", state: "open", labels: [], pull_request: {} },
      ],
    });

    const tool = createListIssuesTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r" }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("all were pull requests");
  });

  it("explains when zero results (possible rate limit)", async () => {
    octokit.issues.listForRepo.mockResolvedValue({ data: [] });

    const tool = createListIssuesTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r" }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("No open issues found");
    expect(result.content).toContain("rate-limited");
  });

  it("includes status code on 404 error", async () => {
    const err = new Error("Not Found");
    (err as any).status = 404;
    octokit.issues.listForRepo.mockRejectedValue(err);

    const tool = createListIssuesTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[404]");
    expect(result.content).toContain("Not found");
  });

  it("includes rate limit message on 403 error", async () => {
    const err = new Error("API rate limit exceeded");
    (err as any).status = 403;
    octokit.issues.listForRepo.mockRejectedValue(err);

    const tool = createListIssuesTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[403]");
    expect(result.content).toContain("rate limited");
  });

  it("includes auth message on 401 error", async () => {
    const err = new Error("Bad credentials");
    (err as any).status = 401;
    octokit.issues.listForRepo.mockRejectedValue(err);

    const tool = createListIssuesTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[401]");
    expect(result.content).toContain("Authentication failed");
  });
});

// ---------------------------------------------------------------------------
// get_issue
// ---------------------------------------------------------------------------

describe("get_issue", () => {
  it("returns full issue details", async () => {
    octokit.issues.get.mockResolvedValue({
      data: {
        number: 42,
        title: "Important bug",
        state: "open",
        user: { login: "alice" },
        labels: [{ name: "critical" }],
        assignees: [{ login: "bob" }],
        comments: 3,
        html_url: "https://github.com/o/r/issues/42",
        created_at: "2025-01-01T00:00:00Z",
        body: "This is the description",
      },
    });

    const tool = createGetIssueTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r", issue_number: 42 }),
      ctx,
    );

    expect(result.content).toContain("#42: Important bug");
    expect(result.content).toContain("alice");
    expect(result.content).toContain("critical");
    expect(result.content).toContain("bob");
    expect(result.content).toContain("This is the description");
  });
});

// ---------------------------------------------------------------------------
// create_issue
// ---------------------------------------------------------------------------

describe("create_issue", () => {
  it("creates an issue and returns number and url", async () => {
    octokit.issues.create.mockResolvedValue({
      data: {
        number: 99,
        title: "New issue",
        html_url: "https://github.com/o/r/issues/99",
      },
    });

    const tool = createCreateIssueTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r", title: "New issue" }),
      ctx,
    );

    expect(result.content).toContain("#99");
    expect(result.content).toContain("https://github.com/o/r/issues/99");
  });
});

// ---------------------------------------------------------------------------
// comment_on_issue
// ---------------------------------------------------------------------------

describe("comment_on_issue", () => {
  it("adds a comment and returns url", async () => {
    octokit.issues.createComment.mockResolvedValue({
      data: { html_url: "https://github.com/o/r/issues/1#comment-123" },
    });

    const tool = createCommentOnIssueTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r", issue_number: 1, body: "LGTM" }),
      ctx,
    );

    expect(result.content).toContain("Comment added");
    expect(result.content).toContain("#1");
  });
});

// ---------------------------------------------------------------------------
// list_pull_requests
// ---------------------------------------------------------------------------

describe("list_pull_requests", () => {
  it("returns formatted PR list", async () => {
    octokit.pulls.list.mockResolvedValue({
      data: [
        {
          number: 10,
          title: "Add feature",
          state: "open",
          user: { login: "dev" },
          head: { ref: "feat/x" },
          base: { ref: "main" },
        },
      ],
    });

    const tool = createListPullRequestsTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r" }),
      ctx,
    );

    expect(result.content).toContain("#10");
    expect(result.content).toContain("Add feature");
    expect(result.content).toContain("dev");
    expect(result.content).toContain("feat/x → main");
  });
});

// ---------------------------------------------------------------------------
// get_pull_request
// ---------------------------------------------------------------------------

describe("get_pull_request", () => {
  it("returns full PR details", async () => {
    octokit.pulls.get.mockResolvedValue({
      data: {
        number: 10,
        title: "Big PR",
        state: "open",
        merged: false,
        user: { login: "dev" },
        head: { ref: "feat" },
        base: { ref: "main" },
        changed_files: 5,
        additions: 100,
        deletions: 20,
        comments: 2,
        review_comments: 3,
        html_url: "https://github.com/o/r/pull/10",
        body: "PR description",
      },
    });

    const tool = createGetPullRequestTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r", pr_number: 10 }),
      ctx,
    );

    expect(result.content).toContain("#10: Big PR");
    expect(result.content).toContain("+100");
    expect(result.content).toContain("-20");
    expect(result.content).toContain("PR description");
  });
});

// ---------------------------------------------------------------------------
// get_file_contents
// ---------------------------------------------------------------------------

describe("get_file_contents", () => {
  it("returns decoded file contents", async () => {
    const encoded = Buffer.from("hello world").toString("base64");
    octokit.repos.getContent.mockResolvedValue({
      data: { type: "file", content: encoded },
    });

    const tool = createGetFileContentsTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r", path: "README.md" }),
      ctx,
    );

    expect(result.content).toBe("hello world");
  });

  it("handles directory listing", async () => {
    octokit.repos.getContent.mockResolvedValue({
      data: [
        { name: "src", type: "dir" },
        { name: "index.ts", type: "file" },
      ],
    });

    const tool = createGetFileContentsTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "o", repo: "r", path: "." }),
      ctx,
    );

    expect(result.content).toContain("directory");
    expect(result.content).toContain("src");
    expect(result.content).toContain("index.ts");
  });
});

// ---------------------------------------------------------------------------
// search_code
// ---------------------------------------------------------------------------

describe("search_code", () => {
  it("returns formatted search results", async () => {
    octokit.search.code.mockResolvedValue({
      data: {
        total_count: 1,
        items: [
          {
            repository: { full_name: "o/r" },
            path: "src/main.ts",
            html_url: "https://github.com/o/r/blob/main/src/main.ts",
          },
        ],
      },
    });

    const tool = createSearchCodeTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ query: "defineScore" }),
      ctx,
    );

    expect(result.content).toContain("1 results");
    expect(result.content).toContain("o/r/src/main.ts");
  });

  it("returns no-match message", async () => {
    octokit.search.code.mockResolvedValue({
      data: { total_count: 0, items: [] },
    });

    const tool = createSearchCodeTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ query: "xyznoexist" }),
      ctx,
    );

    expect(result.content).toContain("No code matches");
  });
});

// ---------------------------------------------------------------------------
// list_repositories
// ---------------------------------------------------------------------------

describe("list_repositories", () => {
  it("returns formatted repo list", async () => {
    octokit.repos.listForOrg.mockRejectedValue(new Error("Not an org"));
    octokit.repos.listForUser.mockResolvedValue({
      data: [
        {
          name: "tutti",
          description: "Multi-agent framework",
          stargazers_count: 42,
          language: "TypeScript",
        },
      ],
    });

    const tool = createListRepositoriesTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "tuttiai" }),
      ctx,
    );

    expect(result.content).toContain("tutti");
    expect(result.content).toContain("42");
    expect(result.content).toContain("TypeScript");
  });
});

// ---------------------------------------------------------------------------
// get_repository
// ---------------------------------------------------------------------------

describe("get_repository", () => {
  it("returns full repo details", async () => {
    octokit.repos.get.mockResolvedValue({
      data: {
        full_name: "tuttiai/tutti",
        description: "All agents. All together.",
        stargazers_count: 100,
        forks_count: 10,
        language: "TypeScript",
        default_branch: "main",
        topics: ["ai", "agents"],
        visibility: "public",
        private: false,
        created_at: "2025-01-01",
        updated_at: "2025-06-01",
        html_url: "https://github.com/tuttiai/tutti",
      },
    });

    const tool = createGetRepositoryTool(octokit);
    const result = await tool.execute(
      tool.parameters.parse({ owner: "tuttiai", repo: "tutti" }),
      ctx,
    );

    expect(result.content).toContain("tuttiai/tutti");
    expect(result.content).toContain("100");
    expect(result.content).toContain("TypeScript");
    expect(result.content).toContain("ai, agents");
  });
});
