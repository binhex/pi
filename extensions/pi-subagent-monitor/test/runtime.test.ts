import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { MetricsStore } from '../src/history';
import { MonitorRuntime } from '../src/runtime';
import { RunRegistry } from '../src/registry';
import { FakeGateway, gatewaySnapshot, workflowSnapshot } from './support/fakes';

describe('monitor runtime', () => {
  it('keeps startup resources deferred until session_start', async () => {
    const gateway = new FakeGateway();
    const setInterval = vi.fn(() => 1 as unknown as ReturnType<typeof globalThis.setInterval>);
    const piContext = makeContext();
    const runtime = new MonitorRuntime({
      loadConfig: async () => ({ config: DEFAULT_CONFIG }),
      connectGateway: async () => gateway,
      createRegistry: (sessionId) => new RunRegistry(sessionId),
      createHistory: () =>
        ({ append: vi.fn(async () => undefined), list: vi.fn(async () => []) }) as unknown as MetricsStore,
      createWrapper: () => ({ launch: vi.fn() }),
      ui: () => piContext.ui,
      now: () => 1000,
      setInterval,
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 1 as unknown as ReturnType<typeof globalThis.setTimeout>),
      clearTimeout: vi.fn(),
    });
    expect(setInterval).not.toHaveBeenCalled();
    await runtime.start(piContext);
    expect(setInterval).toHaveBeenCalledTimes(1);
  });

  it('keeps Pi open when a control remains unknown', async () => {
    const gateway = new FakeGateway();
    const notify = vi.fn();
    const shutdown = vi.fn();
    let currentNow = 1000;
    const ui = { setStatus: vi.fn(), notify, confirm: vi.fn(async () => false) };
    const history = { append: vi.fn(async () => undefined), list: vi.fn(async () => []) } as unknown as MetricsStore;
    const runtime = new MonitorRuntime({
      loadConfig: async () => ({
        config: {
          ...DEFAULT_CONFIG,
          mode: 'enforce',
          limits: { ...DEFAULT_CONFIG.limits, wallClockMs: 100 },
        },
      }),
      connectGateway: async () => gateway,
      createRegistry: (sessionId) => new RunRegistry(sessionId),
      createHistory: () => history,
      createWrapper: () => ({ launch: vi.fn() }),
      ui: () => ui,
      now: () => currentNow,
      setInterval: () => 1 as unknown as ReturnType<typeof globalThis.setInterval>,
      clearInterval: vi.fn(),
      setTimeout: (callback, delayMs) => {
        if (delayMs === 15000) callback();
        return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
      },
      clearTimeout: vi.fn(),
    });
    const context = makeContext({ ui, shutdown });
    gateway.current = gatewaySnapshot([workflowSnapshot({ processTerminal: 'unknown' })]);
    await runtime.start(context);
    currentNow = 1000000;
    await runtime.reconcile(currentNow);
    expect(notify).toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('clears timers and footer state during shutdown', async () => {
    const clearInterval = vi.fn();
    const clearTimeout = vi.fn();
    const setInterval = vi.fn(() => 2 as unknown as ReturnType<typeof globalThis.setInterval>);
    const gateway = new FakeGateway();
    const ui = { setStatus: vi.fn(), notify: vi.fn(), confirm: vi.fn(async () => false) };
    const runtime = new MonitorRuntime({
      loadConfig: async () => ({ config: DEFAULT_CONFIG }),
      connectGateway: async () => gateway,
      createRegistry: (sessionId) => new RunRegistry(sessionId),
      createHistory: () =>
        ({ append: vi.fn(async () => undefined), list: vi.fn(async () => []) }) as unknown as MetricsStore,
      createWrapper: () => ({ launch: vi.fn() }),
      ui: () => ui,
      now: () => 1000,
      setInterval,
      clearInterval,
      setTimeout: vi.fn(() => 1 as unknown as ReturnType<typeof globalThis.setTimeout>),
      clearTimeout,
    });
    await runtime.start(makeContext({ ui }));
    await runtime.stop();
    expect(clearInterval).toHaveBeenCalledWith(2);
    expect(ui.setStatus).toHaveBeenLastCalledWith('subagent-monitor', undefined);
  });
});

function makeContext(overrides: { ui?: unknown; shutdown?: () => void } = {}): ExtensionContext {
  const ui = overrides.ui ?? { setStatus: vi.fn(), notify: vi.fn(), confirm: vi.fn(async () => false) };
  return {
    ui,
    mode: 'tui',
    hasUI: true,
    cwd: '/repo',
    sessionManager: { getSessionId: () => 'session-1' },
    ...overrides,
  } as unknown as ExtensionContext;
}
