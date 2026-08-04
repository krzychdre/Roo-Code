# Code indexing fails with `Bad Request` — embedding dimension mismatch

Date: 2026-08-04
Branch: `fix/code-index-dimension-mismatch-diagnostics`

## Reported symptom

```text
Error - Failed during initial scan: Indexing failed: Failed to process batch after 3 attempts: Bad Request
```

The embedding server (`http://192.168.50.194:11111/v1`, llama-swap in front of llama.cpp)
was up and healthy, which made the message look like a server problem. It is not.

## Root cause — proven, not inferred

The user's live configuration (read from
`~/.config/Code/User/globalStorage/state.vscdb`, key `QUB-IT.tumble-code`):

| setting                               | value                                    |
| ------------------------------------- | ---------------------------------------- |
| `codebaseIndexEmbedderProvider`       | `openai-compatible`                      |
| `codebaseIndexEmbedderModelId`        | `granite-embedding-311m-multilingual-r2` |
| `codebaseIndexEmbedderModelDimension` | **1024**                                 |
| `codebaseIndexQdrantUrl`              | `http://192.168.50.194:6333`             |

Evidence collected against the real servers:

1. **The model emits 768 dimensions, not 1024.** A live `/v1/embeddings` call decoding the
   base64 payload gives `granite-embedding-311m-multilingual-r2 → dim=768`
   (`bge-m3 → dim=1024`, which is where the stale 1024 came from).
2. **The Qdrant collection was built at 1024.** `GET /collections/ws-502ffc5929916529`
   (sha256 of the workspace path, first 16 hex chars — `qdrant-client.ts:81-83`) reports
   `vectors.size = 1024`, `points_count = 1` (only the dummy point written during payload
   index creation — nothing was ever indexed).
3. **Qdrant rejects every upsert with HTTP 400.** Reproduced directly:

    ```text
    PUT /collections/ws-502ffc5929916529/points  (768-dim vector)
    → 400 {"status":{"error":"Wrong input: Vector dimension error: expected dim: 1024, got 768"}}
    ```

4. **The reason never reaches the user.** `@qdrant/js-client-rest` surfaces 4xx through
   `ApiError` from `@qdrant/openapi-typescript-fetch`, whose constructor is
   `super(response.statusText)` — so `error.message === "Bad Request"` and the informative
   body is parked on the discarded `error.data`. `scanner.ts:502-514` then formats
   `lastError.message` into `embeddings:scanner.failedToProcessBatchWithError`, producing
   the reported string verbatim.

Why Roo never caught it: `service-factory.createVectorStore()` resolves the vector size from
the _configured_ dimension, and `QdrantVectorStore.initialize()` only compares that configured
number against the collection (`1024 === 1024` → "correct", no recreation). Nothing ever
compares either value against what the model **actually** returns, even though
`validateConfiguration()` already performs a probe embedding whose length is right there.

## Fixes

### 1. Surface Qdrant's real error text (`qdrant-client.ts`)

`ApiError.data` holds the parsed Qdrant body (`{status: {error: "..."}}`). Add a
`describeQdrantError()` helper that pulls `status.error` (falling back to a compact JSON dump)
and appends it to the message, then route the catch blocks that rethrow — `upsertPoints`,
`search`, `deletePointsByFilePath`, `deletePointsByMultipleFilePaths`, `initialize`,
`clearCollection`, `_createPayloadIndexes` — through it.

After this, the same misconfiguration reports
`... Vector dimension error: expected dim: 1024, got 768` instead of `Bad Request`.

### 2. Detect the mismatch before the scan starts (`service-factory.ts` + embedders)

- Widen the embedder validation result to `EmbedderValidationResult { valid, error?, dimension? }`.
- Embedders that already probe with a test embedding report the observed vector length
  (`openai-compatible` covers the wrapping `gemini` / `mistral` / `vercel-ai-gateway`
  embedders too; `openai` and `ollama` report theirs as well).
- Extract the vector-size resolution in `service-factory` into `resolveVectorSize()`, reused by
  both `createVectorStore()` and `validateEmbedder()`.
- `validateEmbedder()` compares the observed dimension against the resolved one and fails with
  an actionable message naming both numbers and the setting to change.

This turns a failed scan into an up-front configuration error at the point where the user can
still act on it (`manager.ts:540`), and it fires for _any_ provider whose configured dimension
is wrong — the same trap catches anyone typing a manual dimension for a local model.

## Not a problem — the embedding server's batch size

While probing, llama.cpp turned out to reject any **single** input longer than its physical
batch: `HTTP 500 "input (5567 tokens) is too large to process. increase the physical batch size
(current batch size: 4096)"`. That looked like a second latent bug, because Roo caps items at
`MAX_ITEM_TOKENS = 8191` using a `length / 4` estimate while real code tokenises at ~2.9
chars/token on this model.

It is unreachable in practice. The parser splits every block at
`MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR = 1150` characters and breaks over-long single
lines at `MAX_BLOCK_CHARS` (`parser.ts:317`), so `MAX_ITEM_TOKENS` never comes into play.
Measured against 20 000 chunks scrolled out of the largest live code-index collection
(`ws-e9af27d99fe8af36`, 119 876 points): max 1150 chars, p99 1108, median 139, **zero** chunks
over 4000 chars — a largest single input of roughly 400 tokens, ten times under the 4096 batch.

All three embedding call sites (`scanner.ts:447`, `file-watcher.ts:570`,
`search-service.ts:46`) are fed either by those parser blocks or by a short search query, so
raising `--batch-size` / `--ubatch-size` buys nothing for this client.

## Verification

- `npx vitest run src/services/code-index/vector-store/__tests__/qdrant-client.spec.ts`
- `npx vitest run src/services/code-index/__tests__/service-factory.spec.ts`
- `npx vitest run src/services/code-index/embedders/__tests__/`
- New tests: `ApiError`-shaped failures surface the Qdrant reason; `validateEmbedder` rejects a
  768-dim probe against a 1024 configuration and accepts a matching one.

## User-side remediation (independent of the code fix)

Set **Embedding dimension** to `768` for `granite-embedding-311m-multilingual-r2` (or switch the
model back to `bge-m3`, which really is 1024). Roo then recreates `ws-502ffc5929916529` at the
right size on the next start.
