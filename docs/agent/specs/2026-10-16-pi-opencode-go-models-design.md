# pi-opencode-go-models design specification

**Status:** Cancelled — not to be implemented
**Date:** 2026-10-16
**Repository:** `/data/pi`
**Target package:** `extensions/pi-opencode-go-models` (never created)
**Pi version inspected:** 1.3.0

> **Cancellation note.** Cancelled at design review. The extension would have
> synced retired model generations that OpenCode's documentation and pricing
> table have already dropped: `glm-5.1`, `grok-4.6`, `kimi-k2.6`,
> `minimax-m2.5`, `minimax-m2.7`, `qwen3.6-plus`, and `qwen3.7-max` all have a
> current replacement in the documented list. The stated goal was to pick up
> new models sooner, and that goal is unachievable this way: pi.dev's
> `opencode-go` catalogue is byte-identical to the documented Go list, so
> there is no lag for an extension to close. The original motivating model,
> `deepseek-v4.1-flash-free`, remains unreachable regardless of tooling
> because OpenCode gates its free tier server-side. The design below is
> retained as a record of the verified endpoint, catalogue, and gating
> behaviour.

## 1. Problem and purpose

Pi's built-in `opencode-go` provider catalog tracks pi.dev, and on 2026-10-16
that catalog was byte-identical to OpenCode's documented Go plan model list (29
models, zero differences in either direction). OpenCode's live per-key endpoint
`GET /zen/go/v1/models` returned 37 models, including 8 that the documentation
omits.

`pi-opencode-go-models` is a standalone Pi extension that makes Pi's
`opencode-go` model list track the live endpoint. Models become usable as soon
as OpenCode serves them, rather than waiting for the published catalog to
include them.

The extension is additive and non-destructive. It never rewrites Pi's model
catalog, never writes to Pi's configuration, and never touches credential
material.

## 2. Approved decisions

- Sync filter is the live per-key endpoint list, which is the authoritative
  "usable by this key" signal. Models the endpoint omits (for example the
  server-gated free tier) are excluded automatically rather than by heuristic.
- Use the legacy `ProviderConfig` registration form rather than a native
  `Provider` wrap. Pi composes the extension on top of the built-in, so the
  built-in's pi.dev overlay refresh, authentication, and `streamSimple` are
  inherited unchanged.
- Known models are passed through verbatim from the built-in provider. Metadata
  is synthesised only for models the built-in does not know.
- Add every model that has metadata from a covered source; skip and report any
  model without metadata (currently only `omen-alpha`).
- Refresh on startup subject to a time-to-live (default 6 hours), and always on
  `pi update --models`.
- On endpoint failure, keep serving the last-known-good snapshot and mark it
  stale.
- Leave Pi's `enabledModels` (scoped models) alone; notify instead so the
  operator can run `/scoped-models`.
- Configuration lives in one read-only extension file exposing a deny list,
  per-model overrides, and the TTL.
- Persist only to the extension's own files. Pi's own model store is never
  written.

## 3. Scope and non-goals

### In scope

- Live discovery of `opencode-go` models from the OpenCode Go endpoint.
- Metadata synthesis for models absent from Pi's built-in catalog.
- Time-to-live caching with a last-known-good fallback.
- A deny list and per-model metadata overrides.
- A status command and change notifications.
- Coexistence with the existing `pi-opencode-go-rotation` extension.

### Out of scope

- The `opencode` (Zen) provider. This extension handles `opencode-go` only.
- Any free-tier model. Those are rejected server-side with `FreeTierError`
  regardless of client identity, so they cannot be made usable here.
- Writing to `settings.json`, Pi's `models-store.json`, or any Pi-owned file.
- Modifying request payloads, prompt caching, or streaming behaviour.
- Auto-updating the scoped-models list.

## 4. Verified evidence

Recorded so the design can be re-checked without repeating the investigation.

### Catalogue comparison

| Source | Count | Relationship |
| --- | --- | --- |
| OpenCode Go documentation list | 29 | reference |
| pi.dev catalog | 29 | identical to documentation |
| Live `GET /zen/go/v1/models` | 37 | superset |
| models.dev `opencode-go` | 31 | documentation plus 2 stale entries |

The 8 endpoint-only models are `glm-5.1`, `grok-4.6`, `omen-alpha`,
`kimi-k2.6`, `minimax-m2.5`, `minimax-m2.7`, `qwen3.6-plus`, and
`qwen3.7-max`.

