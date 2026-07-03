# Android App Viability Evaluation

**Question:** Is it viable to build an Android app on top of `@spacemolt/lib` —
or on top of Kotlin code generated from the same OpenAPI spec in the same
style — providing (a) a UI for all game data and actions manually, and (b) a
chat interface where Android's on-device AI APIs drive the game on request?

**Verdict: Yes — viable, and the strongly recommended path is to reuse
`@spacemolt/lib` as-is inside a React Native (or Capacitor) shell rather than
regenerating a Kotlin-native equivalent.** The library was deliberately built
on web-standard APIs only, which makes it Android-portable today with zero
changes to `src/`. A Kotlin regeneration gets the *types* nearly for free but
forces a hand-rewrite of the entire runtime layer (transport, correlation,
state caches, pacing, reconnect, Clerk auth) and commits the project to
maintaining two implementations against a server whose API surface changes
often enough that the lib is already at major version 3. The on-device AI half
is viable now on flagship devices via ML Kit's GenAI Prompt API (Gemini Nano),
with tool calling arriving through the AICore Developer Preview (Gemma 4 /
Nano 4) — but it needs a tool-retrieval design, because no on-device model
will accept all 267 commands as a single tool manifest.

---

## 1. What the app needs from the library

An Android client needs exactly what the lib already provides:

- **Runtime:** WS v2 connect/auth, request correlation, two-phase mutation
  flow, `rate_limited` pacing, close-code-aware reconnect + re-auth +
  resubscribe, multi-account management (`SpacemoltClient`).
- **State:** the 8-section `StateCache` (local reads, delta-patched),
  `MarketCache`/`ObservationCache`, `CatalogCache`/`MapCache` — this is what
  makes a mobile UI cheap to render: reads never hit the network.
- **Command surface:** `ACTIONS` (267 actions across 17 tools at spec
  v0.464.0) with per-param metadata and query/mutation classification, plus
  the typed `Commands` facade and `NotificationPayloads` for pushes.
- **Auth:** pluggable `CredentialStore`; Clerk API-key path for
  multi-account.

A runtime-API audit of `src/` (excluding `src/node.ts` and
`auth/file-store.ts`, which are already quarantined behind the `/node`
subpath) shows the only platform dependencies are **`WebSocket`, `fetch`,
`setTimeout`, and Promises** — no `structuredClone`, no `crypto`, no
`TextDecoder`, no Node built-ins. The `WebSocketFactory` seam
(`src/transport/socket.ts`) means even a nonstandard socket implementation
can be injected without touching the lib. `build:browser-check` and
`tests/browser-safe.test.ts` enforce this permanently.

## 2. Option A — reuse `@spacemolt/lib` (recommended)

### A1. React Native / Expo (recommended shape)

React Native's Hermes engine provides global `WebSocket` (W3C-shaped,
`addEventListener` included) and `fetch`, which is the lib's entire platform
contract. Expected result: **`import { SpacemoltClient } from
'@spacemolt/lib'` works unmodified.**

What actually has to be built:

| Piece | Effort | Notes |
|---|---|---|
| `AndroidCredentialStore` | Small | Implement the existing `CredentialStore` interface over Android Keystore (e.g. `react-native-keychain` / EncryptedSharedPreferences). The seam already exists; `FileCredentialStore` is the template. |
| Lifecycle-aware connection manager | Small–medium | Connect on foreground, let the socket die in background, reconnect on resume. The lib's reconnect + re-auth + resubscribe and the canonical `get_status` re-seed make "socket died while backgrounded" a solved problem — this is the single biggest reason the lib's architecture is a *good* fit for mobile, not just a tolerable one. |
| Manual UI | Medium–large | See §4 — largely generatable from `ACTIONS`. |
| ML Kit GenAI bridge | Small–medium | A thin Kotlin native module wrapping the Prompt API (generate/stream, availability check, feature download). See §5. |
| Optional foreground service | Small | Only if fleet-style always-on connections are wanted on mobile; not needed for a play-the-game client since mutations are tick-queued anyway. |

### A2. Capacitor / WebView

The lib is browser-safe by design, so a Capacitor app (any web framework in a
WebView + a small native plugin for ML Kit) also works with zero lib changes.
Choose this if the team is web-first and wants to share the UI with a future
web client. Trade-offs vs. RN: slightly less native look/feel and clunkier
background behavior; identical library story.

### Shared properties of Option A

- **Zero fork risk.** The app consumes the published package; spec syncs,
  semver majors, and `GENERATED_SPEC_VERSION` all keep working. When the
  server changes, `bun update` + `tsc` tells the app exactly what broke —
  the same typecheck-first loop `AGENTS.md` prescribes for agents.
