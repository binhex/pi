/**
 * Pi Bell Alert
 *
 * Audible alert when Pi needs you.
 *
 * Pi runs in a VS Code terminal, and that terminal may be rendered by
 * code-server in a browser, so this process cannot reach the browser's audio
 * directly. The one channel that crosses that boundary is terminal output:
 * VS Code's terminal (xterm.js) fires onBell for a BEL character and maps it
 * to AccessibilitySignal.terminalBell, which the web client plays as an
 * HTMLAudioElement. OSC 777 / OSC 9 desktop notifications are NOT implemented
 * by xterm.js, so they do nothing there.
 *
 * Requires this VS Code setting (the default "auto" only sounds when a screen
 * reader is attached):
 *   "accessibility.signals.terminalBell": { "sound": "on", "announcement": "off" }
 *
 * Set PI_BELL=0 to disable without removing the extension.
 *
 * Subagents (pi-subagents): a background run keeps the parent turn short, so
 * Pi settles while children are still working and is woken again later. The
 * bell is suppressed in that window, except when a child waits on a supervisor
 * answer - the one case where you are actually wanted. Suppression reads
 * pi-subagents' documented in-process RPC (`status` -> `data.fleet.totalActive`)
 * and is skipped entirely when no reply arrives.
 */

import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const RPC_READY_EVENT = 'subagents:rpc:v1:ready';
const RPC_REQUEST_EVENT = 'subagents:rpc:v1:request';
const RPC_REPLY_EVENT_PREFIX = 'subagents:rpc:v1:reply:';
const SUPERVISOR_REQUEST_MESSAGE_TYPE = 'subagent_supervisor_request';
const SUPERVISOR_TOOL_NAME = 'subagent_supervisor';
const STATUS_TIMEOUT_MS = 500;
const MAX_TRACKED_REQUESTS = 32;

/** Ring the terminal bell. No-op where there is no terminal to ring. */
function bell(): void {
  if (process.env.PI_BELL === '0') return;
  // RPC, print and JSON modes have no interactive terminal (and RPC reports
  // hasUI=true), so mode is the reliable gate. isTTY covers redirected stdout.
  if (!process.stdout.isTTY) return;
  process.stdout.write('\x07');
}

type CustomMessage = {
  role?: string;
  customType?: string;
  details?: { id?: string; requestId?: string };
};

