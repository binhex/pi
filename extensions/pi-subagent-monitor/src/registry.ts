import { advanceClock, activityFingerprint } from './policy';
import type { GatewaySnapshot, LimitResolver, WorkflowRecord } from './types';

export class RunRegistry {
  private readonly records = new Map<string, WorkflowRecord>();

  public constructor(private readonly sessionId: string) {}

  public reconcile(snapshot: GatewaySnapshot, now: number, resolveLimits: LimitResolver): void {
    for (const workflow of snapshot.workflows) {
      if (workflow.sessionId !== this.sessionId) continue;
      const previous = this.records.get(workflow.id);
      const fingerprint = activityFingerprint(workflow);
      if (previous === undefined) {
        this.records.set(workflow.id, {
          snapshot: workflow,
          clock: {
            phase: workflow.state,
            observedAt: now,
            executionMs: 0,
            lastActivityAt: workflow.lastActivityAt,
            activityFingerprint: fingerprint,
          },
          effectiveLimits: resolveLimits(workflow),
          state: 'observed',
          warnedSignals: new Set(),
          retryAttempt: 0,
        });
        continue;
      }
      const clock = advanceClock(previous.clock, workflow.state, now, fingerprint);
      const lastActivityAt = fingerprint === previous.clock.activityFingerprint ? previous.clock.lastActivityAt : now;
      this.records.set(workflow.id, {
        ...previous,
        snapshot: workflow,
        clock: { ...clock, lastActivityAt },
        effectiveLimits: resolveLimits(workflow),
      });
    }
  }

  public get(runId: string): WorkflowRecord | undefined {
    return this.records.get(runId);
  }

  public active(): WorkflowRecord[] {
    return [...this.records.values()].filter(
      (record) => record.snapshot.state === 'queued' || record.snapshot.state === 'running',
    );
  }

  public all(): WorkflowRecord[] {
    return [...this.records.values()];
  }

  public update(record: WorkflowRecord): void {
    this.records.set(record.snapshot.id, record);
  }
}