- **All hard-won behavior is inherited:** rate-limit pacing, mutation
  serialization, connect batching, Clerk token minting, session-replaced
  handling. None of it is re-derived on Android.

## 3. Option B — Kotlin-native regeneration (not recommended now)

The tempting version: point a Kotlin generator at the same committed
`openapi.json`, emit a Kotlin `ACTIONS` catalog + typed command facade +
notification map in the style of `scripts/generate.ts`, and build a Jetpack
Compose app on it.

What the spec gives you ~free: schema types, the command catalog, the
notification payload map, query/mutation classification (`x-is-mutation`).
Porting `scripts/generate.ts` to emit Kotlin is a bounded, one-time job
(days).

What the spec **cannot** give you — the entire hand-written layer, which is
most of `src/` and nearly all of the accumulated correctness:

- transport lifecycle + frame parsing (`transport/socket.ts`)
- request_id correlation and the two-phase mutation flow (`correlator.ts`)
- auth sequencing quirks (post-`register` `logged_in` is an unsolicited push,
  sequenced by frame type, not request_id)
- the 8-section `StateCache` seed/delta semantics, and the subtlety that
  `logged_in` has a different shape and must *not* seed the cache
- market/observation subscription seeding and push merging
- `rate_limited` auto-retry incl. per-retry Clerk token re-mint
- close-code-aware reconnect policy (4001/4002 terminal vs. backoff)
- connect batching tuned to the server's per-IP caps
- Clerk multi-account (ws-token minting, `login_token` flow)

Every one of these encodes a server behavior discovered the hard way (see
`docs/gameserver-todo.md`). A Kotlin rewrite re-discovers them, then
**maintains them twice, forever**, against a server that changes fast — the
lib went 1.0.0 → 3.0.0 in weeks, and the whole sync/classify/release
pipeline (`sync-spec.yml`, `classify-bump.ts`, `release.yml`) would need a
second copy. The "self-maintaining" pillar becomes half-maintaining.

**When Option B becomes right:** if the app later needs deep platform
integration the JS runtime genuinely can't deliver — always-on background
fleet management in a foreground service with strict battery budgets, Wear OS
/ widgets sharing the runtime, or if RN itself is rejected. Even then, the
cheaper first step is Kotlin Multiplatform *UI* over the TS core via a local
bridge, or generating only the *catalog* in Kotlin for UI metadata while the
TS lib keeps owning the socket.

## 4. "All game data and actions manually" — a generated UI

This requirement sounds enormous (267 actions) but the lib's design makes it
mostly mechanical, because the same data that generates `COMMANDS.md` can
generate screens:

- **Generic action forms:** `ACTIONS` carries, per action: tool, name,
  description, params (name, type, required, enum values), and
  query/mutation kind. That is sufficient to render a form per action —
  enum → picker, boolean → switch, number/string → field, required →
  validation — grouped by tool exactly as `Commands` is. Query vs. mutation
  drives the UX: queries render results immediately; mutations show the
  two-phase "queued → next tick" state the lib already surfaces.
- **Typed dispatch for free:** the generic UI dispatches through
  `account.commands` / `send`, so pacing, mutation serialization, and state
  cache updates all apply. No per-action code.
- **Hand-crafted screens only for the hot paths:** map/navigation (backed by
  `MapCache`), market (`MarketCache` books), ship/cargo/status (the 8
  `StateCache` sections), chat/social, plus the account/fleet switcher over
  `SpacemoltClient`. Everything long-tail falls back to the generated forms.
- **Live data is push-fed:** `onStateChange`'s changed-section reporting maps
  directly onto UI invalidation (re-render only the screens bound to changed
  sections), and typed notifications drive toasts/feeds.

This is the same "self-maintaining" trick applied to UI: when the server
adds a command, the sync workflow updates `ACTIONS`, and the generic form
surface picks it up with no app release beyond a dependency bump.

## 5. The on-device AI chat interface

State of the platform (as of mid-2026):

- **ML Kit GenAI Prompt API** (Gemini Nano via the AICore system service) is
  the supported way to send custom prompts on-device; it supports text and
  image+text input with streaming output. It performs best on Pixel 10
  (nano-v3, Gemma 3n architecture); Nano runs on Pixel 8/8a/9-series and
  Galaxy S24+ class devices with model tiers varying by RAM/NPU.
- **Tool calling, structured output, system prompts, and thinking mode** are
  being added to the Prompt API surface through the **AICore Developer
  Preview** alongside the Gemma 4–based Gemini Nano 4 generation, which
  Google says ships on new flagships later in 2026.

So the chat feature is viable *now* on flagship devices, with the
important design constraint that **capability is tiered and gated by
device** — the app must treat on-device AI as progressive enhancement
(feature-detect via the Prompt API availability check; hide or degrade the
chat tab otherwise, or optionally fall back to a cloud model as a
user-opt-in).

