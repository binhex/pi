import { describe, expect, it, vi } from 'vitest';
import monitorExtension from '../src/index';
import { FakeEventBus } from './support/fakes';

describe('extension factory', () => {
  it('registers the public monitor tool and command without starting resources', () => {
    const pi = {
      events: new FakeEventBus(),
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    };
    monitorExtension(pi as never);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(pi.registerTool.mock.calls[0]?.[0]).toMatchObject({ name: 'subagent_monitor' });
    expect(pi.registerCommand).toHaveBeenCalledWith('subagent-monitor', expect.any(Object));
    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
  });

  it('does not create timers or launch work in the factory', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const pi = {
      events: new FakeEventBus(),
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    };
    monitorExtension(pi as never);
    expect(setInterval).not.toHaveBeenCalled();
    setInterval.mockRestore();
  });
});
