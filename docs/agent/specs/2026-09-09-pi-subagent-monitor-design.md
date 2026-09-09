# pi-subagent-monitor design specification

**Status:** Approved design
**Date:** 2026-09-09
**Repository:** `/data/pi`
**Target package:** `extensions/pi-subagent-monitor`

## 1. Problem and purpose

Long-running Pi subagent reviews can continue for hours, especially when a
review/fix/re-review loop or a parallel workflow becomes stalled. The resulting
model usage is expensive and difficult to diagnose while it is happening.

`pi-subagent-monitor` is a standalone Pi extension that provides a
telemetry-only safety supervisor for `pi-subagents`. It exposes elapsed time,
remaining safety budget, activity, usage counters, warnings, and operator
controls. When explicitly enabled, it can stop an affected workflow after a
configured limit is reached. It is intended to prevent runaway work without
making model calls or changing the child’s prompt.

The extension complements the optional model-based watchdog already supplied by
`pi-subagents`. The model-based watchdog remains responsible for adversarial
correctness and scope review; this extension is responsible for time, activity,
usage, and control safety.

## 2. Approved decisions

- Use a standalone companion extension rather than modifying or forking
  `pi-subagents`.
- Integrate only through documented `pi-subagents` public APIs and capability
  detection.
- Automatically observe all `pi-subagents` work owned by the current Pi session.
- Cover foreground and detached background runs.
- Support interactive TUI and RPC modes in the first release.
- Treat a top-level run/workflow as the aggregate budget unit.
- A breach stops the complete known workflow tree, including active siblings and
  descendants, but never unrelated workflows.
- Use telemetry only; do not require child heartbeats, ETA reports, or model
  predictions.
- Display remaining safety budget, not a task-completion prediction.
- Start new installations in observe-only mode.
- Default every actual safety limit to `0`; `0` means disabled.
- Allow explicit per-run policies only where the documented public launch APIs
  support them.
- Per-run policies may tighten a non-zero global ceiling, but may not raise or
  remove it.
- Keep Pi open after all control failures; preserve an `unknown-control` state
  and retry documented controls with bounded backoff.
- Retain bounded metrics-only history without prompts, transcripts, or raw task
  text.

## 3. Scope and non-goals

### In scope

- Current-session discovery and reconciliation of foreground and background
  `pi-subagents` runs.
- Aggregate wall-clock, inactivity, token, reported-cost, tool-call, turn, and
  active-tool limits.
- Pause-aware execution timing.
- Pre-stop warnings and termination escalation.
- TUI footer status and notifications.
- RPC-compatible status and notifications.
- Operator commands for status, mode, history, and bounded active-policy
  extension.
- A validated launch wrapper for single children and common bounded
  review/chain/parallel shapes.
- Capability failures, unknown control results, and manual recovery guidance.
- Bounded local metrics history.

### Out of scope

- Changes to the `pi-subagents` package or its private internals.
- Replacing or configuring the `pi-subagents` model-based watchdog.
- Model-generated task ETAs or child prompt changes.
- Direct operating-system process killing.
- Supervising other Pi sessions, unrelated workflows, or arbitrary detached
  processes.
- Scraping terminal output or scanning private artifact directories.
- Persisting prompts, transcripts, full lifecycle event bodies, or arbitrary
  error text.
- A universal per-run policy field added to the existing `subagent` tool when
  the installed public API does not support it.

## 4. Compatibility and integration contract

The monitor uses the versioned in-process event-bus RPC documented by
`pi-subagents`:

- listen for `subagents:rpc:v1:ready`;
- send requests on `subagents:rpc:v1:request`;
- receive replies on the request-specific reply event;
- use `ping` to inspect protocol version and advertised capabilities;
- use `status` for current-session snapshots;
- use `interrupt` and `stop` for documented control;
- use advertised async-start, completion, child-status, and process-terminal
  events as wake-ups and diagnostics.

