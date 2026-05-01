export interface Template {
  id: string;
  name: string;
  description: string;
  deps: Record<string, string>;
  envVars: string[];
  score: string;
}

const minimal: Template = {
  id: "minimal",
  name: "Minimal",
  description: "One agent, no voices — the simplest starting point",
  deps: {},
  envVars: [],
  score: `import { defineScore, AnthropicProvider } from "@tuttiai/core"

export default defineScore({
  // Uncomment to enable smart model routing — cuts costs 40–70% automatically
  // import { SmartProvider } from "@tuttiai/router"
  // provider: new SmartProvider({
  //   tiers: [
  //     { tier: "small",  provider: new AnthropicProvider(), model: "claude-haiku-4-5-20251001" },
  //     { tier: "medium", provider: new AnthropicProvider(), model: "claude-sonnet-4-6" },
  //     { tier: "large",  provider: new AnthropicProvider(), model: "claude-opus-4-7" },
  //   ],
  //   classifier: "heuristic",
  //   policy: "cost-optimised",
  // }),
  provider: new AnthropicProvider(),
  default_model: "claude-sonnet-4-20250514",
  agents: {
    assistant: {
      name: "Assistant",
      system_prompt: "You are a helpful assistant.",
      voices: [],
    }
  }
})
`,
};

const codingAgent: Template = {
  id: "coding-agent",
  name: "Coding Agent",
  description: "TypeScript developer with filesystem + GitHub access",
  deps: { "@tuttiai/filesystem": "*", "@tuttiai/github": "*" },
  envVars: ["GITHUB_TOKEN=ghp_your_token_here"],
  score: `import { defineScore, AnthropicProvider } from "@tuttiai/core"
import { FilesystemVoice } from "@tuttiai/filesystem"
import { GitHubVoice } from "@tuttiai/github"

export default defineScore({
  provider: new AnthropicProvider(),
  default_model: "claude-sonnet-4-20250514",
  agents: {
    coder: {
      name: "Coder",
      system_prompt:
        "You are an expert TypeScript developer. " +
        "You read and write code using the filesystem voice, " +
        "and manage issues and PRs via the GitHub voice. " +
        "Write clean, tested, well-documented code.",
      voices: [new FilesystemVoice(), new GitHubVoice()],
      permissions: ["filesystem", "network"],
      streaming: true,
    }
  }
})
`,
};

const researchAgent: Template = {
  id: "research-agent",
  name: "Research Agent",
  description: "Researcher that saves structured notes to files",
  deps: { "@tuttiai/filesystem": "*" },
  envVars: [],
  score: `import { defineScore, AnthropicProvider } from "@tuttiai/core"
import { FilesystemVoice } from "@tuttiai/filesystem"

export default defineScore({
  provider: new AnthropicProvider(),
  default_model: "claude-sonnet-4-20250514",
  agents: {
    researcher: {
      name: "Researcher",
      system_prompt:
        "You are an expert researcher. " +
        "Analyze topics thoroughly, cite sources, and save " +
        "structured notes as markdown files using the filesystem voice. " +
        "Organize findings with clear headings and bullet points.",
      voices: [new FilesystemVoice()],
      permissions: ["filesystem"],
      streaming: true,
    }
  }
})
`,
};

const qaPipeline: Template = {
  id: "qa-pipeline",
  name: "QA Pipeline",
  description: "Orchestrator + QA specialist with browser testing and HITL",
  deps: { "@tuttiai/playwright": "*" },
  envVars: [],
  score: `import { defineScore, AnthropicProvider } from "@tuttiai/core"
import { PlaywrightVoice } from "@tuttiai/playwright"

export default defineScore({
  provider: new AnthropicProvider(),
  default_model: "claude-sonnet-4-20250514",
  entry: "orchestrator",
  agents: {
    orchestrator: {
      name: "QA Lead",
      system_prompt:
        "You are a QA lead. Triage incoming bugs by delegating " +
        "browser testing to the QA specialist. Use human-in-the-loop " +
        "to ask for approval before marking bugs as verified.",
      voices: [],
      role: "orchestrator",
      delegates: ["qa"],
      allow_human_input: true,
      streaming: true,
    },
    qa: {
      name: "QA Specialist",
      system_prompt:
        "You are a QA engineer. Navigate to URLs, check elements, " +
        "take screenshots, and verify bug reports using the browser.",
      voices: [new PlaywrightVoice()],
      permissions: ["network", "browser"],
      role: "specialist",
      budget: { max_cost_usd: 0.50, warn_at_percent: 80 },
      streaming: true,
    }
  }
})
`,
};

const devTeam: Template = {
  id: "dev-team",
  name: "Dev Team",
  description: "Full team: orchestrator + coder + PM + QA with all voices",
  deps: {
    "@tuttiai/filesystem": "*",
    "@tuttiai/github": "*",
    "@tuttiai/playwright": "*",
  },
  envVars: ["GITHUB_TOKEN=ghp_your_token_here"],
  score: `import { defineScore, AnthropicProvider, createLoggingHook, createBlocklistHook, createLogger } from "@tuttiai/core"
import { FilesystemVoice } from "@tuttiai/filesystem"
import { GitHubVoice } from "@tuttiai/github"
import { PlaywrightVoice } from "@tuttiai/playwright"

const logger = createLogger("dev-team")

export default defineScore({
  provider: new AnthropicProvider(),
  default_model: "claude-sonnet-4-20250514",
  entry: "orchestrator",
  hooks: {
    ...createLoggingHook(logger),
    ...createBlocklistHook(["delete_file"]),
  },
  agents: {
    orchestrator: {
      name: "Tech Lead",
      system_prompt:
        "You are the tech lead. Break tasks into subtasks and delegate: " +
        "code tasks to Coder, documentation to PM, testing to QA. " +
        "Review outputs before presenting to the user.",
      voices: [],
      role: "orchestrator",
      delegates: ["coder", "pm", "qa"],
      allow_human_input: true,
      streaming: true,
    },
    coder: {
      name: "Coder",
      system_prompt:
        "You are a senior TypeScript developer. Write clean, tested code. " +
        "Use the filesystem voice to read/write files and GitHub to manage PRs.",
      voices: [new FilesystemVoice(), new GitHubVoice()],
      permissions: ["filesystem", "network"],
      role: "specialist",
      streaming: true,
    },
    pm: {
      name: "PM",
      system_prompt:
        "You are a product manager. Write specs, update documentation, " +
        "and create GitHub issues for tracking. Focus on clarity and completeness.",
      voices: [new FilesystemVoice(), new GitHubVoice()],
      permissions: ["filesystem", "network"],
      role: "specialist",
      streaming: true,
    },
    qa: {
      name: "QA",
      system_prompt:
        "You are a QA engineer. Test features in the browser, verify bugs, " +
        "and write test reports. Screenshot evidence for every finding.",
      voices: [new PlaywrightVoice()],
      permissions: ["network", "browser"],
      role: "specialist",
      budget: { max_cost_usd: 1.00 },
      streaming: true,
    }
  }
})
`,
};

export const TEMPLATES: Template[] = [minimal, codingAgent, researchAgent, qaPipeline, devTeam];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