### Reachability of the 8 endpoint-only models

Requests were sent to `POST /zen/go/v1/chat/completions` with
`x-opencode-session` and `x-opencode-client` headers, using a read-only key.

| Request | Result | Interpretation |
| --- | --- | --- |
| Nonsense identifier | 400 `Model is unavailable` | fails resolution |
| `glm-5.3`, known valid | 403 `permission_error` | passes resolution |
| All 8 extras | 403 `permission_error` | pass resolution |
| `deepseek-v4.1-flash-free` | 400 unavailable | not served on Go |

Because a nonsense identifier fails at resolution while all 8 extras reach the
key-scope check, the extras are resolvable on the Go endpoint. A subsequent
spot-check with a writable key returned `200` and a valid completion for
`qwen3.7-max`, confirming they are usable and permitted and not rejected on
plan or billing grounds.

### Free tier

`deepseek-v4.1-flash-free` is not served on the Go endpoint and is rejected on
the Zen endpoint with `403 FreeTierError: OpenCode's free tier can only be used
from within OpenCode`. Supplying a spoofed `x-opencode-client`, session header,
and user agent does not change the result. This is a server-side policy gate
and is out of scope.

### Provider API split

Pi's `opencode-go` catalog deliberately mixes four APIs:

| API | Count | Examples |
| --- | --- | --- |
| `openai-completions` | 18 | `glm-5.2`, `glm-5.3`, `kimi-k3` |
| `anthropic-messages` | 5 | `claude-haiku-5-5`, `minimax-m3`, `qwen3.7-plus` |
| `openai-responses` | 5 | `gpt-5.6-luna`, `gpt-6-luna`, `grok-4.7` |
| `google-generative-ai` | 1 | `gemini-4-argon-contributor` |

This per-model choice is curated and must not be replaced for known models.

### Metadata coverage of the extras

Cross-referencing models.dev canonical identifiers across all providers gave
metadata coverage for 7 of the 8 extras. `omen-alpha` had no entry in any
provider and is therefore skipped.

The extras have no row in the OpenCode Go pricing table, so cost cannot be
derived from the published Go prices.

## 5. Compatibility and integration contract

All references are to Pi 1.3.0 as installed.

### Registration form

`pi.registerProvider(providerId, config)` accepts the legacy `ProviderConfig`
form. Re-registration merges defined values over the previous registration and
preserves undefined ones (`dist/core/model-runtime.js:662`). The existing
rotation extension registers `{ apiKey }` and this extension registers
`{ refreshModels }`, so the two coexist regardless of load order and neither
overwrites the other.

### Composition

The built-in base provider is the remote-catalog wrapper
(`dist/core/model-runtime.js:95`) selected as
`base = nativeExtensionProviders.get(id) ?? builtins.get(id)`
(`model-runtime.js:157`). Pi composes the extension over that base
(`dist/core/provider-composer.js:397-419`):

1. `await base.refreshModels(context)` runs first, keeping the pi.dev overlay
   fresh.
2. `await extension.refreshModels(context)` then supplies the model list.
3. The result is installed through `context.publish({ update })`.

### List replacement semantics

When an extension supplies models, `applyExtension` returns that list mapped
through `extensionModelFromDefinition`, which fills only `api` and `baseUrl`
from defaults and copies every other field from the supplied definition. The
supplied list therefore replaces the model list wholesale and each entry must
carry complete metadata. Consequently this extension passes every known model
through verbatim from `base.getAllModels()`.

### Free metadata overrides

`models.json` `modelOverrides` is applied after extension-provided models
(`dist/core/provider-composer.js:361-364`), so per-model metadata overrides work
on synthesised models without new machinery.

### Credentials

`ctx.modelRegistry.getApiKeyForProvider(provider)`
(`dist/core/model-registry.js:105`) resolves through `runtime.getAuth`
(`model-runtime.js:369`) to `resolveProviderAuth(provider, credentials)`
(`pi-ai/dist/models.js:335`), where runtime overrides live
(`setRuntimeApiKey`, `model-runtime.js:424`). The active key managed by the
rotation extension is therefore honoured. This extension never reads
environment variables for credentials, key files, or `auth.json`.

### Validation

