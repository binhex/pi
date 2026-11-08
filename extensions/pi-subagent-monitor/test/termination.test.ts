import { describe, expect, it, vi } from 'vitest';
import { TerminationCoordinator } from '../src/termination';
import { FakeGateway, gatewaySnapshot, workflowSnapshot } from './support/fakes';
import type { PolicyBreach, WorkflowRecord } from '../src/types';

describe('termination coordinator', () => {
  it('interrupts then stops the whole background workflow and confirms terminal state', async () => {
    const gateway = new FakeGateway();
    const updates: string[] = [];
    let terminal = false;
    let reconciliations = 0;
    const record: WorkflowRecord = {
      snapshot: workflowSnapshot({ kind: 'background', state: 'running' }),
      clock: {
        phase: 'running',
        observedAt: 1000,
        executionMs: 600001,
        lastActivityAt: 1000,
        activityFingerprint: 'x',
      },
      effectiveLimits: {
        wallClockMs: 600000,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      state: 'terminating',
      warnedSignals: new Set(),
      retryAttempt: 0,
    };
    const breach: PolicyBreach = { signal: 'wallClockMs', used: 600001, limit: 600000 };
    const coordinator = new TerminationCoordinator({
      gateway,
      get: () =>
        terminal
          ? { ...record, snapshot: workflowSnapshot({ state: 'stopped', processTerminal: 'observed' }) }
          : record,
      reconcile: async () => {
        reconciliations += 1;
        terminal = reconciliations >= 3;
        gateway.current = gatewaySnapshot([
          workflowSnapshot({
            state: terminal ? 'stopped' : 'running',
            processTerminal: terminal ? 'observed' : 'unknown',
          }),
        ]);
      },
      sleep: async () => undefined,
      now: () => 2000,
      graceMs: 100,
      retryBaseMs: 100,
      retryMaxMs: 1000,
      onState: (_runId, state) => updates.push(state),
    });
    const result = await coordinator.breach(record, breach);
    expect(gateway.interrupted).toEqual(['run-1']);
    expect(gateway.stopped).toEqual(['run-1']);
    expect(result.state).toBe('confirmed');
    expect(updates).toContain('confirmed');
  });

  it('includes a child discovered during grace and reports unknown control', async () => {
    const gateway = new FakeGateway();
    const reconcile = vi.fn(async () => {
      gateway.current = gatewaySnapshot([
        workflowSnapshot({
          children: [
            { id: 'step:0', state: 'running' },
            { id: 'step:1', state: 'running' },
          ],
        }),
      ]);
    });
    const record: WorkflowRecord = {
      snapshot: workflowSnapshot({ kind: 'foreground', controlTarget: { kind: 'foreground-current' } }),
      clock: { phase: 'running', observedAt: 1000, executionMs: 100, activityFingerprint: 'x' },
      effectiveLimits: {
        wallClockMs: 100,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      state: 'terminating',
      warnedSignals: new Set(),
      retryAttempt: 0,
    };
    const coordinator = new TerminationCoordinator({
      gateway,
      get: () => record,
      reconcile,
      sleep: async () => undefined,
      now: () => 2000,
      graceMs: 1,
      retryBaseMs: 1,
      retryMaxMs: 2,
      onState: vi.fn(),
    });
    const result = await coordinator.breach(record, { signal: 'wallClockMs', used: 101, limit: 100 });
    expect(reconcile).toHaveBeenCalled();
    expect(result.state).toBe('unknown-control');
  });

  it('retries the original breach and confirms a later terminal snapshot', async () => {
    const gateway = new FakeGateway();
    let terminal = false;
    const record: WorkflowRecord = {
      snapshot: workflowSnapshot({ state: 'running' }),
      clock: { phase: 'running', observedAt: 1000, executionMs: 101, activityFingerprint: 'x' },
      effectiveLimits: {
        wallClockMs: 100,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      state: 'unknown-control',
      warnedSignals: new Set(),
      breach: { signal: 'wallClockMs', used: 101, limit: 100 },
      retryAttempt: 0,
    };
    const coordinator = new TerminationCoordinator({
      gateway,
      get: () =>
        terminal
          ? { ...record, snapshot: workflowSnapshot({ state: 'stopped', processTerminal: 'observed' }) }
          : record,
      reconcile: async () => {
        terminal = true;
      },
      sleep: async () => undefined,
      now: () => 2000,
      graceMs: 1,
      retryBaseMs: 1,
      retryMaxMs: 2,
      onState: vi.fn(),
    });
    const result = await coordinator.retry(record);
    expect(result.state).toBe('confirmed');
    expect(gateway.interrupted).toEqual(['run-1']);
  });

  it('does not expose a parent shutdown operation', () => {
    const coordinator = new TerminationCoordinator({
      gateway: new FakeGateway(),
      get: () => undefined,
      reconcile: async () => undefined,
      sleep: async () => undefined,
      now: () => 0,
      graceMs: 0,
      retryBaseMs: 1,
      retryMaxMs: 1,
      onState: vi.fn(),
    });
    expect(coordinator).toHaveProperty('breach');
    expect(coordinator).not.toHaveProperty('shutdown');
  });
});
