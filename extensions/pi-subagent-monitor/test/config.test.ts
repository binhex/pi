import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, parseConfig, resolveLimits } from '../src/config';

const zeroLimits = {
  wallClockMs: 0,
  inactivityMs: 0,
  tokenCount: 0,
  costUsd: 0,
  toolCalls: 0,
  turns: 0,
  activeToolMs: 0,
};

describe('configuration', () => {
  it('defaults to observe mode with every safety limit disabled', () => {
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.mode).toBe('observe');
    expect(DEFAULT_CONFIG.limits).toEqual(zeroLimits);
  });

  it('rejects malformed modes and limit values', () => {
    expect(() => parseConfig({ mode: 'active' })).toThrow('mode');
    expect(() => parseConfig({ limits: { wallClockMs: -1 } })).toThrow('wallClockMs');
    expect(() => parseConfig({ limits: { turns: 1.5 } })).toThrow('turns');
    expect(() => parseConfig({ limits: { unknown: 10 } })).toThrow('unknown');
    expect(() => parseConfig({ pollIntervalMs: 0 })).toThrow('pollIntervalMs');
  });

  it('fills omitted fields while accepting explicit zero values', () => {
    const config = parseConfig({ mode: 'enforce', limits: { wallClockMs: 60000 } });
    expect(config.mode).toBe('enforce');
    expect(config.limits.wallClockMs).toBe(60000);
    expect(config.limits.inactivityMs).toBe(0);
    expect(config.warningLeadMs).toBe(60000);
  });

  it('inherits zero overrides and allows a stricter finite run cap', () => {
    const global = {
      wallClockMs: 600000,
      inactivityMs: 120000,
      tokenCount: 100000,
      costUsd: 5,
      toolCalls: 100,
      turns: 20,
      activeToolMs: 90000,
    };
    const effective = resolveLimits(global, {
      wallClockMs: 300000,
      inactivityMs: 0,
      tokenCount: 0,
      costUsd: 2,
      toolCalls: 0,
      turns: 10,
      activeToolMs: 0,
    });
    expect(effective).toEqual({
      wallClockMs: 300000,
      inactivityMs: 120000,
      tokenCount: 100000,
      costUsd: 2,
      toolCalls: 100,
      turns: 10,
      activeToolMs: 90000,
    });
  });

  it('rejects an override that relaxes a non-zero global ceiling', () => {
    expect(() => resolveLimits({ ...zeroLimits, wallClockMs: 600000 }, { wallClockMs: 600001 })).toThrow('wallClockMs');
  });

  it('falls back safely for a missing or malformed config file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-monitor-config-'));
    const missing = await loadConfig(join(directory, 'missing.json'));
    expect(missing.config).toEqual(DEFAULT_CONFIG);
    expect(missing.error).toBeUndefined();
    const malformedPath = join(directory, 'malformed.json');
    await writeFile(malformedPath, '{not-json', 'utf8');
    const malformed = await loadConfig(malformedPath);
    expect(malformed.config).toEqual(DEFAULT_CONFIG);
    expect(malformed.error).toContain('monitor configuration disabled');
  });
});
