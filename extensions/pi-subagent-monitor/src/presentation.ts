import type { LimitName, MonitorMode, MonitorState, WorkflowRecord } from './types';

export type NoticeLevel = 'info' | 'warning' | 'error';

export interface MonitorUi {
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, level: NoticeLevel): void;
  confirm(title: string, body: string): Promise<boolean>;
}

function duration(ms: number): string {
  const bounded = Math.max(0, Math.floor(ms));
  if (bounded < 1000) return '0s';
  const seconds = Math.floor(bounded / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function safeLabel(value: string | undefined, max = 64): string {
  if (value === undefined) return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max)
    .trim();
}

function safeToolLabel(value: string | undefined): string {
  const label = safeLabel(value);
  return /^[A-Za-z0-9._:/-]+$/.test(label) ? label : '';
}

function isActive(record: WorkflowRecord): boolean {
  return (
    record.snapshot.state === 'queued' || record.snapshot.state === 'running' || record.snapshot.state === 'paused'
  );
}

function elapsedMs(record: WorkflowRecord, now: number): number {
  const extra =
    record.snapshot.state === 'queued' || record.snapshot.state === 'running'
      ? Math.max(0, now - record.clock.observedAt)
      : 0;
  return record.clock.executionMs + extra;
}

function timeRemainingMs(record: WorkflowRecord, now: number): number {
  const remaining: number[] = [];
  const limits = record.effectiveLimits;
  if (limits.wallClockMs > 0) remaining.push(Math.max(0, limits.wallClockMs - elapsedMs(record, now)));
  if (limits.inactivityMs > 0 && record.clock.lastActivityAt !== undefined) {
    remaining.push(Math.max(0, limits.inactivityMs - Math.max(0, now - record.clock.lastActivityAt)));
  }
  if (limits.activeToolMs > 0 && record.snapshot.currentToolStartedAt !== undefined) {
    remaining.push(Math.max(0, limits.activeToolMs - Math.max(0, now - record.snapshot.currentToolStartedAt)));
  }
  return remaining.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...remaining);
}

function knownBudgets(record: WorkflowRecord, now: number): Array<{ remaining: number; label: string }> {
  const result: Array<{ remaining: number; label: string }> = [];
  const limits = record.effectiveLimits;
  const time = timeRemainingMs(record, now);
  if (time !== Number.MAX_SAFE_INTEGER) result.push({ remaining: time, label: `time ${duration(time)}` });
  if (limits.tokenCount > 0 && record.snapshot.totalTokens !== undefined) {
    result.push({
      remaining: Math.max(0, limits.tokenCount - record.snapshot.totalTokens),
      label: `${Math.max(0, limits.tokenCount - record.snapshot.totalTokens)} tok`,
    });
  }
  if (limits.costUsd > 0 && record.snapshot.totalCost !== undefined) {
    const remaining = Math.max(0, limits.costUsd - record.snapshot.totalCost);
    result.push({ remaining, label: `$${remaining.toFixed(2)}` });
  }
  if (limits.toolCalls > 0 && record.snapshot.toolCount !== undefined) {
    result.push({
      remaining: Math.max(0, limits.toolCalls - record.snapshot.toolCount),
      label: `${Math.max(0, limits.toolCalls - record.snapshot.toolCount)} tools`,
    });
  }
  if (limits.turns > 0 && record.snapshot.turnCount !== undefined) {
    result.push({
      remaining: Math.max(0, limits.turns - record.snapshot.turnCount),
      label: `${Math.max(0, limits.turns - record.snapshot.turnCount)} turns`,
    });
  }
  return result;
}

function budgetText(record: WorkflowRecord, now: number): string {
  const budgets = knownBudgets(record, now);
  if (budgets.length === 0) return 'uncapped';
  budgets.sort((left, right) => left.remaining - right.remaining);
  return budgets[0].label;
}

function stateLabel(state: MonitorState): string {
  return state === 'unknown-control' ? 'unknown-control' : state;
}

export function formatStatus(
  mode: MonitorMode,
  records: readonly WorkflowRecord[],
  now: number,
  unconfirmed = 0,
): string | undefined {
  const active = records.filter(isActive);
  const unknown = unconfirmed > 0 ? ` | ${unconfirmed} unconfirmed` : '';
  if (active.length === 0) return `${mode}${unknown}`;
  const first = [...active].sort((left, right) => timeRemainingMs(left, now) - timeRemainingMs(right, now))[0];
  const noun = active.length === 1 ? 'workflow' : 'workflows';
  const toolName = safeToolLabel(first.snapshot.currentTool);
  const tool = toolName === '' ? '' : ` | ${toolName}`;
  const counters = [
    first.snapshot.totalTokens === undefined ? '' : `${first.snapshot.totalTokens} tok`,
    first.snapshot.totalCost === undefined ? '' : `$${first.snapshot.totalCost.toFixed(2)}`,
    first.snapshot.toolCount === undefined ? '' : `${first.snapshot.toolCount} tools`,
    first.snapshot.turnCount === undefined ? '' : `${first.snapshot.turnCount} turns`,
  ]
    .filter(Boolean)
    .join(', ');
  const counterText = counters === '' ? '' : ` | ${counters}`;
  const activity =
    first.clock.lastActivityAt === undefined
      ? ''
      : ` | activity ${duration(Math.max(0, now - first.clock.lastActivityAt))} ago`;
  return `${mode} | ${active.length} ${noun} | next ${budgetText(first, now)} | elapsed ${duration(elapsedMs(first, now))} | ${stateLabel(first.state)}${tool}${counterText}${activity}${unknown}`;
}

export function notificationKey(runId: string, signal: LimitName | 'gateway', phase: string): string {
  return `${safeLabel(runId, 256)}:${safeLabel(signal, 64)}:${safeLabel(phase, 64)}`;
}

export function notifyOnce(
  seen: Set<string>,
  key: string,
  notify: (message: string, level: NoticeLevel) => void,
  message: string,
  level: NoticeLevel,
): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  notify(message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000), level);
  return true;
}
