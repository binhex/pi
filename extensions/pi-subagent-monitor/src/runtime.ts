import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { dirname, join } from 'node:path';
import { configPath, DEFAULT_CONFIG, loadConfig, type ConfigLoadResult, resolveLimits } from './config';
import { connectGateway } from './gateway';
import { evaluatePolicy } from './policy';
import { MetricsStore } from './history';
import { RunRegistry } from './registry';
import { TerminationCoordinator } from './termination';
import { formatStatus, notificationKey, notifyOnce, type MonitorUi } from './presentation';
import { createLaunchWrapper, parseLaunchArgs, type LaunchWrapper } from './wrapper';
import type {
  GatewayConnection,
  HistoryRecord,
  LaunchRequest,
  Limits,
  MonitorConfig,
  MonitorMode,
  WorkflowRecord,
} from './types';

export interface RuntimeDependencies {
  loadConfig(): Promise<ConfigLoadResult>;
  connectGateway(sessionId: string): Promise<GatewayConnection>;
  createRegistry(sessionId: string): RunRegistry;
  createHistory(config: MonitorConfig): MetricsStore;
  createWrapper(
    sessionId: string,
    globalLimits: Limits,
    associate: (runId: string, limits: Limits) => void,
    cwd: string,
  ): LaunchWrapper;
  ui(ctx: ExtensionContext): MonitorUi;
  now(): number;
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const STATUS_KEY = 'subagent-monitor';
const MAX_OUTPUT = 2000;
const LIMIT_NAMES = [
  'wallClockMs',
  'inactivityMs',
  'tokenCount',
  'costUsd',
  'toolCalls',
  'turns',
  'activeToolMs',
] as const;

type LimitName = (typeof LIMIT_NAMES)[number];

function boundedMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_OUTPUT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedRunId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\r\n]/.test(value)) {
    throw new Error('runId must be a bounded string');
  }
  return value;
}

function statusText(mode: MonitorMode, registry: RunRegistry | undefined, now: number, unconfirmed: number): string {
  return formatStatus(mode, registry?.all() ?? [], now, unconfirmed) ?? mode;
}

function parseLimitOverride(value: unknown): Partial<Limits> {
  if (!isRecord(value)) throw new Error('limits must be an object');
  const result: Partial<Limits> = {};
  for (const key of Object.keys(value)) {
    if (!(LIMIT_NAMES as readonly string[]).includes(key)) throw new Error(`unknown limit ${key}`);
    const candidate = value[key];
    if (key === 'costUsd') {
      if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0)
        throw new Error(`${key} must be finite and non-negative`);
    } else if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new Error(`${key} must be a non-negative safe integer`);
    }
    result[key as LimitName] = candidate as never;
  }
  return result;
}

export class MonitorRuntime {
  private config: MonitorConfig = structuredClone(DEFAULT_CONFIG);
  private gateway: GatewayConnection | undefined;
  private registry: RunRegistry | undefined;
  private metrics: MetricsStore | undefined;
  private wrapper: LaunchWrapper | undefined;
  private termination: TerminationCoordinator | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private wakeDispose: (() => void) | undefined;
  private ui: MonitorUi | undefined;
  private started = false;
  private stopped = false;
  private inert = false;
  private generation = 0;
  private unconfirmed = 0;
  private readonly persisted = new Set<string>();
  private readonly notificationKeys = new Set<string>();
  private readonly runPolicies = new Map<string, Limits>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  public constructor(private readonly dependencies: RuntimeDependencies) {}

  public async start(ctx: ExtensionContext): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.inert = ctx.mode !== 'tui' && ctx.mode !== 'rpc';
    this.generation += 1;
    const generation = this.generation;
    this.ui = this.dependencies.ui(ctx);
    const loaded = await this.dependencies.loadConfig();
    if (generation !== this.generation) return;
    this.config = loaded.config;
    if (loaded.error) this.ui.notify(boundedMessage(loaded.error), 'error');
    if (this.inert) return;

