import { describe, expect, it, vi } from 'vitest';
import { connectGateway } from '../src/gateway';
import { FakeEventBus } from './support/fakes';

describe('pi-subagents gateway', () => {
  it('performs a versioned ping and normalizes the public async snapshot', async () => {
    const events = new FakeEventBus();
    const requests: string[] = [];
    events.on('subagents:rpc:v1:request', (payload) => {
      const request = payload as { requestId: string; method: string };
      requests.push(request.method);
      const data =
        request.method === 'ping'
          ? {
              capabilities: { status: true, interrupt: true, stop: true },
              events: {
                asyncComplete: 'subagent:async-complete',
                childStatus: 'subagent:child-status',
                processTerminal: 'subagent:process-terminal',
              },
              session: { sessionId: 'session-1' },
            }
          : {
              asyncSnapshot: {
                kind: 'pi-subagents.async-status-snapshot',
                version: 1,
                runs: [
                  {
                    id: 'run-1',
                    kind: 'workflow',
                    label: 'review',
                    state: 'running',
                    startedAt: 1000,
                    activity: { lastActivityAt: 1100 },
                  },
                ],
              },
              fleet: { version: 1, entries: [], totalActive: 0, omitted: 0 },
            };
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data,
      });
    });
    const gateway = await connectGateway({
      events,
      sessionId: 'session-1',
      readyTimeoutMs: 50,
      requestTimeoutMs: 50,
    });
    const snapshot = await gateway.status();
    expect(requests).toEqual(['ping', 'status']);
    expect(snapshot.workflows[0]?.id).toBe('run-1');
    expect(gateway.capabilities.has('status')).toBe(true);
    gateway.dispose();
  });

  it('rejects a session mismatch before accepting status', async () => {
    const events = new FakeEventBus();
    events.on('subagents:rpc:v1:request', (payload) => {
      const request = payload as { requestId: string };
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: {
          capabilities: { status: true, interrupt: true, stop: true },
          session: { sessionId: 'another-session' },
        },
      });
    });
    await expect(
      connectGateway({ events, sessionId: 'session-1', readyTimeoutMs: 50, requestTimeoutMs: 50 }),
    ).rejects.toThrow('session');
  });

  it('uses advertised events only as wake-ups and removes listeners on dispose', async () => {
    const events = new FakeEventBus();
    const wake = vi.fn();
    events.on('subagents:rpc:v1:request', (payload) => {
      const request = payload as { requestId: string };
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: {
          capabilities: { status: true, interrupt: true, stop: true },
          events: { childStatus: 'subagent:child-status' },
          session: { sessionId: 'session-1' },
        },
      });
    });
    const gateway = await connectGateway({ events, sessionId: 'session-1', readyTimeoutMs: 50, requestTimeoutMs: 50 });
    const unsubscribe = gateway.onWake(wake);
    events.emit('subagent:child-status', { type: 'subagent.child-status', version: 1 });
    expect(wake).toHaveBeenCalledTimes(1);
    unsubscribe();
    gateway.dispose();
    events.emit('subagent:child-status', { type: 'subagent.child-status', version: 1 });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('waits for a ready event when the initial probe times out', async () => {
    const events = new FakeEventBus();
    let requests = 0;
    events.on('subagents:rpc:v1:request', (payload) => {
      requests += 1;
      const request = payload as { requestId: string };
      if (requests === 2) {
        events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          success: true,
          data: {
            capabilities: { status: true, interrupt: false, stop: false },
            session: { sessionId: 'session-1' },
          },
        });
      }
    });
    const connection = connectGateway({ events, sessionId: 'session-1', readyTimeoutMs: 100, requestTimeoutMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.emit('subagents:rpc:v1:ready', { version: 1 });
    await expect(connection).resolves.toMatchObject({ sessionId: 'session-1' });
  });

  it('keeps an unidentifiable foreground observation unconfirmed', async () => {
    const events = new FakeEventBus();
    events.on('subagents:rpc:v1:request', (payload) => {
      const request = payload as { requestId: string; method: string };
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data:
          request.method === 'ping'
            ? { capabilities: { status: true }, session: { sessionId: 'session-1' } }
            : {
                asyncSnapshot: { kind: 'pi-subagents.async-status-snapshot', version: 1, runs: [] },
                fleet: {
                  version: 1,
                  entries: [
                    { state: 'running', kind: 'foreground' },
                    { state: 'running', kind: 'foreground' },
                  ],
                },
              },
      });
    });
    const gateway = await connectGateway({ events, sessionId: 'session-1', readyTimeoutMs: 50, requestTimeoutMs: 50 });
    const snapshot = await gateway.status();
    expect(snapshot.workflows).toHaveLength(0);
    expect(snapshot.unconfirmed).toBe(1);
  });
});
