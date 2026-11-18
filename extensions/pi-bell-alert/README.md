# pi-bell-alert

Audible alert when Pi needs you.

Rings the terminal bell when Pi starts waiting for you, and stays quiet while
background subagents are still working.

## Triggers

| Event                                                                | Bell |
| -------------------------------------------------------------------- | ---- |
| `agent_settled` — Pi finished its turn and waits for input           | yes  |
| `ui_prompt_start` — a blocking dialog, including `ask_user_question` | yes  |
| `agent_settled` with `aborted` — you pressed Escape                  | no   |
| non-TUI modes (`rpc`, print, JSON, redirected stdout)                | no   |

## Subagent suppression

Background subagent runs keep the parent turn short: Pi settles while children
keep working and is woken again when they finish. Ringing at that first settle
would be noise, so the bell is suppressed while pi-subagents reports live runs.

The check uses pi-subagents' documented in-process RPC:

- availability comes from `subagents:rpc:v1:ready`
- liveness comes from `method: "status"` -> `data.fleet.totalActive` (falls back
  to `data.asyncSnapshot.runs[].state` on older versions)
- no reply within 500 ms means "cannot tell", and the bell rings (fail open)

The one exception is a child waiting on you: `contact_supervisor` requests
surface as parent-session messages of type `subagent_supervisor_request`, which
this extension tracks until `subagent_supervisor({ action: "reply" })` clears
them. While one is unanswered the bell rings even though runs are active.

Paused or stopped runs do not count as active, so they never mute the bell.

## Why the terminal bell

The only channel available to this process is terminal output. VS Code's
terminal (xterm.js) maps a BEL character to `AccessibilitySignal.terminalBell`,
which the desktop and web clients play as an `HTMLAudioElement`. OSC 777 and
OSC 9 desktop notifications are not implemented by xterm.js, so they cannot be
used to reach a browser-based client such as code-server.

## Requirement

VS Code / code-server setting (the default `"auto"` only sounds with a screen
reader attached):

```jsonc
{
  "accessibility.signals.terminalBell": { "sound": "on", "announcement": "off" },
  "terminal.integrated.enableVisualBell": true, // optional: tab bell icon
}
```

## Commands

| Command      | Purpose                                             |
| ------------ | --------------------------------------------------- |
| `/bell-test` | Ring once and report whether any gate suppressed it |

Set `PI_BELL=0` in the environment to silence the extension without removing it.

## Verification

- `/bell-test` exercises the exact `process.stdout.write('\x07')` path used by
  the handlers.
- A real turn ending rings once with no subagents involved.
- Dispatch an async subagent: the parent turn returns silently, then exactly one
  bell rings when the wake-up turn settles.
