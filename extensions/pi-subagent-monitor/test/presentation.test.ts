import { describe, expect, it, vi } from 'vitest';
import { formatStatus, notificationKey, notifyOnce } from '../src/presentation';
import type { WorkflowRecord } from '../src/types';
import { workflowSnapshot } from './support/fakes';

describe('presentation', () => {
  it('formats a compact status without task or transcript text', () => {
    const record: WorkflowRecord = {
      snapshot: workflowSnapshot({ totalTokens: 1200, toolCount: 8, turnCount: 3, currentTool: 'read' }),
      clock: {
        phase: 'running',
        observedAt: 50000,
        executionMs: 55000,
        lastActivityAt: 44000,
        activityFingerprint: 'fingerprint',
      },
      effectiveLimits: {
        wallClockMs: 60000,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      state: 'warning',
      warnedSignals: new Set(['wallClockMs']),
      retryAttempt: 0,
    };
    const text = formatStatus('enforce', [record], 50000);
    expect(text).toContain('1 workflow');
    expect(text).toContain('5s');
    expect(text).toContain('read');
    expect(text).not.toContain('task');
    expect(text).not.toContain('transcript');
  });

  it('deduplicates the same notification key', () => {
    const notify = vi.fn();
    const seen = new Set<string>();
    const key = notificationKey('run-1', 'wallClockMs', 'warning');
    expect(notifyOnce(seen, key, notify, 'time warning', 'warning')).toBe(true);
    expect(notifyOnce(seen, key, notify, 'time warning', 'warning')).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('reports degraded and unknown-control states without exposing opaque payloads', () => {
    const record: WorkflowRecord = {
      snapshot: workflowSnapshot({ currentTool: 'tool\nsecret task' }),
      clock: { phase: 'running', observedAt: 0, executionMs: 0, activityFingerprint: 'x' },
      effectiveLimits: {
        wallClockMs: 0,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      state: 'unknown-control',
      warnedSignals: new Set(),
      retryAttempt: 2,
    };
    const status = formatStatus('enforce', [record], 0);
    expect(status).toContain('unknown-control');
    expect(status).not.toContain('secret task');
  });
});
