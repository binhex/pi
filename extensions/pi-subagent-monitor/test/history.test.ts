import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MetricsStore } from '../src/history';
import type { HistoryRecord } from '../src/types';

describe('metrics history', () => {
  it('writes only allowed metrics and prunes oldest records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-monitor-history-'));
    const store = new MetricsStore(join(directory, 'history.json'), 2);
    const first: HistoryRecord = {
      version: 1,
      recordedAt: 1,
      runId: 'run-1',
      kind: 'background',
      childCount: 1,
      durationMs: 100,
      finalState: 'complete',
      controlOutcome: 'not-needed',
      retryAttempts: 0,
    };
    const second = { ...first, recordedAt: 2, runId: 'run-2' };
    const third = { ...first, recordedAt: 3, runId: 'run-3' };
    await store.append(first);
    await store.append(second);
    await store.append(third);
    const records = await store.list();
    expect(records.map((record) => record.runId)).toEqual(['run-2', 'run-3']);
    const raw = await readFile(join(directory, 'history.json'), 'utf8');
    expect(raw).not.toContain('task text');
    expect(raw).not.toContain('session-file');
  });

  it('drops forbidden fields before persistence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-monitor-history-'));
    const store = new MetricsStore(join(directory, 'history.json'), 10);
    await store.append({
      version: 1,
      recordedAt: 1,
      runId: 'run-1',
      kind: 'foreground',
      childCount: 0,
      durationMs: 10,
      finalState: 'unknown-control',
      controlOutcome: 'unknown',
      retryAttempts: 1,
      task: 'secret task text',
      cwd: '/private/project',
      transcript: 'model output',
    } as HistoryRecord & Record<string, unknown>);
    const record = (await store.list())[0] as unknown as Record<string, unknown>;
    expect(record.task).toBeUndefined();
    expect(record.cwd).toBeUndefined();
    expect(record.transcript).toBeUndefined();
  });
});