The monitor never assumes that an event alone proves current state. Status
snapshots are authoritative; event notifications only request an earlier
reconciliation. The monitor must ignore unknown fields and event types for
forward compatibility.

The monitor must compare the gateway’s reported session identity with the active
Pi session identity before accepting a snapshot or issuing control. Fleet
display keys are opaque and must not be interpreted as run IDs. A control target
must be resolved from an authoritative status response or a documented run
identity.

The current public API has an intentional boundary: detached composite launch is
available through RPC, while foreground structured delegation is limited to a
single leaf. The wrapper must reject unsupported combinations before launch
rather than importing private executors or silently falling back to another
execution mode. Ordinary direct `subagent` calls remain automatically covered by
the global policy even when they cannot carry a per-run override.

The monitor must not start background resources in its extension factory. It
starts its session timer, gateway listeners, and reconciliation state from
`session_start`, and releases them from `session_shutdown`. Background child
runtimes must not create a second active supervisor for the parent’s work; only
the session that owns the monitored runs may enforce its policy.

## 5. Architecture

### 5.1 Gateway adapter

`PiSubagentsGateway` owns the public RPC handshake, request IDs, bounded reply
validation, capability detection, and session-ownership checks. It exposes typed
operations for:

- `ping`;
- current-session `status`;
- `interrupt`;
- `stop`.

It reports explicit outcomes such as `available`, `unsupported`,
`session-mismatch`, `request-failed`, and `unknown`. It does not expose private
paths or raw RPC payloads to the rest of the extension.

### 5.2 Run registry

`RunRegistry` stores the latest bounded snapshot for each identifiable top-level
workflow:

- opaque run identity and parent/root lineage when advertised;
- current session identity;
- foreground/background mode;
- workflow state and active child count;
- start time and accumulated execution time;
- paused intervals;
- last meaningful activity and current tool when advertised;
- token, cost, tool, and turn counters;
- effective policy;
- warning, breach, termination, and retry state.

It replaces snapshots rather than merging arbitrary fields. If a workflow
identity or control target cannot be proven, it remains visible as an
unconfirmed observation and is never silently mapped to another run.

### 5.3 Policy engine

`PolicyEngine` validates configuration, calculates the effective policy, updates
clocks and counters, emits one warning per signal, and creates a single breach
decision for each workflow. It has no UI or process-control responsibilities.

### 5.4 Termination coordinator

`TerminationCoordinator` serializes controls for one workflow, includes children
discovered during the termination window, applies graceful-to-escalated
documented controls, verifies terminal state, and schedules bounded retries for
`unknown-control`. It never calls private APIs or performs an operating-system
kill.

### 5.5 Presentation layer

`Presentation` renders a compact footer status, emits severity-appropriate
notifications, exposes RPC-safe status data, and registers operator commands. It
must not render prompts, transcripts, private paths, or unbounded errors.

### 5.6 Metrics store

`MetricsStore` appends a bounded, redacted terminal record and prunes old
records. It stores metrics only and is independent of the Pi session transcript.

### 5.7 Launch wrapper

`LaunchWrapper` validates explicit policy metadata and delegates supported
launches through the public structured delegation or RPC surface. It does not
reimplement a child runner and does not accept arbitrary shell commands as a
launch mechanism.

## 6. Monitoring data flow

1. `session_start` initializes an empty registry and performs the public
   capability handshake.
2. If the gateway is available, the monitor subscribes to the events advertised
   by `ping`.
3. Event notifications request immediate reconciliation. A short local
   reconciliation timer runs at a bounded cadence (default: 1 second) so
   elapsed-time displays and deadlines do not depend on event traffic.
4. Reconciliation requests the current-session status snapshot. It updates
   foreground and background workflow records and removes records only after
   authoritative terminal state is observed.
5. The registry calculates execution time, paused intervals, activity freshness,
   usage counters, and remaining budget.
6. The policy engine emits threshold warnings and, in enforcement mode, creates
   one breach decision per workflow.
7. The termination coordinator performs documented controls and verification.
   Each state transition updates presentation and metrics.
