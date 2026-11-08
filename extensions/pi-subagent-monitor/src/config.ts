import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LimitName, LimitOverride, Limits, MonitorConfig } from './types';

export const DEFAULT_CONFIG: MonitorConfig = {
  mode: 'observe',
  limits: {
    wallClockMs: 0,
    inactivityMs: 0,
    tokenCount: 0,
    costUsd: 0,
    toolCalls: 0,
    turns: 0,
    activeToolMs: 0,
  },
  warningLeadMs: 60000,
  terminationGraceMs: 15000,
  pollIntervalMs: 1000,
  retryBaseMs: 30000,
  retryMaxMs: 300000,
  historyMaxEntries: 200,
};

const LIMIT_NAMES: readonly LimitName[] = [
  'wallClockMs',
  'inactivityMs',
  'tokenCount',
  'costUsd',
  'toolCalls',
  'turns',
  'activeToolMs',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const result = nonNegativeInteger(value, field);
  if (result === 0) throw new Error(`${field} must be greater than zero`);
  return result;
}

function parseLimits(value: unknown): Limits {
  if (value === undefined) return { ...DEFAULT_CONFIG.limits };
  if (!isRecord(value)) throw new Error('limits must be an object');
  for (const key of Object.keys(value)) {
    if (!LIMIT_NAMES.includes(key as LimitName)) throw new Error(`unknown limit ${key}`);
  }
  return {
    wallClockMs: nonNegativeInteger(value.wallClockMs ?? 0, 'wallClockMs'),
    inactivityMs: nonNegativeInteger(value.inactivityMs ?? 0, 'inactivityMs'),
    tokenCount: nonNegativeInteger(value.tokenCount ?? 0, 'tokenCount'),
    costUsd: nonNegativeNumber(value.costUsd ?? 0, 'costUsd'),
    toolCalls: nonNegativeInteger(value.toolCalls ?? 0, 'toolCalls'),
    turns: nonNegativeInteger(value.turns ?? 0, 'turns'),
    activeToolMs: nonNegativeInteger(value.activeToolMs ?? 0, 'activeToolMs'),
  };
}

export function parseConfig(value: unknown): MonitorConfig {
  if (value === undefined) return structuredClone(DEFAULT_CONFIG);
  if (!isRecord(value)) throw new Error('config must be an object');
  if (value.mode !== undefined && value.mode !== 'observe' && value.mode !== 'enforce') {
    throw new Error('mode must be observe or enforce');
  }
  return {
    mode: value.mode === 'enforce' ? 'enforce' : 'observe',
    limits: parseLimits(value.limits),
    warningLeadMs: nonNegativeInteger(value.warningLeadMs ?? DEFAULT_CONFIG.warningLeadMs, 'warningLeadMs'),
    terminationGraceMs: nonNegativeInteger(
      value.terminationGraceMs ?? DEFAULT_CONFIG.terminationGraceMs,
      'terminationGraceMs',
    ),
    pollIntervalMs: positiveInteger(value.pollIntervalMs ?? DEFAULT_CONFIG.pollIntervalMs, 'pollIntervalMs'),
    retryBaseMs: positiveInteger(value.retryBaseMs ?? DEFAULT_CONFIG.retryBaseMs, 'retryBaseMs'),
    retryMaxMs: positiveInteger(value.retryMaxMs ?? DEFAULT_CONFIG.retryMaxMs, 'retryMaxMs'),
    historyMaxEntries: nonNegativeInteger(
      value.historyMaxEntries ?? DEFAULT_CONFIG.historyMaxEntries,
      'historyMaxEntries',
    ),
  };
}

export function resolveLimits(global: Limits, override: LimitOverride): Limits {
  const result = { ...global };
  for (const name of LIMIT_NAMES) {
    const requested = override[name];
    if (requested === undefined || requested === 0) continue;
    const valid =
      name === 'costUsd'
        ? typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
        : typeof requested === 'number' && Number.isSafeInteger(requested) && requested >= 0;
    if (!valid) {
      throw new Error(`${name} must be a valid non-negative value`);
    }
    if (global[name] !== 0 && requested > global[name]) {
      throw new Error(`${name} cannot exceed the global ceiling`);
    }
    result[name] = requested;
  }
  return result;
}

export function configPath(home = homedir()): string {
  return join(home, '.pi', 'agent', 'extensions', 'pi-subagent-monitor', 'config.json');
}

export interface ConfigLoadResult {
  config: MonitorConfig;
  error?: string;
}

export async function loadConfig(filePath: string): Promise<ConfigLoadResult> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return { config: parseConfig(JSON.parse(raw) as unknown) };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return { config: structuredClone(DEFAULT_CONFIG) };
    const message = error instanceof Error ? error.message.slice(0, 500) : 'invalid monitor configuration';
    return {
      config: structuredClone(DEFAULT_CONFIG),
      error: `monitor configuration disabled: ${message}`,
    };
  }
}
