import type {
  ChildSnapshot,
  ControlReceipt,
  EventBus,
  GatewayConnection,
  GatewaySnapshot,
  WorkflowSnapshot,
} from '../../src/types';

export class FakeEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set<(payload: unknown) => void>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(event);
    };
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

export function childSnapshot(overrides: Partial<ChildSnapshot> = {}): ChildSnapshot {
  return {
    id: 'step:0',
    state: 'running',
    ...overrides,
  };
}

export function workflowSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    kind: 'background',
    state: 'running',
    startedAt: 1000,
    children: [childSnapshot()],
    processTerminal: 'unknown',
    controlTarget: { kind: 'run', runId: 'run-1' },
    ...overrides,
  };
}

export function gatewaySnapshot(workflows: readonly WorkflowSnapshot[] = [workflowSnapshot()]): GatewaySnapshot {
  return {
    sessionId: 'session-1',
    workflows,
    unconfirmed: 0,
  };
}

export class FakeGateway implements GatewayConnection {
  readonly sessionId = 'session-1';
  readonly capabilities = new Set<'status' | 'interrupt' | 'stop'>(['status', 'interrupt', 'stop']);
  current = gatewaySnapshot();
  readonly interrupted: string[] = [];
  readonly stopped: string[] = [];
  private readonly wakeHandlers = new Set<() => void>();

  async status(): Promise<GatewaySnapshot> {
    return this.current;
  }

  async interrupt(target: { kind: 'run'; runId: string } | { kind: 'foreground-current' }): Promise<ControlReceipt> {
    this.interrupted.push(target.kind === 'run' ? target.runId : 'foreground-current');
    return {
      state: 'accepted',
      runId: target.kind === 'run' ? target.runId : undefined,
      message: 'interrupt accepted',
    };
  }

  async stop(target: { kind: 'run'; runId: string } | { kind: 'foreground-current' }): Promise<ControlReceipt> {
    this.stopped.push(target.kind === 'run' ? target.runId : 'foreground-current');
    return { state: 'accepted', runId: target.kind === 'run' ? target.runId : undefined, message: 'stop accepted' };
  }

  onWake(handler: () => void): () => void {
    this.wakeHandlers.add(handler);
    return () => this.wakeHandlers.delete(handler);
  }

  wake(): void {
    for (const handler of this.wakeHandlers) handler();
  }

  dispose(): void {
    this.wakeHandlers.clear();
  }
}
