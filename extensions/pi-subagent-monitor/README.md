# pi-subagent-monitor

`pi-subagent-monitor` is a telemetry-only safety supervisor for documented
`pi-subagents` workflows. It helps contain runaway review/fix/re-review loops
with elapsed-time, inactivity, usage, warning, and operator-control telemetry.
It does not change child prompts or make model calls.

## Install

```bash
pi install npm:pi-subagent-monitor
```

A fresh installation is observe-only. Every actual safety limit defaults to
`0`, which means disabled; observation and status reporting do not stop work.

## Configuration

The extension-owned configuration file is:

`~/.pi/agent/extensions/pi-subagent-monitor/config.json`

For example:

```json
{
  "mode": "enforce",
  "limits": {
    "wallClockMs": 3600000,
    "inactivityMs": 600000,
    "tokenCount": 200000,
    "costUsd": 0,
    "toolCalls": 0,
    "turns": 0,
    "activeToolMs": 900000
  },
  "warningLeadMs": 60000,
  "terminationGraceMs": 15000
}
```

`0` disables an actual limit. Wall-clock time is an execution clock, so paused
time does not consume it. Token totals use the totals reported by
`pi-subagents`. Reported cumulative cost is used when available; missing cost
remains unknown rather than being treated as zero.

## Commands

- `/subagent-monitor status` shows active workflow counts, remaining safety
  budget, elapsed execution time, usage counters, and control state.
- `/subagent-monitor observe` switches the current session to observe mode.
- `/subagent-monitor enforce` switches the current session to enforce mode.
- `/subagent-monitor history` shows bounded metrics-only history.
- `/subagent-monitor extend {"runId":"...","limits":{"turns":10}}`
  requests confirmation before raising a stricter active policy within the
  configured global ceilings.
- `/subagent-monitor run` accepts one bounded JSON launch object, such as:

  ```json
  { "kind": "single", "agent": "reviewer", "task": "Review the current diff." }
  ```

  It launches a validated monitored wrapper request.

The `subagent_monitor` tool provides the same `status` and `run` operations.
Per-run limits are optional and can tighten a non-zero global ceiling. A finite
run-specific limit may be supplied when the global signal is disabled; monitor
policy fields are never added to a `pi-subagents` RPC payload.

## Control and recovery

In enforce mode, a breach starts a documented graceful interrupt, reconciles
status during the configured grace period, and escalates only through an
advertised public control. A stop is recorded only after authoritative terminal
status and process-terminal evidence are observed. Failed or unconfirmed
controls enter `unknown-control`, retain a critical status, and retry with
bounded backoff. Pi remains open after every control failure; use the exact
status and control forms documented by `pi-subagents` for manual recovery.

The monitor targets the complete known workflow tree and does not control
unrelated workflows. It never kills operating-system processes or shuts down
the parent Pi session.

## Compatibility and privacy

The extension uses the versioned in-process `pi-subagents` RPC/event contract,
including capability discovery, current-session status, interrupt, and stop.
It supports TUI and RPC modes and remains inert in print/JSON modes. It uses no
private imports, terminal scraping, model-generated ETA, child prompt edits, or
artifact scanning.

Persistent history is a bounded metrics-only file. It does not store prompts,
task text, transcripts, working-directory paths, artifact paths, credentials,
or raw provider responses.

## Troubleshooting

If the gateway is unavailable, the monitor reports `degraded` and does not
claim that work stopped. Check `pi-subagents`' own documented doctor/status
controls, then use its documented interrupt or stop control for an unresolved
workflow. The monitor's status remains visible so an operator can distinguish
confirmed terminal work from `unknown-control`.
