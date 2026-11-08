import { describe, expect, it } from 'vitest';
import { advanceClock, evaluatePolicy, activityFingerprint, isMeaningfulActivity } from '../src/policy';
import type { ClockState, PolicyInput } from '../src/types';
import { workflowSnapshot } from './support/fakes';

describe('policy engine', () => {
  it('pauses execution time while a workflow is paused', () => {
    const initial: ClockState = {
      phase: 'running',
      observedAt: 1000,
      executionMs: 0,
      activityFingerprint: 'initial',
    };
    const paused = advanceClock(initial, 'paused', 4000, 'paused');
    const resumed = advanceClock(paused, 'running', 9000, 'resumed');
    const completed = advanceClock(resumed, 'complete', 10000, 'complete');
    expect(paused.executionMs).toBe(3000);
    expect(resumed.executionMs).toBe(3000);
    expect(completed.executionMs).toBe(4000);
  });

  it('detects meaningful state, tool, counter, and child changes', () => {
    const first = workflowSnapshot({ totalTokens: 10, currentTool: 'read' });
    const same = workflowSnapshot({ totalTokens: 10, currentTool: 'read' });
    const changed = workflowSnapshot({ totalTokens: 11, currentTool: 'edit' });
    expect(isMeaningfulActivity(first, same)).toBe(false);
    expect(isMeaningfulActivity(first, changed)).toBe(true);
    expect(activityFingerprint(first)).not.toBe(activityFingerprint(changed));
  });

  it('warns at the time lead and 80 percent counter thresholds', () => {
    const input: PolicyInput = {
      now: 70000,
      executionMs: 60000,
      lastActivityAt: 65000,
      totalTokens: 800,
      totalCost: 0.8,
      toolCalls: 8,
      turns: 8,
      limits: {
        wallClockMs: 60000,
        inactivityMs: 0,
        tokenCount: 1000,
        costUsd: 1,
        toolCalls: 10,
        turns: 10,
        activeToolMs: 0,
      },
      currentToolStartedAt: undefined,
      warningLeadMs: 15000,
    };
    const evaluation = evaluatePolicy(input);
    expect(evaluation.warnings.map((warning) => warning.signal)).toEqual([
      'wallClockMs',
      'tokenCount',
      'costUsd',
      'toolCalls',
      'turns',
    ]);
    expect(evaluation.breach?.signal).toBe('wallClockMs');
  });

  it('marks missing configured usage without treating it as zero', () => {
    const input: PolicyInput = {
      now: 1000,
      executionMs: 100,
      lastActivityAt: 900,
      limits: {
        wallClockMs: 0,
        inactivityMs: 0,
        tokenCount: 1000,
        costUsd: 1,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      warningLeadMs: 100,
    };
    const evaluation = evaluatePolicy(input);
    expect(evaluation.missing).toEqual(['tokenCount', 'costUsd']);
    expect(evaluation.breach).toBeUndefined();
  });

  it('breaches a configured active-tool duration', () => {
    const evaluation = evaluatePolicy({
      now: 10000,
      executionMs: 100,
      lastActivityAt: 9900,
      currentToolStartedAt: 1000,
      limits: {
        wallClockMs: 0,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 5000,
      },
      warningLeadMs: 1000,
    });
    expect(evaluation.breach?.signal).toBe('activeToolMs');
    expect(evaluation.breach?.used).toBe(9000);
  });
});