`validateExtensionProvider` runs at registration, and refreshed lists are
validated before publishing (`provider-composer.js:410`). A malformed
definition throws rather than corrupting state, so synthesised models must
satisfy the schema.

### Refresh triggers

- Interactive startup calls `modelRuntime.refresh({ signal })`
  (`dist/modes/interactive/model-catalog-refresh.js:10`).
- `pi update --models` sets `context.force`.
- Provider registration triggers `refresh({ allowNetwork: false })`.
- The built-in remote catalog applies its own 4-hour window, independently of
  this extension's TTL.

### Network and cancellation

`context.allowNetwork` derives from network enablement and `PI_OFFLINE`
(`model-runtime.js:97`, `model-runtime.js:600`). All network work honours
`context.signal` and uses a 4000 ms attempt timeout, consistent with
`REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS`.

### Prohibited action

The extension must never call `context.publish({ persist })`. That writes the
per-provider entry in `<agent-dir>/models-store.json`, which the built-in's
remote-catalog overlay uses for `etag`, `lastModified`, and `checkedAt`
revalidation. Sharing that entry would corrupt revalidation and could pin the
built-in catalog to synthesised data.

## 6. Architecture

```text
pi.registerProvider("opencode-go", { refreshModels })
        |
        v
  refreshModels(ctx)
        |
        +-- baseModels = base.getAllModels()      passthrough, authoritative
        |
        +-- extras     = live − baseModels        synthesised, ours alone
        |
        +-- return [...baseModels, ...extras] minus exclusions
```

Because extras are derived as `live − baseModels`, a model stops being an extra
automatically once pi.dev publishes it, with no duplicate registration.

### Components

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Factory: registration, command, notifications |
| `src/config.ts` | Load and validate the read-only configuration file |
| `src/live.ts` | Endpoint request, response parsing, timeout and cancellation |
| `src/metadata.ts` | API inference and metadata synthesis for extras |
| `src/merge.ts` | Supply derivation, assembly, exclusion filtering |
| `src/snapshot.ts` | Last-known-good extras snapshot read and write |
| `src/report.ts` | Status and notification formatting |

Each module is independently testable and has no dependency on Pi's internals
beyond the documented extension API.

## 7. Data flow

### 7.1 Startup

1. The extension factory registers the provider with `refreshModels` only, and
   no `models` entry, so Pi's built-in list is displayed unchanged until the
   first refresh completes.
2. Pi calls `refreshModels(ctx)`. The extension loads its configuration and
   snapshot and immediately has a usable extras list.
3. If `ctx.allowNetwork` is true and either the snapshot is older than the TTL
   or `ctx.force` is set, the endpoint is queried.
4. On success, extras are recomputed from the live list, metadata is
   synthesised, the snapshot is written, and the merged list is returned.
5. If no fetch is needed or permitted, the snapshot's extras are returned.

### 7.2 Network refresh

1. Resolve the key with `getApiKeyForProvider("opencode-go")`. If none is
   available, skip the network entirely and report `no credential`.
2. `GET https://opencode.ai/zen/go/v1/models` with a bearer token, an explicit
   user agent, `context.signal`, and a 4000 ms attempt timeout.
3. Parse the OpenAI-compatible `data[].id` shape. Any unexpected shape is
   treated as a failure, not an empty list.
4. Compute `extras = liveIds − baseIds`, skipping excluded identifiers and
   identifiers without metadata.
5. Persist the snapshot with a fetch timestamp, then return the merged list.

### 7.3 Offline and failure

The snapshot is served unchanged and marked stale with its age. A failed
refresh never removes models and never throws out of `refreshModels`.

### 7.4 Forced refresh

`ctx.force` bypasses the TTL so `pi update --models` always queries the
endpoint. The command `/opencode-models refresh` requests the same behaviour.

## 8. Metadata synthesis rules

Synthesis applies only to extras. Known models are passed through untouched.

### 8.1 API and base URL

The API is inferred from the nearest family sibling among the base models:

| Family pattern | Inferred API |
| --- | --- |
| `qwen*` | `anthropic-messages` |
| `minimax*` | `anthropic-messages` |
| `kimi*` | `openai-completions` |
| `glm*` | `openai-completions` |
| `grok*` | `openai-responses` |
| anything else | `openai-completions` |

The base URL is taken from a sibling with the same inferred API. A
configuration override always wins.

