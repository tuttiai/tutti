# @tuttiai/types

## 0.11.2

### Patch Changes

- Add `RealtimeAgentConfig` type and `AgentConfig.realtime?: RealtimeAgentConfig | false` field. Mirrors `@tuttiai/realtime`'s `RealtimeConfig` shape so `@tuttiai/types` keeps its zero-runtime-dep invariant (same pattern as `DeployConfig`).

## 0.11.1

### Patch Changes

- Add DeployConfig and DeployTarget types; AgentConfig gains optional deploy field
