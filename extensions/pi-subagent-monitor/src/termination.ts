import type { ControlReceipt, GatewayConnection, PolicyBreach, WorkflowRecord } from './types';

export interface TerminationOptions {
  gateway: GatewayConnection;
  get(runId: string): WorkflowRecord | undefined;
  reconcile(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  graceMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  onState(runId: string, state: 'terminating' | 'confirmed' | 'unknown-control'): void;
}

export interface TerminationResult {
  state: 'confirmed' | 'unknown-control' | 'failed';
  control: 'confirmed' | 'unknown' | 'failed';
  retryAttempt: number;
  message: string;
}

const TERMINAL_STATES = new Set(['complete', 'failed', 'partial', 'stopped', 'rejected']);

export class TerminationCoordinator {
  private readonly pending = new Set<string>();
  private disposed = false;

  public constructor(private readonly options: TerminationOptions) {}

  public dispose(): void {
    this.disposed = true;
    this.pending.clear();
  }

  public async breach(record: WorkflowRecord, breach: PolicyBreach): Promise<TerminationResult> {
    const runId = record.snapshot.id;
    if (this.disposed) return this.disposedResult(record);
    if (this.pending.has(runId)) {
      return {
        state: 'unknown-control',
        control: 'unknown',
        retryAttempt: record.retryAttempt,
        message: 'termination already pending',
      };
    }
    this.pending.add(runId);
    this.options.onState(runId, 'terminating');
    try {
      const graceful = await this.options.gateway.interrupt(record.snapshot.controlTarget);
      if (this.disposed) return this.disposedResult(record);
      await this.options.reconcile();
      if (this.disposed) return this.disposedResult(record);
      if (this.isConfirmed(runId)) return this.confirmed(runId, graceful, record.retryAttempt);

      await this.options.sleep(Math.max(0, this.options.graceMs));
      if (this.disposed) return this.disposedResult(record);
      await this.options.reconcile();
      if (this.disposed) return this.disposedResult(record);
      if (this.isConfirmed(runId)) return this.confirmed(runId, graceful, record.retryAttempt);

      // A current foreground run only exposes interrupt semantics. A detached
      // run may advertise a stronger stop control through the public gateway.
      if (record.snapshot.controlTarget.kind === 'foreground-current') {
        return this.unknown(runId, record.retryAttempt, `limit ${breach.signal} remains unconfirmed`);
      }
      const escalated = await this.options.gateway.stop(record.snapshot.controlTarget);
      if (this.disposed) return this.disposedResult(record);
      await this.options.reconcile();
      if (this.disposed) return this.disposedResult(record);
      if (this.isConfirmed(runId)) return this.confirmed(runId, escalated, record.retryAttempt);
      return this.unknown(runId, record.retryAttempt, `limit ${breach.signal} remains unconfirmed`, escalated);
    } catch (error) {
      if (this.disposed) return this.disposedResult(record);
      this.options.onState(runId, 'unknown-control');
      return {
        state: 'unknown-control',
        control: 'failed',
        retryAttempt: record.retryAttempt,
        message: error instanceof Error ? error.message.slice(0, 500) : 'termination control failed',
      };
    } finally {
      this.pending.delete(runId);
    }
  }

  public async retry(record: WorkflowRecord): Promise<TerminationResult> {
    if (record.breach === undefined) {
      return {
        state: 'failed',
        control: 'failed',
        retryAttempt: record.retryAttempt,
        message: 'cannot retry termination without an original breach',
      };
    }
    if (this.disposed) return this.disposedResult(record);
    if (this.isConfirmed(record.snapshot.id)) {
      this.options.onState(record.snapshot.id, 'confirmed');
      return {
        state: 'confirmed',
        control: 'confirmed',
        retryAttempt: record.retryAttempt,
        message: 'workflow is already terminal',
      };
    }
    const retryAttempt = record.retryAttempt + 1;
    const base = Math.max(0, this.options.retryBaseMs);
    const max = Math.max(base, this.options.retryMaxMs);
    const delay = Math.min(max, base * 2 ** Math.max(0, record.retryAttempt));
    await this.options.sleep(delay);
    if (this.disposed) return this.disposedResult({ ...record, retryAttempt });
    return this.breach({ ...record, retryAttempt }, record.breach);
  }

  private disposedResult(record: WorkflowRecord): TerminationResult {
    return {
      state: 'failed',
      control: 'failed',
      retryAttempt: record.retryAttempt,
      message: 'termination coordinator disposed',
    };
  }

  private isConfirmed(runId: string): boolean {
    const current = this.options.get(runId);
    if (current === undefined) return false;
    return TERMINAL_STATES.has(current.snapshot.state) && current.snapshot.processTerminal === 'observed';
  }

  private confirmed(runId: string, receipt: ControlReceipt, retryAttempt: number): TerminationResult {
    this.options.onState(runId, 'confirmed');
    return {
      state: 'confirmed',
      control: receipt.state === 'accepted' ? 'confirmed' : 'unknown',
      retryAttempt,
      message: receipt.message,
    };
  }

  private unknown(runId: string, retryAttempt: number, message: string, receipt?: ControlReceipt): TerminationResult {
    this.options.onState(runId, 'unknown-control');
    return {
      state: 'unknown-control',
      control: receipt?.state === 'rejected' ? 'failed' : receipt?.state === 'accepted' ? 'unknown' : 'unknown',
      retryAttempt,
      message,
    };
  }
}