    const sessionId = ctx.sessionManager.getSessionId();
    this.registry = this.dependencies.createRegistry(sessionId);
    this.metrics = this.dependencies.createHistory(this.config);
    this.wrapper = this.dependencies.createWrapper(
      sessionId,
      this.config.limits,
      (runId, limits) => this.associatePolicy(runId, limits),
      ctx.cwd,
    );
    try {
      this.gateway = await this.dependencies.connectGateway(sessionId);
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      const message = error instanceof Error ? error.message.slice(0, 500) : 'pi-subagents gateway unavailable';
      this.ui.notify(`Subagent monitor degraded: ${boundedMessage(message)}`, 'error');
      this.ui.setStatus(STATUS_KEY, 'degraded');
      return;
    }
    if (generation !== this.generation || this.stopped) {
      this.gateway.dispose();
      this.gateway = undefined;
      return;
    }
    this.termination = new TerminationCoordinator({
      gateway: this.gateway,
      get: (runId) => this.registry?.get(runId),
      reconcile: () => this.reconcile(this.dependencies.now()),
      sleep: (delayMs) =>
        new Promise((resolve) => {
          this.dependencies.setTimeout(resolve, Math.max(0, delayMs));
        }),
      now: () => this.dependencies.now(),
      graceMs: this.config.terminationGraceMs,
      retryBaseMs: this.config.retryBaseMs,
      retryMaxMs: this.config.retryMaxMs,
      onState: (runId, state) => this.setMonitorState(runId, state),
    });
    this.wakeDispose = this.gateway.onWake(() => {
      if (generation !== this.generation || this.stopped) return;
      void this.reconcile(this.dependencies.now()).catch((error) => this.reportError(error));
    });
    this.interval = this.dependencies.setInterval(() => {
      if (generation !== this.generation || this.stopped) return;
      void this.reconcile(this.dependencies.now()).catch((error) => this.reportError(error));
    }, this.config.pollIntervalMs);
    try {
      await this.reconcile(this.dependencies.now());
    } catch (error) {
      this.reportError(error);
    }
  }

  public async reconcile(now: number): Promise<void> {
    if (this.inert || this.stopped || this.gateway === undefined || this.registry === undefined) return;
    const snapshot = await this.gateway.status();
    if (this.stopped) return;
    this.unconfirmed = snapshot.unconfirmed;
    this.registry.reconcile(snapshot, now, (workflow) => this.resolveLimits(workflow.id));
    for (const record of this.registry.active()) await this.evaluate(record, now);
    await this.persistTerminalRecords(now);
    this.render(now);
  }

  public async stop(): Promise<void> {
    if (!this.started && this.stopped) return;
    this.generation += 1;
    await this.persistTerminalRecords(this.dependencies.now(), true);
    this.stopped = true;
    this.started = false;
    this.inert = false;
    if (this.interval !== undefined) this.dependencies.clearInterval(this.interval);
    this.interval = undefined;
    this.wakeDispose?.();
    this.wakeDispose = undefined;
    for (const timer of this.retryTimers.values()) this.dependencies.clearTimeout(timer);
    this.retryTimers.clear();
    this.termination?.dispose();
    this.termination = undefined;
    this.gateway?.dispose();
    this.gateway = undefined;
    this.ui?.setStatus(STATUS_KEY, undefined);
  }

  public mode(): MonitorMode {
    return this.config.mode;
  }

  public associatePolicy(runId: string, limits: Limits): void {
    try {
      this.runPolicies.set(boundedRunId(runId), { ...limits });
    } catch {
      // A malformed public association is not a safe workflow identity and is
      // intentionally ignored rather than mapped onto another run.
    }
  }

  public async status(ctx: ExtensionCommandContext): Promise<void> {
    const text = statusText(this.config.mode, this.registry, this.dependencies.now(), this.unconfirmed);
    ctx.ui.notify(boundedMessage(text), 'info');
  }

  public async setMode(mode: MonitorMode, ctx: ExtensionCommandContext): Promise<void> {
    if (mode !== 'observe' && mode !== 'enforce') {
      ctx.ui.notify('Monitor mode must be observe or enforce.', 'warning');
      return;
    }
    this.config = { ...this.config, mode };
    if (mode === 'observe') {
      for (const timer of this.retryTimers.values()) this.dependencies.clearTimeout(timer);
      this.retryTimers.clear();
    }
    ctx.ui.notify(`Subagent monitor mode: ${mode}.`, 'info');
    this.render(this.dependencies.now());
  }

  public async history(ctx: ExtensionCommandContext): Promise<void> {
    if (this.metrics === undefined) {
      ctx.ui.notify('Subagent monitor history is unavailable before session start.', 'warning');
      return;
    }
    try {
      const entries = await this.metrics.list();
      if (entries.length === 0) {
        ctx.ui.notify('Subagent monitor history is empty.', 'info');
        return;
      }
      const lines = entries.slice(-this.config.historyMaxEntries).map((entry) => {
        const trigger = entry.trigger === undefined ? '' : ` trigger=${entry.trigger}`;
        return `${entry.recordedAt} ${entry.runId} ${entry.finalState} ${entry.durationMs}ms${trigger}`;
      });
      ctx.ui.notify(boundedMessage(lines.join('\n')), 'info');
    } catch (error) {
      ctx.ui.notify(
        `Unable to read monitor history: ${boundedMessage(error instanceof Error ? error.message : 'unknown error')}`,
        'error',
      );
    }
  }

  public async extend(args: string, ctx: ExtensionCommandContext): Promise<void> {
    let parsed: unknown;
    try {
      parsed = parseLaunchArgs(args);
    } catch (error) {
      ctx.ui.notify(
        boundedMessage(error instanceof Error ? error.message : 'extend arguments must be valid JSON'),
        'warning',
      );
      return;
    }
    if (!isRecord(parsed)) {
      ctx.ui.notify('Usage: /subagent-monitor extend {"runId":"...","limits":{...}}', 'warning');
      return;
    }
    let runId: string;
    try {
      runId = boundedRunId(parsed.runId);
    } catch {
      ctx.ui.notify('extend requires a bounded runId.', 'warning');
      return;
    }
    const record = this.registry?.get(runId);
    if (record === undefined || (record.snapshot.state !== 'queued' && record.snapshot.state !== 'running')) {
      ctx.ui.notify('extend requires an active monitored workflow.', 'warning');
      return;
    }
    const extensionKeys = new Set(['runId', 'limits', ...LIMIT_NAMES]);
    if (Object.keys(parsed).some((key) => !extensionKeys.has(key))) {
      ctx.ui.notify('extend contains an unsupported field.', 'warning');
      return;
    }
    const rawLimits = parsed.limits ?? Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'runId'));
    let effective: Limits;
    try {
      effective = resolveLimits(this.config.limits, parseLimitOverride(rawLimits));
    } catch (error) {
      ctx.ui.notify(boundedMessage(error instanceof Error ? error.message : 'invalid extension policy'), 'warning');
      return;
    }
    const increased = (Object.keys(effective) as Array<keyof Limits>).some(
      (key) => effective[key] > record.effectiveLimits[key],
    );
    if (!increased) {
      ctx.ui.notify('extend must raise at least one finite active limit.', 'warning');
      return;
    }
    const confirmed = await ctx.ui.confirm(
      'Extend monitored workflow?',
      `Raise limits for ${runId} within the configured global ceilings?`,
    );
    if (!confirmed) {
      ctx.ui.notify('Monitor extension cancelled.', 'info');
      return;
    }
    this.associatePolicy(runId, effective);
    record.effectiveLimits = effective;
    this.registry?.update(record);
    ctx.ui.notify(`Monitor limits extended for ${runId}.`, 'info');
  }

  public async run(args: string, ctx: ExtensionCommandContext): Promise<void> {
    let parsed: unknown;
    try {
      parsed = parseLaunchArgs(args);
      if (!this.wrapper) throw new Error('monitor session has not started');
      const receipt = await this.wrapper.launch(parsed as LaunchRequest);
      const run = receipt.runId === undefined ? '' : ` ${receipt.runId}`;
      ctx.ui.notify(`Subagent launch ${receipt.state}.${run}`, 'info');
    } catch (error) {
      ctx.ui.notify(
        `Subagent launch rejected: ${boundedMessage(error instanceof Error ? error.message : 'invalid launch')}`,
        'warning',
      );
    }
  }

  public toolStatus(): { content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> } {
    const text = statusText(this.config.mode, this.registry, this.dependencies.now(), this.unconfirmed);
    return {
      content: [{ type: 'text', text: boundedMessage(text) }],
      details: {
        mode: this.config.mode,
        activeWorkflows: this.registry?.active().length ?? 0,
        unconfirmed: this.unconfirmed,
      },
    };
  }

  public async toolRun(
    request: unknown,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
    try {
      if (!this.wrapper) throw new Error('monitor session has not started');
      const receipt = await this.wrapper.launch(request as LaunchRequest);
      return {
        content: [{ type: 'text', text: boundedMessage(`Subagent launch ${receipt.state}.`) }],
        details: {
          requestId: receipt.requestId,
          ...(receipt.runId === undefined ? {} : { runId: receipt.runId }),
          effectiveLimits: receipt.effectiveLimits,
        },
      };
    } catch (error) {
      ctx.ui.notify(
        `Subagent launch rejected: ${boundedMessage(error instanceof Error ? error.message : 'invalid launch')}`,
        'warning',
      );
      return {
        content: [{ type: 'text', text: 'Subagent launch rejected.' }],
        details: { state: 'rejected' },
      };
    }
  }

  private resolveLimits(runId: string): Limits {
    return this.runPolicies.get(runId) ?? this.config.limits;
  }

  private async evaluate(record: WorkflowRecord, now: number): Promise<void> {
    const evaluation = evaluatePolicy({
      now,
      executionMs: record.clock.executionMs,
      lastActivityAt: record.clock.lastActivityAt,
      currentToolStartedAt: record.snapshot.currentToolStartedAt,
      totalTokens: record.snapshot.totalTokens,
      totalCost: record.snapshot.totalCost,
      toolCalls: record.snapshot.toolCount,
      turns: record.snapshot.turnCount,
      limits: record.effectiveLimits,
      warningLeadMs: this.config.warningLeadMs,
    });
    const warnedSignals = new Set(record.warnedSignals);
    for (const missing of evaluation.missing) {
      notifyOnce(
        this.notificationKeys,
        notificationKey(record.snapshot.id, missing, 'missing'),
        (message, level) => this.ui?.notify(message, level),
        `Workflow ${record.snapshot.id}: ${missing} usage is unavailable; the monitor will not infer a breach.`,
        'error',
      );
    }
    for (const warning of evaluation.warnings) {
      if (warnedSignals.has(warning.signal) || this.ui === undefined) continue;
      warnedSignals.add(warning.signal);
      notifyOnce(
        this.notificationKeys,
        notificationKey(record.snapshot.id, warning.signal, 'warning'),
        (message, level) => this.ui?.notify(message, level),
        `Workflow ${record.snapshot.id}: ${warning.signal} is near its limit (${warning.used}/${warning.limit}).`,
        'warning',
      );
    }
    record.warnedSignals = warnedSignals;
    if (evaluation.warnings.length > 0 && record.state === 'observed') record.state = 'warning';
    if (
      evaluation.breach === undefined ||
      this.config.mode !== 'enforce' ||
      record.state === 'terminating' ||
      record.state === 'unknown-control' ||
      record.state === 'confirmed'
    ) {
      this.registry?.update(record);
      return;
    }
    record.breach = evaluation.breach;
    record.state = 'terminating';
    this.registry?.update(record);
    notifyOnce(
      this.notificationKeys,
      notificationKey(record.snapshot.id, evaluation.breach.signal, 'breach'),
      (message, level) => this.ui?.notify(message, level),
      `Workflow ${record.snapshot.id}: ${evaluation.breach.signal} breached; documented controls are being attempted.`,
      'error',
    );
    if (this.termination === undefined) return;
    const result = await this.termination.breach(record, evaluation.breach);
    const current = this.registry?.get(record.snapshot.id) ?? record;
    current.retryAttempt = result.retryAttempt;
    current.state = result.state === 'confirmed' ? 'confirmed' : 'unknown-control';
    this.registry?.update(current);
    if (result.state === 'confirmed') {
      notifyOnce(
        this.notificationKeys,
        notificationKey(record.snapshot.id, evaluation.breach.signal, 'confirmed'),
        (message, level) => this.ui?.notify(message, level),
        `Workflow ${record.snapshot.id}: terminal state confirmed after monitor control.`,
        'info',
      );
    }
    if (result.state === 'unknown-control') this.scheduleRetry(current);
  }

  private scheduleRetry(record: WorkflowRecord): void {
    if (this.retryTimers.has(record.snapshot.id) || this.termination === undefined || this.config.mode !== 'enforce')
      return;
    const delay = Math.min(
      Math.max(0, this.config.retryMaxMs),
      Math.max(0, this.config.retryBaseMs) * 2 ** Math.max(0, record.retryAttempt),
    );
    const timer = this.dependencies.setTimeout(() => {
      this.retryTimers.delete(record.snapshot.id);
      if (this.stopped || this.config.mode !== 'enforce' || this.termination === undefined) return;
      void (async () => {
        try {
          await this.reconcile(this.dependencies.now());
          const current = this.registry?.get(record.snapshot.id);
          if (
            current === undefined ||
            current.snapshot.state === 'complete' ||
            current.snapshot.state === 'failed' ||
            current.snapshot.state === 'partial' ||
            current.snapshot.state === 'stopped' ||
            current.snapshot.state === 'rejected'
          )
            return;
          const next = { ...current, retryAttempt: current.retryAttempt + 1 };
          const breach = next.breach;
          if (breach === undefined) return;
          const termination = this.termination;
          if (termination === undefined) return;
          const result = await termination.breach(next, breach);
          const registry = this.registry;
          if (registry === undefined) return;
          const updated = registry.get(record.snapshot.id);
          if (updated === undefined) return;
          updated.retryAttempt = result.retryAttempt;
          updated.state = result.state === 'confirmed' ? 'confirmed' : 'unknown-control';
          registry.update(updated);
          if (result.state === 'confirmed') {
            notifyOnce(
              this.notificationKeys,
              notificationKey(updated.snapshot.id, breach.signal, 'confirmed'),
              (message, level) => this.ui?.notify(message, level),
              `Workflow ${updated.snapshot.id}: terminal state confirmed after monitor retry.`,
              'info',
            );
          }
          if (result.state === 'unknown-control') this.scheduleRetry(updated);
          this.render(this.dependencies.now());
        } catch (error) {
          this.reportError(error);
        }
      })();
    }, delay);
    this.retryTimers.set(record.snapshot.id, timer);
  }

  private async persistTerminalRecords(now: number, includeUnresolved = false): Promise<void> {
    if (this.registry === undefined || this.metrics === undefined) return;
    for (const record of this.registry.all()) {
      const state = record.snapshot.state;
      const terminal =
        state === 'complete' ||
        state === 'failed' ||
        state === 'partial' ||
        state === 'stopped' ||
        state === 'rejected' ||
        (includeUnresolved && record.state === 'unknown-control');
      if (!terminal || this.persisted.has(record.snapshot.id)) continue;
      const finalState: HistoryRecord['finalState'] =
        state === 'complete' || state === 'failed' || state === 'stopped' ? state : record.state;
      const historyRecord: HistoryRecord = {
        version: 1,
        recordedAt: now,
        runId: record.snapshot.id,
        kind: record.snapshot.kind,
        childCount: record.snapshot.children.length,
        durationMs: record.clock.executionMs,
        finalState,
        ...(record.breach === undefined ? {} : { trigger: record.breach.signal }),
        ...(record.snapshot.totalTokens === undefined ? {} : { totalTokens: record.snapshot.totalTokens }),
        ...(record.snapshot.totalCost === undefined ? {} : { totalCost: record.snapshot.totalCost }),
        ...(record.snapshot.toolCount === undefined ? {} : { toolCalls: record.snapshot.toolCount }),
        ...(record.snapshot.turnCount === undefined ? {} : { turns: record.snapshot.turnCount }),
        controlOutcome:
          record.state === 'confirmed' ? 'confirmed' : record.state === 'unknown-control' ? 'unknown' : 'not-needed',
        retryAttempts: record.retryAttempt,
      };
      try {
        await this.metrics.append(historyRecord);
        this.persisted.add(record.snapshot.id);
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'monitor reconciliation failed';
    notifyOnce(
      this.notificationKeys,
      notificationKey('monitor', 'gateway', 'degraded'),
      (notice, level) => this.ui?.notify(notice, level),
      `Subagent monitor degraded: ${boundedMessage(message)}`,
      'error',
    );
    this.ui?.setStatus(STATUS_KEY, 'degraded');
  }

  private setMonitorState(runId: string, state: 'terminating' | 'confirmed' | 'unknown-control'): void {
    const record = this.registry?.get(runId);
    if (record === undefined) return;
    record.state = state;
    this.registry?.update(record);
    if (state === 'unknown-control') {
      notifyOnce(
        this.notificationKeys,
        notificationKey(runId, 'gateway', 'unknown-control'),
        (message, level) => this.ui?.notify(message, level),
        `Workflow ${runId}: control is unconfirmed; Pi remains open and documented manual recovery is required.`,
        'error',
      );
    }
  }

  private render(now: number): void {
    if (this.registry === undefined || this.ui === undefined) return;
    this.ui.setStatus(STATUS_KEY, formatStatus(this.config.mode, this.registry.all(), now, this.unconfirmed));
  }
}

export function createMonitorRuntime(pi: ExtensionAPI): MonitorRuntime {
  const configFile = configPath();
  const historyFile = join(dirname(configFile), 'history.json');
  return new MonitorRuntime({
    loadConfig: () => loadConfig(configFile),
    connectGateway: (sessionId) =>
      connectGateway({
        events: pi.events,
        sessionId,
        readyTimeoutMs: 2000,
        requestTimeoutMs: 2000,
      }),
    createRegistry: (sessionId) => new RunRegistry(sessionId),
    createHistory: (config) => new MetricsStore(historyFile, config.historyMaxEntries),
    createWrapper: (sessionId, globalLimits, associate, cwd) =>
      createLaunchWrapper({
        events: pi.events,
        sessionId,
        cwd,
        globalLimits,
        associate,
      }),
    ui: (ctx) => ctx.ui,
    now: () => Date.now(),
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: (timer) => clearInterval(timer),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
  });
}
