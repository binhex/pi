import { describe, expect, it, vi } from 'vitest';
import { registerMonitorCommands } from '../src/commands';

describe('monitor commands', () => {
  it('routes the default command to status', async () => {
    const status = vi.fn(async () => undefined);
    const pi = { registerCommand: vi.fn() };
    registerMonitorCommands(pi as never, {
      status,
      setMode: vi.fn(async () => undefined),
      history: vi.fn(async () => undefined),
      extend: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
    });
    const options = pi.registerCommand.mock.calls[0]?.[1] as { handler: (args: string, ctx: unknown) => Promise<void> };
    await options.handler('', {});
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('routes all documented subcommands and preserves arguments', async () => {
    const handlers = {
      status: vi.fn(async () => undefined),
      setMode: vi.fn(async () => undefined),
      history: vi.fn(async () => undefined),
      extend: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
    };
    const pi = { registerCommand: vi.fn() };
    registerMonitorCommands(pi as never, handlers);
    const options = pi.registerCommand.mock.calls[0]?.[1] as { handler: (args: string, ctx: unknown) => Promise<void> };
    const ctx = {};
    await options.handler('observe', ctx);
    await options.handler('enforce', ctx);
    await options.handler('history', ctx);
    await options.handler('extend  {"wallClockMs": 10}', ctx);
    await options.handler('run {"kind":"single"}', ctx);
    expect(handlers.setMode).toHaveBeenNthCalledWith(1, 'observe', ctx);
    expect(handlers.setMode).toHaveBeenNthCalledWith(2, 'enforce', ctx);
    expect(handlers.extend).toHaveBeenCalledWith('{"wallClockMs": 10}', ctx);
    expect(handlers.run).toHaveBeenCalledWith('{"kind":"single"}', ctx);
  });

  it('reports invalid commands without invoking runtime handlers', async () => {
    const notify = vi.fn();
    const pi = { registerCommand: vi.fn() };
    registerMonitorCommands(pi as never, {
      status: vi.fn(async () => undefined),
      setMode: vi.fn(async () => undefined),
      history: vi.fn(async () => undefined),
      extend: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
    });
    const options = pi.registerCommand.mock.calls[0]?.[1] as {
      handler: (args: string, ctx: { ui: { notify: typeof notify } }) => Promise<void>;
    };
    await options.handler('unknown', { ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Usage:'), 'warning');
  });
});