8. `session_shutdown` cancels the reconciliation timer and retry timers,
   unregisters listeners, and records any unresolved workflow state without
   issuing late controls.

Status snapshots remain authoritative after reload or event loss. The monitor
must not judge liveness from the age of `status.json` alone because a
long-running tool may leave that file unchanged while the runner remains live.
Where advertised, activity fields and process-terminal proof are used as
evidence; missing evidence is reported as unknown.

### 6.1 Execution clock

The wall-clock budget is an execution clock. It starts when a workflow is first
observed as queued or running, accumulates across the workflow lifetime, pauses
while the workflow is paused, and resumes without resetting after a documented
resume. A resumed run with no provable public lineage is recorded as a new run
with a continuity warning rather than being silently merged.

### 6.2 Activity clock

Meaningful activity includes authoritative state changes, child or step
transitions, tool or turn counter changes, current-tool changes, and fresh
activity timestamps. A quiet active tool call does not by itself reset the
inactivity clock. It is protected separately by `activeToolMs` when configured.

## 7. Policy model

The user config is extension-owned:

`~/.pi/agent/extensions/pi-subagent-monitor/config.json`

The default policy is equivalent to:

```json
{
  "mode": "observe",
  "limits": {
    "wallClockMs": 0,
    "inactivityMs": 0,
    "tokenCount": 0,
    "costUsd": 0,
    "toolCalls": 0,
    "turns": 0,
    "activeToolMs": 0
  },
  "warningLeadMs": 60000,
  "terminationGraceMs": 15000,
  "pollIntervalMs": 1000,
  "retryBaseMs": 30000,
  "retryMaxMs": 300000,
  "historyMaxEntries": 200
}
```

The example values for warning, grace, polling, retry, and history are bounded
operational defaults. They do not enable automatic stopping. Every actual safety
limit defaults to `0`.

### 7.1 Validation

- `mode` is `observe` or `enforce`.
- Time, counter, and history values are finite non-negative integers within the
  implementation’s safe timer/storage bounds.
- A limit value of `0` is disabled.
- `warningLeadMs` and retry values may be `0` only where the corresponding
  behavior is intentionally disabled; `terminationGraceMs: 0` means immediate
  escalation.
- Invalid configuration is rejected visibly and never coerced into a different
  policy.
- In observe mode, policy evaluation and display continue, but the monitor never
  sends a control request.
- In enforce mode, a policy with all limits set to `0` remains operationally
  observe-only because no breach can occur.

### 7.2 Effective per-run policy

The wrapper may provide a `limits` object. A `0` in that object inherits the
global value. A positive override must not exceed a non-zero global ceiling. If
a global field is `0`, the wrapper may add a finite positive run-specific
ceiling. Per-run warning, grace, polling, retry, and history settings are not
supported in version 1; they use the session policy.

The active `/subagent-monitor extend` command may raise a stricter run policy
only up to the non-zero global ceiling and only after confirmation. It cannot
raise or disable a global limit. If no global ceiling exists for that signal, an
active extension cannot create an unbounded continuation; the command reports
that a new finite run policy is required.

### 7.3 Warning and breach rules

- Time signals warn once when the remaining budget is at or below
  `warningLeadMs`.
- Token, cost, tool, and turn signals warn once at 80% of their enabled cap.
- A hard breach is recorded once with the first triggering signal and a final
  bounded snapshot.
- Warnings and breach decisions are keyed by workflow identity and signal,
  preventing repeated notifications on every poll.
- Missing usage data cannot be treated as zero. A configured signal with no
  authoritative value is displayed as unknown and produces a visible integration
  warning; the monitor does not fabricate a stop decision from absent data.
- Token limits use pi-subagents-reported token totals. Cost limits use reported
  cumulative cost only. If cost is unavailable, the cost signal remains unknown
  and the token signal remains the authoritative spend proxy.

## 8. User-facing behavior

### 8.1 Footer status

The TUI footer uses `ctx.ui.setStatus` with a stable extension key. Its compact
text includes:

