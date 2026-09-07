# @tuttiai/rag

## 0.1.1

### Patch Changes

- ca85ec9: Make `allow_private` settable on the local embeddings provider.

  `LocalEmbeddingProvider` accepted `allow_private` in its constructor and the README documented it, but it was not a field on `LocalEmbeddingConfig` and `createEmbeddingProvider` forwards the config as typed, so no caller going through `RagConfig` could set it. Because `assertSafeUrl` refuses loopback and every private range, `provider: "local"` was unusable for the only thing it exists for: an Ollama-compatible server on the machine.

  `allow_private?: boolean` is now declared on `LocalEmbeddingConfig`. The opt-out is also narrower: `assertSafeUrl` now takes the flag and always validates the scheme, relaxing only the host checks, so a `file:` URL is refused either way. The default still refuses loopback.
