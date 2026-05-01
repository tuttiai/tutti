# @tuttiai/router

## 0.1.0

### Minor Changes

- Initial release — `@tuttiai/router` v0.1.0 ships the smart-routing surface used by Tutti's v0.23.0 release:
  - Public types: `Classifier`, `ClassifierContext`, `ClassifierStrategy`, `ModelTier`, `RoutingDecision`, `RoutingPolicy`, `SmartProviderConfig`, `Tier`.
  - `HeuristicClassifier` — zero-cost rule-based classifier with destructive-tool awareness baked in.
  - `LLMClassifier` — asks a small/cheap LLM to label task difficulty per turn.
  - `SmartProvider` — `LLMProvider` implementation that wraps several configured tiers and dispatches each call to the classifier's chosen tier; supports `previewDecision`, `getLastDecision`, per-call `force_tier` overrides, and a fallback chain that emits `on_decision` / `on_fallback` events.