- monitored workflow count;
- nearest remaining safety cutoff;
- elapsed execution time;
- last activity or current tool when available;
- bounded token, cost, tool, and turn totals;
- `observe`, `enforce`, `degraded`, `terminating`, or `unknown-control` state.

It never includes raw task text or transcript content. When no workflow is
active, the status is cleared or reduced to the current monitor mode.

### 8.2 Notifications

The extension uses Pi notifications for:

- missing or incompatible gateway capabilities;
- threshold warnings;
- breach and control initiation;
- escalation and confirmed terminal state;
- unknown-control and retry state changes;
- configuration errors;
- manual action required.

Notifications are bounded and deduplicated. RPC mode receives the same status
and notification information through Pi’s RPC UI protocol. JSON/print modes are
not first-release targets; if loaded there, the extension must remain inert
rather than assuming a TUI exists.

### 8.3 Commands

The first release provides these commands:

- `/subagent-monitor status` — show active workflow metrics, effective limits,
  state, and documented manual controls.
- `/subagent-monitor observe` — switch the current session to observe mode.
- `/subagent-monitor enforce` — switch the current session to enforce mode after
  validating configuration.
- `/subagent-monitor history` — show bounded metrics-only history.
- `/subagent-monitor extend` — confirm and raise a stricter active policy only
  within the global ceiling.
- `/subagent-monitor run` — invoke the explicit monitored launch wrapper.

Changing mode through a command affects the current session. Persistent defaults
remain in the extension-owned config file.

## 9. Termination and recovery

### 9.1 Normal breach

When an enabled limit breaches in enforcement mode:

1. The workflow enters `terminating` and records the triggering signal.
2. The coordinator sends the documented graceful control appropriate to the
   workflow and run mode.
3. It reconciles during `terminationGraceMs`, repeatedly including newly visible
   members of the same workflow tree.
4. If the workflow remains active, it sends the strongest documented control
   available for the target. Foreground targets may only support interrupt
   semantics; detached targets may support run or child stop semantics.
5. It verifies terminal state through status and advertised process-terminal
   evidence. A request acknowledgement alone is not proof.
6. If proof is obtained, the workflow is recorded as `stopped-by-monitor` with
   the trigger and control outcome.
7. If proof is not obtained, the workflow enters `unknown-control` and follows
   the retry behavior below.

The coordinator never aborts or shuts down the Pi parent. It never uses private
process handles or direct operating-system signals.

### 9.2 Unknown control

After a failed or unconfirmed control sequence:

- keep Pi open;
- retain a persistent critical status;
- show the last known state and documented manual control command;
- retry known-run controls with bounded backoff (`retryBaseMs` through
  `retryMaxMs`);
- reconcile before and after every retry so new descendants are included;
- suppress duplicate notices unless the retry phase, state, or unresolved
  identity changes;
- stop retrying when the workflow becomes terminal, enforcement is switched off,
  or the session shuts down;
- write a metrics-only record containing the unresolved outcome.

If the gateway is unavailable in enforcement mode, the monitor enters
`degraded`, shows that it cannot prove supervision, and remains open. It does
not claim that work stopped and does not silently switch to a private or
external execution path.

### 9.3 Manual recovery

The status output must include the exact documented `pi-subagents` status and
control forms needed for a human to inspect or stop an unresolved run. The
monitor does not hide or erase unresolved work when the Pi session is reloaded
or closed.

## 10. History and privacy

History is stored in a dedicated user-owned metrics file under the extension’s
user configuration directory. The store is bounded by `historyMaxEntries` and
uses restrictive file permissions where supported.

A record may contain:

- schema version and terminal timestamp;
- opaque run identity when necessary for correlation;
- agent and mode names from validated metadata;
- workflow child count;
- execution duration;
- configured signals and the first triggering signal;
- token, reported cost, tool, and turn totals;
- warning, control, retry, and final state outcomes.

