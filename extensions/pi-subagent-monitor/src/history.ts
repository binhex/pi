import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HistoryRecord } from './types';

const HISTORY_FIELDS = [
  'version',
  'recordedAt',
  'runId',
  'kind',
  'childCount',
  'durationMs',
  'finalState',
  'trigger',
  'totalTokens',
  'totalCost',
  'toolCalls',
  'turns',
  'controlOutcome',
  'retryAttempts',
] as const;

function redact(record: HistoryRecord): HistoryRecord {
  const source = record as unknown as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const field of HISTORY_FIELDS) {
    if (source[field] !== undefined) clean[field] = source[field];
  }
  return clean as unknown as HistoryRecord;
}

function isHistoryRecord(value: unknown): value is HistoryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.recordedAt === 'number' &&
    typeof record.runId === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.childCount === 'number' &&
    typeof record.durationMs === 'number' &&
    typeof record.finalState === 'string' &&
    typeof record.controlOutcome === 'string' &&
    typeof record.retryAttempts === 'number'
  );
}

export class MetricsStore {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly maxEntries: number,
  ) {}

  public async list(): Promise<HistoryRecord[]> {
    const limit = Math.max(0, Math.floor(this.maxEntries));
    if (limit === 0) return [];
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isHistoryRecord).slice(-limit);
    } catch {
      return [];
    }
  }

  public append(record: HistoryRecord): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const limit = Math.max(0, Math.floor(this.maxEntries));
      if (limit === 0) return;
      const safeRecord = redact(record);
      if (!isHistoryRecord(safeRecord)) throw new Error('invalid monitor history record');
      const records = [...(await this.list()), safeRecord].slice(-limit);
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
    });
    return this.writeChain;
  }
}