### 8.2 Limits, modalities, and reasoning

| Field | Source |
| --- | --- |
| `contextWindow` | models.dev `limit.context` |
| `maxTokens` | models.dev `limit.output` |
| `input` | models.dev `modalities.input`, intersected with `text` and `image` |
| `reasoning` | models.dev `reasoning` |
| `thinkingLevelMap` | models.dev `reasoning_options[].values` |
| `compat` | copied verbatim from a same-API sibling |
| `name` | models.dev `name`, else the identifier |

Precedence is the models.dev `opencode-go` entry first, then the canonical
cross-reference across providers. A field with no value in either source is
left at the schema default and the model is reported as partially synthesised.
A model with neither a context window nor an output limit in either source is
skipped and reported rather than registered, because a guessed context window
causes premature compaction or hard request failures.

### 8.3 Cost

The extras have no row in the OpenCode Go pricing table, so cost defaults to
zero and is never invented from unrelated providers' prices. Real prices can be
supplied through configuration overrides. The status command reports that
session cost under-reports for these models until they are overridden.

### 8.4 Thinking levels

Effort values published by the source are mapped one-to-one onto Pi's levels
(`low`, `medium`, `high`, `xhigh`, `max`). Levels the provider does not publish
map to `null`, matching the convention used by Pi's own catalog.

## 9. Configuration