A record must not contain task text, goals, prompts, transcripts,
working-directory paths, session-file paths, artifact paths, credentials, raw
provider responses, or unbounded error bodies. Labels are accepted only when
they are bounded and part of validated metadata; raw task descriptions are never
used as labels.

## 11. Explicit launch wrapper

The wrapper is an additional command/tool, not an override of the existing
`subagent` tool. It accepts a bounded launch description with:

- launch kind: single, parallel review, sequential review loop,
  implement-then-review, or generic bounded chain/parallel;
- validated agent/workflow inputs;
- task text needed for the launch;
- optional stricter `limits` metadata.

Task text is passed only to the documented pi-subagents launch contract and is
not written to monitor history. Numeric policies are validated before any child
starts. The wrapper does not accept arbitrary shell commands, private paths, raw
process IDs, or unsupported management actions.

The implementation selects the documented public launch seam:

- foreground single-child work uses structured delegation;
- detached single and composite work uses the public RPC spawn path;
- unsupported foreground composite overrides are rejected before launch and
  remain covered by the global observer when launched directly through
  pi-subagents.

The wrapper result includes the effective policy and bounded run identity needed
by the monitor. It does not expose private artifact contents or claim that a
child’s result is correct.

## 12. Testing strategy

### Unit tests

Use deterministic clocks and fake snapshots to cover:

- config validation and zero-disabled semantics;
- observe versus enforce mode;
- tighten-only policy merging;
- warning lead time and 80% counter thresholds;
- paused execution clock and resume continuity;
- activity classification and quiet-tool handling;
- token-authoritative and cost-unknown behavior;
- warning/breach deduplication;
- retry backoff and terminal retry cancellation;
- workflow-tree aggregation and current-session filtering.

### Integration tests

Use a fake event bus and public gateway to simulate:

- capability handshake and protocol/version failures;
- foreground fleet and detached async snapshots;
- event loss followed by authoritative reconciliation;
- queued, running, paused, resumed, completed, stopped, and unknown states;
- a child appearing during the termination grace period;
- graceful control, escalation, and repeated bounded retries;
- reload and session-shutdown cleanup;
- unrelated workflows remaining untouched;
- wrapper launches for every supported kind and rejection of unsupported
  combinations.

### Presentation tests

Verify compact TUI status content, notification severity and deduplication,
RPC-safe output, bounded history fields, and absence of task/transcript data.
Perform one manual smoke test in an actual Pi TUI session and one RPC-mode smoke
test.

## 13. Acceptance criteria

The implementation satisfies this design when:

1. A fresh installation is observe-only and all actual safety limits are `0`.
2. Explicit enforcement evaluates aggregate workflow policy across foreground
   and background runs.
3. A breach targets the complete affected workflow tree and leaves unrelated
   workflows alone.
4. Paused time does not consume the wall-clock execution budget.
5. Telemetry, not a model or child heartbeat, determines progress.
6. Remaining safety budget is displayed without presenting a task-completion
   prediction.
7. Pi remains open after every control failure or unknown-control state.
8. The monitor retries documented controls with bounded backoff and never claims
   a stop without authoritative evidence.
9. Token and reported-cost behavior follows the unknown-data rules above.
10. Per-run overrides cannot relax a non-zero global ceiling; `0` in an override
    inherits.
11. No private pi-subagents imports, terminal scraping, direct process kills,
    prompt edits, or transcript persistence are needed.
12. Unsupported APIs and launch shapes fail visibly and do not trigger an
    unapproved execution-mode fallback.
13. History contains only bounded metrics and no prompts, transcripts, paths, or
    credentials.
14. Unit, integration, presentation, and manual smoke tests cover the stated
    behavior.

## 14. References used during design

- Pi extension API documentation:
  `/config/home/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `pi-subagents` public repository: <https://github.com/nicobailon/pi-subagents>
- `pi-subagents` public documentation sections consulted: extension API,
  observability, watchdog, configuration, tool reference, and workflows.
- Installed package inspected during design: `pi-subagents` 0.66.0.
