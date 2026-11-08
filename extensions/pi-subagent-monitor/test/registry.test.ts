import { describe, expect, it } from 'vitest';
import { RunRegistry } from '../src/registry';
import { gatewaySnapshot, workflowSnapshot } from './support/fakes';

describe('run registry', () => {
  it('starts and updates a workflow without merging stale fields', () => {
    const registry = new RunRegistry('session-1');
    const first = workflowSnapshot({ totalTokens: 10, currentTool: 'read' });
    const second = workflowSnapshot({ totalTokens: 20, currentTool: undefined });
    registry.reconcile(gatewaySnapshot([first]), 1000, () => ({
      wallClockMs: 600000,
      inactivityMs: 0,
      tokenCount: 1000,
      costUsd: 0,
      toolCalls: 0,
      turns: 0,
      activeToolMs: 0,
    }));
    registry.reconcile(gatewaySnapshot([second]), 2000, () => ({
      wallClockMs: 600000,
      inactivityMs: 0,
      tokenCount: 1000,
      costUsd: 0,
      toolCalls: 0,
      turns: 0,
      activeToolMs: 0,
    }));
    const record = registry.get('run-1');
    expect(record?.snapshot.totalTokens).toBe(20);
    expect(record?.snapshot.currentTool).toBeUndefined();
  });

  it('pauses and resumes the execution clock without resetting it', () => {
    const registry = new RunRegistry('session-1');
    const limits = () => ({
      wallClockMs: 100000,
      inactivityMs: 0,
      tokenCount: 0,
      costUsd: 0,
      toolCalls: 0,
      turns: 0,
      activeToolMs: 0,
    });
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ state: 'running' })]), 1000, limits);
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ state: 'paused' })]), 4000, limits);
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ state: 'running' })]), 9000, limits);
    expect(registry.get('run-1')?.clock.executionMs).toBe(3000);
  });

  it('keeps terminal records until a terminal snapshot is authoritative', () => {
    const registry = new RunRegistry('session-1');
    const limits = () => ({
      wallClockMs: 0,
      inactivityMs: 0,
      tokenCount: 0,
      costUsd: 0,
      toolCalls: 0,
      turns: 0,
      activeToolMs: 0,
    });
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ state: 'running' })]), 1000, limits);
    expect(registry.active()).toHaveLength(1);
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ state: 'stopped' })]), 2000, limits);
    expect(registry.active()).toHaveLength(0);
    expect(registry.get('run-1')?.snapshot.state).toBe('stopped');
  });

  it('does not admit snapshots from another session', () => {
    const registry = new RunRegistry('session-1');
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ sessionId: 'session-2' })]), 1000, () => ({
      wallClockMs: 0,
      inactivityMs: 0,
      tokenCount: 0,
      costUsd: 0,
      toolCalls: 0,
      turns: 0,
      activeToolMs: 0,
    }));
    expect(registry.active()).toHaveLength(0);
  });
});