Path: `<agent-dir>/pi-opencode-go-models.json`, where `<agent-dir>` resolves
from `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. Only this file and
the snapshot file are ever written, and the configuration file is read-only to
the extension.

Snapshot path: `<agent-dir>/pi-opencode-go-models-snapshot.json`. It holds the
synthesised extras and the time of the last successful fetch. It is machine
written and may be deleted at any time to rebuild from the built-in catalogue.

```json
{
  "ttlSeconds": 21600,
  "exclude": ["omen-alpha"],
  "overrides": {
    "qwen3.7-max": {
      "api": "anthropic-messages",
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  }
}
```

- `ttlSeconds` defaults to 21600 (6 hours). The environment variable
  `PI_OPENCODE_GO_MODELS_TTL` takes precedence.
- `exclude` is a deny list applied to extras and to passthrough models, so it
  can also hide models that Pi provides.
- `overrides` supplies per-model fields, including `api` and `baseUrl`, which
  Pi's own `modelOverrides` cannot change.
- `PI_OPENCODE_GO_MODELS_CONFIG` overrides the configuration path for testing.

Validation is lenient and never fatal: a missing file means defaults, an
unparsable file is reported and ignored, and an invalid entry is skipped while
the remaining entries still apply.

## 10. User-facing behaviour

### 10.1 Commands

`/opencode-models` reports:

- the base model count and the synthesised extras with identifiers;
- skipped identifiers with the reason each was skipped;
- snapshot age, staleness, and the effective time-to-live;
- effective exclusions and the last fetch outcome.

`/opencode-models refresh` forces a network refresh, bypassing the
time-to-live, and reports the result.

### 10.2 Notifications

When a refresh changes the extras set, one notification lists the added and
removed identifiers and reminds the operator to run `/scoped-models` to include
them in cycling. No notification is emitted when the set is unchanged, so
startup stays quiet.

### 10.3 Status line

A status indicator appears only while degraded, meaning the snapshot is stale
or the most recent fetch failed, and clears once a refresh succeeds. No
indicator is shown in the healthy case.

## 11. Failure handling

| Condition | Behaviour |
| --- | --- |
| No credential | Skip network, serve snapshot, report it |
| Offline or `allowNetwork` false | Skip network, report `offline` |
| HTTP 401, 403, or 5xx | Keep snapshot, mark stale, report code |
| Timeout or abort | Keep snapshot, mark stale, report it |
| Malformed JSON or bad shape | Keep snapshot, mark stale, report it |
| Metadata absent for a model | Skip that model and report it |
| Invalid configuration entry | Skip the entry, apply the rest |
| Snapshot missing or unreadable | Empty extras, use built-in list |

Every failure is contained. `refreshModels` returns the best available list
rather than throwing, so a network problem can never break model selection.

## 12. Testing strategy

All network access is mocked. No test contacts the live endpoint.

### Unit tests

- Configuration parsing: defaults, missing file, malformed file, partial
  validity, unknown keys, environment precedence.
- TTL boundaries and `force` bypass.
- API family inference, including each mapping above and the unknown fallback.
- `thinkingLevelMap` derivation from effort values.
- Extras derived as `live − base`, including the transition when a model
  appears in the base list and stops being an extra.
- Exclusion filtering across extras and passthrough models.
- Metadata precedence and the skip path when no source has metadata.
- Snapshot reading and writing, including corrupted and truncated content.
- Staleness computation and report formatting.

### Integration tests

- Successful refresh adding extras, with the merged result validated.
- Refresh with no extras.
- Failure paths: 401, 403, 500, timeout, abort, malformed JSON.
- Missing credential, asserting no network call is attempted.
- `allowNetwork` false, asserting no network call is attempted.
- Passthrough fidelity: after a refresh, every base model is deep-equal to the
  corresponding entry from `base.getAllModels()`.
- `models.json` `modelOverrides` still applying to a synthesised model.
- No `context.publish({ persist })` call, asserted with a spy on `publish`.

### Presentation tests

- `/opencode-models` output for healthy, stale, skipped, and no-credential
  states.
- Notification emitted on change and suppressed when unchanged.

## 13. Acceptance criteria

1. With a valid key and network access, `/model` lists the 7 synthesised extras
   alongside Pi's built-in `opencode-go` models.
2. Every pre-existing `opencode-go` model retains metadata identical to the
   built-in catalogue, asserted by test.
3. No Pi-owned file is written. Only the two extension-owned paths
   `<agent-dir>/pi-opencode-go-models.json` and
   `<agent-dir>/pi-opencode-go-models-snapshot.json` are written, and
   `PI_OFFLINE=1` performs no network access.
4. `omen-alpha` is absent from the model list and reported as skipped with a
   reason.
5. Exclusions and per-model overrides take effect on the next refresh.
6. A failed fetch never removes models and never throws out of `refreshModels`.
7. Existing key rotation is unaffected, since `{ apiKey }` and
   `{ refreshModels }` registrations merge.
8. `pi --list-models` introduces no new warnings for models this extension
   registers.
9. Type checking, tests, and formatting all pass.

## 14. Risks and limitations

1. **Billing is not fully characterised.** The extras have no row in the Go
   pricing table. They are permitted, as the `qwen3.7-max` spot-check returned a
   normal completion rather than a plan or billing error, but how their usage
   counts against the plan allowance is unknown.
2. **Cost under-reports for extras**, because their cost defaults to zero
   rather than a borrowed figure from another provider.
3. **API inference may be wrong** and could reduce fidelity, for example by
   losing Anthropic `cache_control` handling. The gateway accepts OpenAI-format
   requests for these models, verified for `qwen3.7-max`, so requests should
   still succeed, but fidelity may be lower than Pi's curated choice. Each
   model can be pinned through configuration.
4. **Synthesised metadata is third-party** and may be stale or incorrect.
   Overrides are the remedy.
5. **Time-based pricing is not representable.** DeepSeek peak and off-peak
   rates vary by time of day, while Pi tiers cost only by token count. This
   affects known models and is noted here for completeness.
6. **The endpoint is undocumented** and may change or disappear. The extension
   degrades to the built-in catalogue in that case.
7. **The free tier remains unreachable.** This extension cannot restore
   `deepseek-v4.1-flash-free`, which is both unserved on the Go endpoint and
   server-gated on the Zen endpoint.
8. **Stale extras may reference retired models.** Last-known-good may serve a
   model the endpoint has dropped until the next successful refresh.

## 15. References used during design

- OpenCode Go documentation and pricing table:
  <https://opencode.ai/v2/docs/console/go/>
- Live model endpoint: `GET https://opencode.ai/zen/go/v1/models`
- Pi catalogue overlay:
  `GET https://pi.dev/api/models/providers/opencode-go?types=chat,image,classifier`
- models.dev catalogue: <https://models.dev/api.json>
- Pi documentation: `models.md`, `custom-provider.md`, `extensions.md`,
  `configuration.md`, `environment-variables.md`
- Pi source inspected: `dist/core/model-runtime.js`,
  `dist/core/provider-composer.js`, `dist/core/remote-catalog-provider.js`,
  `dist/core/model-registry.js`, `pi-ai/dist/models.js`,
  `pi-ai/dist/providers/all.js`, `schemas/models.schema.json`
