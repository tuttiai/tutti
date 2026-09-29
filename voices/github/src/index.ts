import type { Permission, Voice, Tool } from "@tuttiai/types";
import { createOctokit } from "./client.js";
import { createListIssuesTool } from "./tools/list-issues.js";
import { createGetIssueTool } from "./tools/get-issue.js";
import { createCreateIssueTool } from "./tools/create-issue.js";
import { createCommentOnIssueTool } from "./tools/comment-on-issue.js";
import { createListPullRequestsTool } from "./tools/list-pull-requests.js";
import { createGetPullRequestTool } from "./tools/get-pull-request.js";
import { createCreateBranchTool } from "./tools/create-branch.js";
import { createCommitFilesTool } from "./tools/commit-files.js";
import { createCreatePullRequestTool } from "./tools/create-pull-request.js";
import { createGetFileContentsTool } from "./tools/get-file-contents.js";
import { createSearchCodeTool } from "./tools/search-code.js";
import { createListRepositoriesTool } from "./tools/list-repositories.js";
import { createGetRepositoryTool } from "./tools/get-repository.js";

export interface GitHubVoiceOptions {
  /** GitHub personal access token. Defaults to GITHUB_TOKEN env var. */
  token?: string;
}

export class GitHubVoice implements Voice {
  name = "github";
  description = "Interact with GitHub repositories, issues, pull requests, branches, and commits";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  constructor(options: GitHubVoiceOptions = {}) {
    const octokit = createOctokit(options.token);
    this.tools = [
      createListIssuesTool(octokit),
      createGetIssueTool(octokit),
      createCreateIssueTool(octokit),
      createCommentOnIssueTool(octokit),
      createListPullRequestsTool(octokit),
      createGetPullRequestTool(octokit),
      createCreateBranchTool(octokit),
      createCommitFilesTool(octokit),
      createCreatePullRequestTool(octokit),
      createGetFileContentsTool(octokit),
      createSearchCodeTool(octokit),
      createListRepositoriesTool(octokit),
      createGetRepositoryTool(octokit),
    ];
  }
}

export { createOctokit } from "./client.js";

export { GitHubVoiceConfigSchema, type GitHubVoiceConfig } from "./config-schema.js";