export default function (pi: ExtensionAPI) {
  let interactive = false;
  let subagentsAvailable = false;
  // Request ids a child is still waiting on. Tracked here because the status
  // RPC does not expose pending supervisor questions: they surface as
  // parent-session messages (`subagent_supervisor_request`) that the parent
  // answers with a tool call.
  const pendingSupervisorRequests = new Set<string>();

  function markInteractive(ctx: { mode?: string } | undefined): void {
    interactive = ctx?.mode === 'tui';
  }

  // pi-subagents emits this from its session_start, so listening at load time
  // means it fires after this extension subscribed whether it loads first or last.
  pi.events.on(RPC_READY_EVENT, () => {
    subagentsAvailable = true;
  });

  /**
   * Ask pi-subagents whether background runs are still live.
   * Resolves undefined when no owner answers, so callers fail open and ring.
   */
  function activeSubagentRuns(): Promise<boolean | undefined> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const channel = `${RPC_REPLY_EVENT_PREFIX}${requestId}`;
      let done = false;

      const finish = (value: boolean | undefined): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (typeof off === 'function') off();
        resolve(value);
      };

      const off = pi.events.on(channel, (reply) => {
        const record = reply as { success?: boolean; data?: Record<string, unknown> } | undefined;
        if (record?.success !== true || !record.data) {
          finish(undefined);
          return;
        }

        const fleet = record.data.fleet as { totalActive?: unknown } | undefined;
        if (fleet && typeof fleet.totalActive === 'number') {
          finish(fleet.totalActive > 0);
          return;
        }

        // older pi-subagents without the fleet DTO: fall back to the snapshot
        const runs = (record.data.asyncSnapshot as { runs?: unknown } | undefined)?.runs;
        if (Array.isArray(runs)) {
          finish(
            runs.some((run) => {
              const state = (run as { state?: unknown } | undefined)?.state;
              return state === 'running' || state === 'queued' || state === 'pending';
            }),
          );
          return;
        }

        finish(undefined);
      }) as unknown as (() => void) | undefined;

      // deliberately not unref'd: an unref'd timer never fires in an otherwise
      // idle loop, which would leave the settle handler waiting forever
      const timer = setTimeout(() => finish(undefined), STATUS_TIMEOUT_MS);

      try {
        pi.events.emit(RPC_REQUEST_EVENT, {
          version: 1,
          requestId,
          method: 'status',
          params: {},
        });
      } catch {
        finish(undefined);
      }
    });
  }

  pi.on('session_start', async (_event, ctx) => {
    markInteractive(ctx);
    pendingSupervisorRequests.clear();
  });

  pi.on('agent_start', async (_event, ctx) => {
    markInteractive(ctx);
  });

  // A child blocked on contact_supervisor arrives as a user turn carrying this
  // custom message; it stays pending until the parent answers with the tool.
  pi.on('message_start', async (event) => {
    const message = (event as { message?: CustomMessage }).message;
    if (message?.role !== 'custom' || message.customType !== SUPERVISOR_REQUEST_MESSAGE_TYPE) {
      return;
    }
    const id = message.details?.id ?? message.details?.requestId;
    if (typeof id !== 'string' || id.length === 0) return;
    if (pendingSupervisorRequests.size >= MAX_TRACKED_REQUESTS) pendingSupervisorRequests.clear();
    pendingSupervisorRequests.add(id);
  });

  pi.on('tool_call', async (event) => {
    if ((event as { toolName?: string }).toolName !== SUPERVISOR_TOOL_NAME) return;
    const input = (event as { input?: { action?: string; replyTo?: string } }).input;
    if (input?.action !== 'reply') return;
    if (typeof input.replyTo === 'string') {
      pendingSupervisorRequests.delete(input.replyTo);
    } else if (pendingSupervisorRequests.size === 1) {
      // a reply with no replyTo resolves the only outstanding ask
      pendingSupervisorRequests.clear();
    }
  });

  // agent_end fires after each low-level run, but Pi may still auto-retry,
  // auto-compact and retry, or continue with queued follow-ups. agent_settled
  // is the first point at which Pi is genuinely waiting for the user.
  pi.on('agent_settled', async (event) => {
    if (!interactive) return;
    // aborted means the user pressed Escape: they are already looking at Pi
    if (event.aborted) return;

    // a child is waiting on an answer the parent turn did not give
    if (pendingSupervisorRequests.size > 0) {
      bell();
      return;
    }

    // background children wake the session themselves: stay quiet until then
    if (subagentsAvailable && (await activeSubagentRuns()) === true) return;

    bell();
  });

  // Fires around ctx.ui.select/confirm/input/editor/custom, which includes
  // ask_user_question (it mounts through ctx.ui.custom). Nested prompts are
  // coalesced into one outer span, so this rings once per waiting period.
  pi.on('ui_prompt_start', async () => {
    if (!interactive) return;
    bell();
  });

  // Manual check of the exact write path used above, without waiting for a turn.
  pi.registerCommand('bell-test', {
    description: 'Ring the alert bell once (verifies the terminal really beeps)',
    handler: async (_args, ctx) => {
      const reason =
        process.env.PI_BELL === '0'
          ? 'PI_BELL=0 is set'
          : !process.stdout.isTTY
            ? 'stdout is not a TTY'
            : !interactive
              ? 'session mode is not tui'
              : undefined;
      bell();
      ctx.ui.notify(
        reason
          ? `/bell-test suppressed: ${reason}`
          : '/bell-test wrote BEL - if you heard nothing, check accessibility.signals.terminalBell.sound',
        reason ? 'warning' : 'info',
      );
    },
  });
}