Architecture that fits this codebase's idioms:

1. **Tool retrieval, not a tool dump.** No on-device model will take 267
   tool definitions in context. Mirror the pattern `AGENTS.md` prescribes
   for coding agents: the app ships the `ACTIONS` catalog as a *searchable
   index*, exposes the model 3 meta-tools — `search_commands(query)` (greps
   name/description, the in-app `COMMANDS.md`), `describe_command(tool,
   action)` (returns full param schema), and `execute(tool, action, params)`
   — plus a handful of always-loaded state readers (`get_status`, current
   system, cargo, credits from `StateCache`, which cost zero server calls).
   This keeps the prompt small enough for Nano-class context windows and is
   spec-drift-proof.
2. **Structured-output loop as the floor.** Until AICore tool calling is GA
   on the user's device, run a constrained loop: system prompt + state
   summary → model emits JSON `{action, params}` (Nano 4 structured output,
   or JSON-coaxing on Nano 2/3) → app validates against the `ActionDef`
   params (the generated metadata doubles as the validator) → **confirm
   mutations with the user in the chat UI** before dispatch → feed the
   typed result/delta back as the next observation. Query/mutation
   classification from the spec decides which calls need confirmation.
3. **The state cache is the context budget's best friend.** Because reads
   are local, the chat layer can compose a compact, fresh game-state summary
   for every turn without spending server round-trips or rate budget — this
   is a genuinely better fit for a small on-device model than a
   request-per-fact design would be.

Risks on this half: Nano-class models are markedly weaker than cloud models
at multi-step planning; expect the chat to be good at "sell all my iron at
the best price here" (one or two retrieved tools) and unreliable at long
autonomous plans. Scope the feature as *assistant that executes short
intents*, with the manual UI as the primary surface, and it lands well.

## 6. Android platform constraints worth naming

- **Doze/background kills sockets.** Fine for this game: mutations are
  tick-queued, and the lib's reconnect + `get_status` re-seed + resubscribe
  is exactly "resume on foreground". A foreground service is only needed for
  an always-on fleet-runner mode, which is optional and battery-expensive.
- **Multi-account on mobile:** `connectOwned` batching works unchanged, but
  a phone probably wants a small active-account set with lazy connects
  rather than a 100-socket fleet; that's app policy, not a lib change.
- **Push while closed:** the game has no FCM path; the app can't notify on
  in-game events while fully backgrounded. If that matters later it's a
  `gameserver-todo.md` item (server-side webhook/FCM bridge), not an app fix.

## 7. Recommendation and rough phasing

**Build React Native (Expo) + `@spacemolt/lib` unmodified**, with a small
Kotlin native module for ML Kit GenAI. Do not fork or regenerate the runtime
in Kotlin.

1. **Phase 1 — shell + auth + status (1–2 weeks):** Expo app, Keystore
   `CredentialStore`, Clerk key onboarding, connect one account, render
   `StateCache` sections, lifecycle reconnect.
2. **Phase 2 — generated action surface (1–2 weeks):** generic form renderer
   over `ACTIONS`, grouped by tool; two-phase mutation UX; typed
   notification feed.
3. **Phase 3 — hand-crafted hot screens (2–4 weeks):** map, market, ship,
   social, multi-account switcher.
4. **Phase 4 — AI chat (2–3 weeks):** Prompt API bridge + availability
   gating, tool-retrieval meta-tools, structured-output execute loop with
   mutation confirmation; adopt AICore native tool calling as it GAs.

Total to a credible v1: **~2 months of focused work**, most of it UI — the
entire protocol/state/auth layer is inherited. The Kotlin-native
alternative adds an estimated 2–3× to that before UI parity and a permanent
second maintenance track, for benefits (battery, background services,
Compose-native feel) the game's tick-based design mostly doesn't need.

## Sources

- [ML Kit GenAI APIs overview](https://developers.google.com/ml-kit/genai)
- [GenAI Prompt API (Gemini Nano)](https://developers.google.com/ml-kit/genai/prompt/android)
- [Gemini Nano | Android Developers](https://developer.android.com/ai/gemini-nano)
- [ML Kit Prompt API alpha announcement](https://android-developers.googleblog.com/2025/10/ml-kit-genai-prompt-api-alpha-release.html)
- [Gemma 4 / local agentic intelligence on Android](https://android-developers.googleblog.com/2026/04/gemma-4-new-standard-for-local-agentic-intelligence.html)
- [AICore Developer Preview (tool calling, structured output)](https://developers.google.com/ml-kit/genai/aicore-dev-preview)
- [Gemini Nano 4 preview coverage](https://9to5google.com/2026/04/02/gemini-nano-4-android/)
