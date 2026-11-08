import { describe, expect, it, vi } from 'vitest';
import { createLaunchWrapper, parseLaunchArgs, resolveLaunch } from '../src/wrapper';
import { FakeEventBus } from './support/fakes';

describe('launch wrapper', () => {
  it('rejects malformed JSON before launch parsing reaches the wrapper', () => {
    expect(() => parseLaunchArgs('{broken')).toThrow('valid JSON');
    expect(() => parseLaunchArgs('x'.repeat(16001))).toThrow('bounded');
  });

  it('accepts a stricter finite policy and rejects a relaxed global policy', () => {
    const global = {
      wallClockMs: 600000,
      inactivityMs: 120000,
      tokenCount: 100000,
      costUsd: 5,
      toolCalls: 100,
      turns: 20,
      activeToolMs: 90000,
    };
    const request = resolveLaunch(
      {
        kind: 'single',
        agent: 'reviewer',
        task: 'Review the current diff.',
        limits: { wallClockMs: 300000, turns: 10 },
      },
      global,
    );
    expect(request.effectiveLimits.wallClockMs).toBe(300000);
    expect(request.effectiveLimits.turns).toBe(10);
    expect(() =>
      resolveLaunch(
        {
          kind: 'single',
          agent: 'reviewer',
          task: 'Review the current diff.',
          limits: { wallClockMs: 900000 },
        },
        global,
      ),
    ).toThrow('global ceiling');
  });

  it('does not send monitor policy fields through the public RPC payload', async () => {
    const events = new FakeEventBus();
    const requests: unknown[] = [];
    events.on('subagents:rpc:v1:request', (payload) => {
      requests.push(payload);
      const request = payload as { requestId: string };
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: { runId: 'run-9', state: 'running' },
      });
    });
    const wrapper = createLaunchWrapper({
      events,
      sessionId: 'session-1',
      cwd: '/repo',
      globalLimits: {
        wallClockMs: 600000,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      associate: vi.fn(),
      requestTimeoutMs: 50,
    });
    await wrapper.launch({
      kind: 'single',
      agent: 'reviewer',
      task: 'Review the current diff.',
      async: true,
      limits: { wallClockMs: 300000 },
    });
    const spawn = requests[0] as { method: string; params: Record<string, unknown> };
    expect(spawn.method).toBe('spawn');
    expect(spawn.params.monitorPolicy).toBeUndefined();
    expect(spawn.params.policy).toBeUndefined();
    expect(spawn.params).toEqual({ agent: 'reviewer', task: 'Review the current diff.', async: true });
  });

  it('rejects unsupported foreground composite overrides before launch', async () => {
    const events = new FakeEventBus();
    const launcher = createLaunchWrapper({
      events,
      sessionId: 'session-1',
      cwd: '/repo',
      globalLimits: {
        wallClockMs: 0,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      associate: vi.fn(),
    });
    await expect(
      launcher.launch({
        kind: 'parallel-review',
        task: 'Review the current diff.',
        async: false,
        steps: [
          { key: 'correctness', agent: 'reviewer', task: 'Check correctness.' },
          { key: 'tests', agent: 'reviewer', task: 'Check tests.' },
        ],
        limits: { wallClockMs: 300000 },
      }),
    ).rejects.toThrow('foreground composite');
    expect(events).toBeDefined();
  });

  it('uses the documented structured delegation seam for foreground single launches', async () => {
    const events = new FakeEventBus();
    const requests: unknown[] = [];
    const associate = vi.fn();
    events.on('subagents:rpc:v1:request', (payload) => requests.push(payload));
    events.on('prompt-template:subagent:request', (payload) => {
      const event = payload as { requestId: string };
      events.emit('prompt-template:subagent:started', {
        requestId: event.requestId,
        runId: 'foreground-run-1',
      });
    });
    events.on('prompt-template:subagent:started', (payload) => {
      const event = payload as { requestId: string; runId: string };
      associate(event.runId, {
        wallClockMs: 1,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      });
    });
    const wrapper = createLaunchWrapper({
      events,
      sessionId: 'session-1',
      cwd: '/repo',
      globalLimits: {
        wallClockMs: 0,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      associate,
      requestTimeoutMs: 50,
    });
    const result = await wrapper.launch({ kind: 'single', agent: 'reviewer', task: 'Review.', async: false });
    expect(result.state).toBe('started');
    expect(requests).toHaveLength(0);
  });
});
