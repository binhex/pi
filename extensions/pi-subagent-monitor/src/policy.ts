import type {
  ClockState,
  LimitName,
  PolicyBreach,
  PolicyEvaluation,
  PolicyInput,
  PolicyWarning,
  WorkflowSnapshot,
  WorkflowState,
} from './types';

function clockActive(state: WorkflowState): boolean {
  return state === 'queued' || state === 'running';
}

export function advanceClock(
  previous: ClockState,
  nextPhase: WorkflowState,
  now: number,
  nextFingerprint: string,
): ClockState {
  const delta = Math.max(0, now - previous.observedAt);
  const executionMs = previous.executionMs + (clockActive(previous.phase) ? delta : 0);
  return {
    phase: nextPhase,
    observedAt: now,
    executionMs,
    lastActivityAt: previous.lastActivityAt,
    activityFingerprint: nextFingerprint,
  };
}

export function activityFingerprint(snapshot: WorkflowSnapshot): string {
  const children = snapshot.children.map((child) => ({
    id: child.id,
    state: child.state,
    runId: child.runId,
    currentTool: child.currentTool,
    lastActivityAt: child.lastActivityAt,
    totalTokens: child.totalTokens,
    toolCount: child.toolCount,
    turnCount: child.turnCount,
  }));
  return JSON.stringify({
    state: snapshot.state,
    currentTool: snapshot.currentTool,
    lastActivityAt: snapshot.lastActivityAt,
    totalTokens: snapshot.totalTokens,
    toolCalls: snapshot.toolCount,
    turns: snapshot.turnCount,
    children,
  });
}

export function isMeaningfulActivity(previous: WorkflowSnapshot, next: WorkflowSnapshot): boolean {
  return activityFingerprint(previous) !== activityFingerprint(next);
}

type CounterSignal = Extract<LimitName, 'tokenCount' | 'costUsd' | 'toolCalls' | 'turns'>;

function warnAtFraction(used: number | undefined, limit: number): boolean {
  return used !== undefined && limit > 0 && used >= limit * 0.8;
}

function addCounter(
  warnings: PolicyWarning[],
  missing: LimitName[],
  signal: CounterSignal,
  used: number | undefined,
  limit: number,
): void {
  if (limit === 0) return;
  if (used === undefined) {
    missing.push(signal);
    return;
  }
  if (warnAtFraction(used, limit)) warnings.push({ signal, used, limit });
}

export function evaluatePolicy(input: PolicyInput): PolicyEvaluation {
  const warnings: PolicyWarning[] = [];
  const missing: LimitName[] = [];
  const remaining: Partial<Record<LimitName, number>> = {};
  const { limits } = input;

  if (limits.wallClockMs > 0) {
    const remainingMs = Math.max(0, limits.wallClockMs - input.executionMs);
    remaining.wallClockMs = remainingMs;
    if (remainingMs <= input.warningLeadMs) {
      warnings.push({ signal: 'wallClockMs', used: input.executionMs, limit: limits.wallClockMs });
    }
  }
  if (limits.inactivityMs > 0) {
    if (input.lastActivityAt === undefined) {
      missing.push('inactivityMs');
    } else {
      const idleMs = Math.max(0, input.now - input.lastActivityAt);
      remaining.inactivityMs = Math.max(0, limits.inactivityMs - idleMs);
      if (idleMs >= Math.max(0, limits.inactivityMs - input.warningLeadMs)) {
        warnings.push({ signal: 'inactivityMs', used: idleMs, limit: limits.inactivityMs });
      }
    }
  }

  addCounter(warnings, missing, 'tokenCount', input.totalTokens, limits.tokenCount);
  addCounter(warnings, missing, 'costUsd', input.totalCost, limits.costUsd);
  addCounter(warnings, missing, 'toolCalls', input.toolCalls, limits.toolCalls);
  addCounter(warnings, missing, 'turns', input.turns, limits.turns);

  if (limits.activeToolMs > 0 && input.currentToolStartedAt !== undefined) {
    const activeToolMs = Math.max(0, input.now - input.currentToolStartedAt);
    remaining.activeToolMs = Math.max(0, limits.activeToolMs - activeToolMs);
    if (activeToolMs >= Math.max(0, limits.activeToolMs - input.warningLeadMs)) {
      warnings.push({ signal: 'activeToolMs', used: activeToolMs, limit: limits.activeToolMs });
    }
  }

  const breach: PolicyBreach | undefined = warnings.find((warning) => warning.used >= warning.limit);
  return { warnings, breach, missing, remaining };
}
