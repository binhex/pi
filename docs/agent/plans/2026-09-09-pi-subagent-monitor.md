# pi-subagent-monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sub-agents
> (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Build a standalone Pi extension that observes current-session
`pi-subagents` workflows, reports bounded safety telemetry, and stops an
affected workflow when explicitly configured limits are breached.

**Architecture:** Use a small domain core with a public pi-subagents event-bus
RPC adapter, a snapshot registry, a pure policy engine, a termination state
machine, a metrics-only history store, and a Pi presentation/runtime layer. Add
a validated wrapper for per-run policies only through documented foreground
single-child delegation and detached launch APIs; direct `subagent` calls remain
covered by the global observer.

**Tech Stack:** TypeScript, Pi `ExtensionAPI`, TypeBox, `@earendil-works/pi-ai`
`StringEnum`, Vitest, Node `fs/promises`, and the documented `pi-subagents`
RPC/event contracts.

---

<!-- markdownlint-disable MD013 -->

## Scope decision

The approved specification contains two visible features: automatic workflow
supervision and an explicit launch wrapper. They remain in one plan because both
depend on the same gateway, identity, policy, registry, and termination
contracts. The wrapper has no useful independent behavior without the
supervisor’s policy/runtime state, so splitting it into a second plan would
duplicate those interfaces and weaken end-to-end testing.

The work is still split into independently testable modules. Tasks 1–8 establish
the observer and safety guard; Task 9 adds the wrapper; Task 10 wires the
extension lifecycle; Task 11 documents installation and operation; Task 12 runs
the complete quality gate.

The repository-specific agent instructions require generated plans under
`docs/agent/plans/`, so this plan uses that directory rather than the generic
`docs/plans/` location. Do not modify the existing untracked
`extensions/pi-chat/` tree or the existing `extensions/pi-prompt-queue`
implementation.

## File map

### New package files

- `extensions/pi-subagent-monitor/package.json` — package metadata, scripts,
  Pi entrypoint, dependencies, and published files.
- `extensions/pi-subagent-monitor/package-lock.json` — generated npm lockfile.
- `extensions/pi-subagent-monitor/.gitignore` — ignores package-local
  `node_modules/`.
- `extensions/pi-subagent-monitor/.prettierrc` — repository TypeScript format.
- `extensions/pi-subagent-monitor/tsconfig.json` — strict source/test compiler
  settings.
- `extensions/pi-subagent-monitor/vitest.config.ts` — Node test configuration.
- `extensions/pi-subagent-monitor/src/types.ts` — shared domain contracts.
- `extensions/pi-subagent-monitor/src/config.ts` — config loading, validation,
  defaults, and policy merging.
- `extensions/pi-subagent-monitor/src/policy.ts` — clocks, activity, thresholds,
  and limit evaluation.
- `extensions/pi-subagent-monitor/src/gateway.ts` — public pi-subagents RPC and
  event-bus adapter.
- `extensions/pi-subagent-monitor/src/registry.ts` — workflow records, lineage,
  clocks, and reconciliation.
- `extensions/pi-subagent-monitor/src/history.ts` — redacted bounded metrics.
- `extensions/pi-subagent-monitor/src/termination.ts` — control state machine,
  verification, and retry.
- `extensions/pi-subagent-monitor/src/presentation.ts` — status and notices.
- `extensions/pi-subagent-monitor/src/commands.ts` — operator commands.
- `extensions/pi-subagent-monitor/src/wrapper.ts` — launch schema and wrapper.
- `extensions/pi-subagent-monitor/src/runtime.ts` — session orchestration.
- `extensions/pi-subagent-monitor/src/index.ts` — Pi factory and registrations.

### New tests

- `extensions/pi-subagent-monitor/test/support/fakes.ts` — deterministic bus,
  gateway, clock, UI, and snapshot fixtures.
- `extensions/pi-subagent-monitor/test/config.test.ts` — config and merge rules.
- `extensions/pi-subagent-monitor/test/policy.test.ts` — clocks, activity,
  warnings, breaches, and missing usage.
- `extensions/pi-subagent-monitor/test/gateway.test.ts` — handshake, validation,
  normalization, wake-ups, and failures.
- `extensions/pi-subagent-monitor/test/registry.test.ts` — identity,
  reconciliation, pause/resume, and session filtering.
- `extensions/pi-subagent-monitor/test/history.test.ts` — redaction, retention,
  permissions, and malformed-file recovery.
- `extensions/pi-subagent-monitor/test/termination.test.ts` — tree control,
  grace/escalation, proof, retries, and no parent shutdown.
- `extensions/pi-subagent-monitor/test/presentation.test.ts` — status and notice
  formatting, deduplication, and sensitive-text exclusion.
- `extensions/pi-subagent-monitor/test/commands.test.ts` — operator command
  routing and invalid-input feedback.
- `extensions/pi-subagent-monitor/test/wrapper.test.ts` — launch validation,
  policy association, public payloads, and unsupported modes.
- `extensions/pi-subagent-monitor/test/runtime.test.ts` — lifecycle, polling,
  mode changes, and fake end-to-end workflow flow.
- `extensions/pi-subagent-monitor/test/index.test.ts` — factory registrations.

### Existing files

- `/data/pi/README.md` — add the extension to the monorepo table.
- `extensions/pi-prompt-queue/*` — no change.
- `extensions/pi-chat/*` — no change; preserve the untracked work.

---

## Task 1: Create the package shell and shared contracts

**Files:**

- Create: `extensions/pi-subagent-monitor/package.json`
- Create: `extensions/pi-subagent-monitor/.gitignore`
- Create: `extensions/pi-subagent-monitor/.prettierrc`
- Create: `extensions/pi-subagent-monitor/tsconfig.json`
- Create: `extensions/pi-subagent-monitor/vitest.config.ts`
- Create: `extensions/pi-subagent-monitor/src/types.ts`
- Create: `extensions/pi-subagent-monitor/test/support/fakes.ts`
- Generate: `extensions/pi-subagent-monitor/package-lock.json`

- [ ] **Step 1: Create package metadata and tooling files**

Use this package manifest. It keeps Pi and TypeBox as peer dependencies, because
Pi resolves extension dependencies at runtime, and keeps test/build tooling
local to the package.

```json
{
  "name": "pi-subagent-monitor",
  "version": "0.1.0",
  "description": "Telemetry and safety limits for Pi subagent workflows",
  "keywords": [
    "pi-package",
    "pi-extension",
    "subagents",
    "watchdog",
    "cost-control"
  ],
  "license": "MIT",
  "type": "module",
  "pi": {
    "extensions": [
      "./src/index.ts"
    ]
  },
  "files": [
    "src",
    "README.md",
    "tsconfig.json",
    "vitest.config.ts",
    ".prettierrc"
  ],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write src test *.json *.ts *.md",
    "format:check": "prettier --check src test *.json *.ts *.md"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "prettier": "^3.6.2",
    "typescript": "^5.9.3",
    "vitest": "^4.1.10"
  }
}
```

Create `.gitignore` with exactly:

```gitignore
node_modules/
```

Create `.prettierrc` with the existing extension convention:

```json
{
  "semi": true,
  "trailingComma": "all",
  "singleQuote": true,
  "printWidth": 120,
  "tabWidth": 2
}
```

Create `tsconfig.json` with strict source and test coverage:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "test"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

- [ ] **Step 2: Generate the lockfile and install local tooling**

Run:

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm install
```

Expected: npm creates `package-lock.json`, installs the declared dev
dependencies, and exits with code 0. Do not run npm from `/data/pi` and do not
add any peer dependency as a runtime dependency.

- [ ] **Step 3: Define the shared domain contracts**

Create `src/types.ts` with the following complete contract. Later modules must
import these names rather than defining competing versions.

```ts
export type MonitorMode = 'observe' | 'enforce';

export type WorkflowState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'complete'
  | 'failed'
  | 'partial'
  | 'stopped'
  | 'rejected';

export type WorkflowKind = 'foreground' | 'background';

export type LimitName =
  | 'wallClockMs'
  | 'inactivityMs'
  | 'tokenCount'
  | 'costUsd'
  | 'toolCalls'
  | 'turns'
  | 'activeToolMs';

export interface Limits {
  wallClockMs: number;
  inactivityMs: number;
  tokenCount: number;
  costUsd: number;
  toolCalls: number;
  turns: number;
  activeToolMs: number;
}

export interface MonitorConfig {
  mode: MonitorMode;
  limits: Limits;
  warningLeadMs: number;
  terminationGraceMs: number;
  pollIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  historyMaxEntries: number;
}

export type LimitOverride = Partial<Limits>;

export interface ChildSnapshot {
  id: string;
  state: WorkflowState;
  runId?: string;
  agent?: string;
  startedAt?: number;
  lastActivityAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  totalTokens?: number;
  totalCost?: number;
  toolCount?: number;
  turnCount?: number;
}

export type ControlTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'foreground-current' };

export interface WorkflowSnapshot {
  id: string;
  sessionId: string;
  kind: WorkflowKind;
  state: WorkflowState;
  startedAt?: number;
  lastActivityAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  totalTokens?: number;
  totalCost?: number;
  toolCount?: number;
  turnCount?: number;
  rootId?: string;
  children: readonly ChildSnapshot[];
  processTerminal: 'observed' | 'unknown' | 'unavailable';
  controlTarget: ControlTarget;
}

export interface GatewaySnapshot {
  sessionId: string;
  workflows: readonly WorkflowSnapshot[];
  unconfirmed: number;
}

export type GatewayCapability = 'status' | 'interrupt' | 'stop';

export interface ControlReceipt {
  state: 'accepted' | 'rejected' | 'unknown';
  runId?: string;
  message: string;
}

export interface GatewayConnection {
  readonly sessionId: string;
  readonly capabilities: ReadonlySet<GatewayCapability>;
  status(): Promise<GatewaySnapshot>;
  interrupt(target: ControlTarget): Promise<ControlReceipt>;
  stop(target: ControlTarget): Promise<ControlReceipt>;
  onWake(handler: () => void): () => void;
  dispose(): void;
}

export interface EventBus {
  on(event: string, handler: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
}

export interface ClockState {
  phase: WorkflowState;
  observedAt: number;
  executionMs: number;
  lastActivityAt?: number;
  activityFingerprint: string;
}

export type MonitorState =
  | 'observed'
  | 'warning'
  | 'terminating'
  | 'confirmed'
  | 'unknown-control'
  | 'degraded';

export interface WorkflowRecord {
  snapshot: WorkflowSnapshot;
  clock: ClockState;
  effectiveLimits: Limits;
  state: MonitorState;
  warnedSignals: ReadonlySet<LimitName>;
  breach?: PolicyBreach;
  retryAttempt: number;
}

export interface PolicyInput {
  now: number;
  executionMs: number;
  lastActivityAt?: number;
  currentToolStartedAt?: number;
  totalTokens?: number;
  totalCost?: number;
  toolCalls?: number;
  turns?: number;
  limits: Limits;
  warningLeadMs: number;
}

export interface PolicyWarning {
  signal: LimitName;
  used: number;
  limit: number;
}

export interface PolicyBreach {
  signal: LimitName;
  used: number;
  limit: number;
}

export interface PolicyEvaluation {
  warnings: readonly PolicyWarning[];
  breach?: PolicyBreach;
  missing: readonly LimitName[];
  remaining: Partial<Record<LimitName, number>>;
}

export interface HistoryRecord {
  version: 1;
  recordedAt: number;
  runId: string;
  kind: WorkflowKind;
  childCount: number;
  durationMs: number;
  finalState: MonitorState | 'complete' | 'failed' | 'stopped';
  trigger?: LimitName;
  totalTokens?: number;
  totalCost?: number;
  toolCalls?: number;
  turns?: number;
  controlOutcome: 'not-needed' | 'confirmed' | 'unknown' | 'failed';
  retryAttempts: number;
}

export type LaunchKind =
  | 'single'
  | 'parallel-review'
  | 'review-loop'
  | 'implement-review'
  | 'chain-parallel';

export interface LaunchStep {
  key: string;
  agent: string;
  task: string;
}

export interface LaunchRequest {
  kind: LaunchKind;
  task: string;
  agent?: string;
  steps?: readonly LaunchStep[];
  async?: boolean;
  limits?: LimitOverride;
}

export interface LaunchReceipt {
  requestId: string;
  runId?: string;
  state: 'started' | 'completed' | 'rejected';
  effectiveLimits: Limits;
  message: string;
}

export type LimitResolver = (workflow: WorkflowSnapshot) => Limits;
```

- [ ] **Step 4: Add deterministic test fakes**

Create `test/support/fakes.ts` with a fake event bus and a base snapshot
factory. The fake bus must return an unsubscribe function so gateway cleanup can
be tested.

```ts
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
  readonly capabilities = new Set<'status' | 'interrupt' | 'stop'>([
    'status',
    'interrupt',
    'stop',
  ]);
  current = gatewaySnapshot();
  readonly interrupted: string[] = [];
  readonly stopped: string[] = [];
  private readonly wakeHandlers = new Set<() => void>();

  async status(): Promise<GatewaySnapshot> {
    return this.current;
  }

  async interrupt(target: { kind: 'run'; runId: string } | { kind: 'foreground-current' }): Promise<ControlReceipt> {
    this.interrupted.push(target.kind === 'run' ? target.runId : 'foreground-current');
    return { state: 'accepted', runId: target.kind === 'run' ? target.runId : undefined, message: 'interrupt accepted' };
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
```

- [ ] **Step 5: Typecheck the empty package contract**

Run:

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm run typecheck
```

Expected: exit 0. No runtime extension entrypoint exists yet, so do not run Pi.
Commit the package shell and shared contracts:

```bash
git -C /data/pi add extensions/pi-subagent-monitor
git -C /data/pi commit -m "chore: scaffold subagent monitor package"
```

---

## Task 2: Implement configuration and tighten-only policy merging

**Files:**

- Create: `extensions/pi-subagent-monitor/src/config.ts`
- Create: `extensions/pi-subagent-monitor/test/config.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Create `test/config.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  loadConfig,
  parseConfig,
  resolveLimits,
} from '../src/config';

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
    expect(() => resolveLimits({ ...zeroLimits, wallClockMs: 600000 }, { wallClockMs: 600001 })).toThrow(
      'wallClockMs',
    );
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
```

- [ ] **Step 2: Run the tests and verify the RED phase**

Run:

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/config.test.ts
```

Expected: FAIL because `src/config.ts` does not yet export `DEFAULT_CONFIG`,
`parseConfig`, or `resolveLimits`.

- [ ] **Step 3: Implement validated defaults and loading primitives**

Create `src/config.ts`. Use `0` only for disabled actual safety limits; use
bounded operational defaults for warning, grace, polling, retry, and history.

```ts
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
    terminationGraceMs: nonNegativeInteger(value.terminationGraceMs ?? DEFAULT_CONFIG.terminationGraceMs, 'terminationGraceMs'),
    pollIntervalMs: positiveInteger(value.pollIntervalMs ?? DEFAULT_CONFIG.pollIntervalMs, 'pollIntervalMs'),
    retryBaseMs: positiveInteger(value.retryBaseMs ?? DEFAULT_CONFIG.retryBaseMs, 'retryBaseMs'),
    retryMaxMs: positiveInteger(value.retryMaxMs ?? DEFAULT_CONFIG.retryMaxMs, 'retryMaxMs'),
    historyMaxEntries: nonNegativeInteger(value.historyMaxEntries ?? DEFAULT_CONFIG.historyMaxEntries, 'historyMaxEntries'),
  };
}

export function resolveLimits(global: Limits, override: LimitOverride): Limits {
  const result = { ...global };
  for (const name of LIMIT_NAMES) {
    const requested = override[name];
    if (requested === undefined || requested === 0) continue;
    const valid = name === 'costUsd'
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
```

Add this loader in the same file. It returns a safe default for a missing file,
and returns that same default plus a bounded error for malformed JSON or invalid
configuration; it never silently enables enforcement.

```ts
export interface ConfigLoadResult {
  config: MonitorConfig;
  error?: string;
}

export async function loadConfig(filePath: string): Promise<ConfigLoadResult> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return { config: parseConfig(JSON.parse(raw) as unknown) };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === 'ENOENT') return { config: structuredClone(DEFAULT_CONFIG) };
    const message = error instanceof Error ? error.message.slice(0, 500) : 'invalid monitor configuration';
    return {
      config: structuredClone(DEFAULT_CONFIG),
      error: `monitor configuration disabled: ${message}`,
    };
  }
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/config.test.ts
npm run typecheck
```

Expected: all configuration tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit the configuration boundary**

```bash
git -C /data/pi add extensions/pi-subagent-monitor/src/config.ts extensions/pi-subagent-monitor/test/config.test.ts
git -C /data/pi commit -m "feat: add monitor configuration policy"
```

---

## Task 3: Implement clocks, activity detection, and policy evaluation

**Files:**

- Create: `extensions/pi-subagent-monitor/src/policy.ts`
- Create: `extensions/pi-subagent-monitor/test/policy.test.ts`

- [ ] **Step 1: Write failing clock and threshold tests**

Create `test/policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  advanceClock,
  evaluatePolicy,
  activityFingerprint,
  isMeaningfulActivity,
} from '../src/policy';
import type { ClockState, PolicyInput } from '../src/types';
import { workflowSnapshot } from './support/fakes';

describe('policy engine', () => {
  it('pauses execution time while a workflow is paused', () => {
    const initial: ClockState = {
      phase: 'running',
      observedAt: 1000,
      executionMs: 0,
      activityFingerprint: 'initial',
    };
    const paused = advanceClock(initial, 'paused', 4000, 'paused');
    const resumed = advanceClock(paused, 'running', 9000, 'resumed');
    const completed = advanceClock(resumed, 'complete', 10000, 'complete');
    expect(paused.executionMs).toBe(3000);
    expect(resumed.executionMs).toBe(3000);
    expect(completed.executionMs).toBe(4000);
  });

  it('detects meaningful state, tool, counter, and child changes', () => {
    const first = workflowSnapshot({ totalTokens: 10, currentTool: 'read' });
    const same = workflowSnapshot({ totalTokens: 10, currentTool: 'read' });
    const changed = workflowSnapshot({ totalTokens: 11, currentTool: 'edit' });
    expect(isMeaningfulActivity(first, same)).toBe(false);
    expect(isMeaningfulActivity(first, changed)).toBe(true);
    expect(activityFingerprint(first)).not.toBe(activityFingerprint(changed));
  });

  it('warns at the time lead and 80 percent counter thresholds', () => {
    const input: PolicyInput = {
      now: 70000,
      executionMs: 60000,
      lastActivityAt: 65000,
      totalTokens: 800,
      totalCost: 0.8,
      toolCalls: 8,
      turns: 8,
      limits: {
        wallClockMs: 60000,
        inactivityMs: 0,
        tokenCount: 1000,
        costUsd: 1,
        toolCalls: 10,
        turns: 10,
        activeToolMs: 0,
      },
      currentToolStartedAt: undefined,
      warningLeadMs: 15000,
    };
    const evaluation = evaluatePolicy(input);
    expect(evaluation.warnings.map((warning) => warning.signal)).toEqual([
      'wallClockMs',
      'tokenCount',
      'costUsd',
      'toolCalls',
      'turns',
    ]);
    expect(evaluation.breach?.signal).toBe('wallClockMs');
  });

  it('marks missing configured usage without treating it as zero', () => {
    const input: PolicyInput = {
      now: 1000,
      executionMs: 100,
      lastActivityAt: 900,
      limits: {
        wallClockMs: 0,
        inactivityMs: 0,
        tokenCount: 1000,
        costUsd: 1,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      warningLeadMs: 100,
    };
    const evaluation = evaluatePolicy(input);
    expect(evaluation.missing).toEqual(['tokenCount', 'costUsd']);
    expect(evaluation.breach).toBeUndefined();
  });

  it('breaches a configured active-tool duration', () => {
    const evaluation = evaluatePolicy({
      now: 10000,
      executionMs: 100,
      lastActivityAt: 9900,
      currentToolStartedAt: 1000,
      limits: {
        wallClockMs: 0,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 5000,
      },
      warningLeadMs: 1000,
    });
    expect(evaluation.breach?.signal).toBe('activeToolMs');
    expect(evaluation.breach?.used).toBe(9000);
  });
});
```

- [ ] **Step 2: Run the tests and verify the RED phase**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/policy.test.ts
```

Expected: FAIL because `src/policy.ts` does not yet export the tested functions.

- [ ] **Step 3: Implement pause-aware clocks and activity fingerprints**

Create `src/policy.ts` with these pure helpers. A queued or running prior phase
consumes elapsed execution time; a paused, complete, failed, partial, stopped,
or rejected prior phase does not.

```ts
import type {
  ClockState,
  LimitName,
  PolicyBreach,
  PolicyEvaluation,
  PolicyInput,
  PolicyWarning,
  WorkflowSnapshot,
  WorkflowState,
} from './types';

function clockActive(state: WorkflowState): boolean {
  return state === 'queued' || state === 'running';
}

export function advanceClock(
  previous: ClockState,
  nextPhase: WorkflowState,
  now: number,
  nextFingerprint: string,
): ClockState {
  const delta = Math.max(0, now - previous.observedAt);
  const executionMs = previous.executionMs + (clockActive(previous.phase) ? delta : 0);
  return {
    phase: nextPhase,
    observedAt: now,
    executionMs,
    lastActivityAt: previous.lastActivityAt,
    activityFingerprint: nextFingerprint,
  };
}

export function activityFingerprint(snapshot: WorkflowSnapshot): string {
  const children = snapshot.children.map((child) => ({
    id: child.id,
    state: child.state,
    runId: child.runId,
    currentTool: child.currentTool,
    lastActivityAt: child.lastActivityAt,
    totalTokens: child.totalTokens,
    toolCount: child.toolCount,
    turnCount: child.turnCount,
  }));
  return JSON.stringify({
    state: snapshot.state,
    currentTool: snapshot.currentTool,
    lastActivityAt: snapshot.lastActivityAt,
    totalTokens: snapshot.totalTokens,
    toolCalls: snapshot.toolCount,
    turns: snapshot.turnCount,
    children,
  });
}

export function isMeaningfulActivity(previous: WorkflowSnapshot, next: WorkflowSnapshot): boolean {
  return activityFingerprint(previous) !== activityFingerprint(next);
}

type CounterSignal = Extract<LimitName, 'tokenCount' | 'costUsd' | 'toolCalls' | 'turns'>;

function warnAtFraction(used: number | undefined, limit: number): boolean {
  return used !== undefined && limit > 0 && used >= limit * 0.8;
}

function addCounter(
  warnings: PolicyWarning[],
  missing: LimitName[],
  signal: CounterSignal,
  used: number | undefined,
  limit: number,
): void {
  if (limit === 0) return;
  if (used === undefined) {
    missing.push(signal);
    return;
  }
  if (warnAtFraction(used, limit)) warnings.push({ signal, used, limit });
}

export function evaluatePolicy(input: PolicyInput): PolicyEvaluation {
  const warnings: PolicyWarning[] = [];
  const missing: LimitName[] = [];
  const remaining: Partial<Record<LimitName, number>> = {};
  const { limits } = input;

  if (limits.wallClockMs > 0) {
    const remainingMs = Math.max(0, limits.wallClockMs - input.executionMs);
    remaining.wallClockMs = remainingMs;
    if (remainingMs <= input.warningLeadMs) {
      warnings.push({ signal: 'wallClockMs', used: input.executionMs, limit: limits.wallClockMs });
    }
  }
  if (limits.inactivityMs > 0) {
    if (input.lastActivityAt === undefined) {
      missing.push('inactivityMs');
    } else {
      const idleMs = Math.max(0, input.now - input.lastActivityAt);
      remaining.inactivityMs = Math.max(0, limits.inactivityMs - idleMs);
      if (idleMs >= Math.max(0, limits.inactivityMs - input.warningLeadMs)) {
        warnings.push({ signal: 'inactivityMs', used: idleMs, limit: limits.inactivityMs });
      }
    }
  }

  addCounter(warnings, missing, 'tokenCount', input.totalTokens, limits.tokenCount);
  addCounter(warnings, missing, 'costUsd', input.totalCost, limits.costUsd);
  addCounter(warnings, missing, 'toolCalls', input.toolCalls, limits.toolCalls);
  addCounter(warnings, missing, 'turns', input.turns, limits.turns);

  if (limits.activeToolMs > 0 && input.currentToolStartedAt !== undefined) {
    const activeToolMs = Math.max(0, input.now - input.currentToolStartedAt);
    remaining.activeToolMs = Math.max(0, limits.activeToolMs - activeToolMs);
    if (activeToolMs >= Math.max(0, limits.activeToolMs - input.warningLeadMs)) {
      warnings.push({ signal: 'activeToolMs', used: activeToolMs, limit: limits.activeToolMs });
    }
  }

  const breach: PolicyBreach | undefined = warnings.find((warning) => warning.used >= warning.limit);
  return { warnings, breach, missing, remaining };
}
```

Import `LimitName`, `PolicyBreach`, and `PolicyWarning` directly from
`src/types.ts`. Keep warning order as wall time, inactivity, token, cost, tool,
turn, active-tool, and select the first warning whose `used` value reaches its
`limit` as the breach.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/policy.test.ts
npm run typecheck
```

Expected: all policy tests PASS and typecheck exits 0. The suite must also
include an active-tool-duration breach with `currentToolStartedAt` set and
`activeToolMs` enabled.

- [ ] **Step 5: Commit the policy engine**

```bash
git -C /data/pi add extensions/pi-subagent-monitor/src/policy.ts extensions/pi-subagent-monitor/test/policy.test.ts
git -C /data/pi commit -m "feat: add pause-aware monitor policy engine"
```

---

## Task 4: Build the documented pi-subagents gateway adapter

**Files:**

- Create: `extensions/pi-subagent-monitor/src/gateway.ts`
- Create: `extensions/pi-subagent-monitor/test/gateway.test.ts`
- Modify: `extensions/pi-subagent-monitor/test/support/fakes.ts`

- [ ] **Step 1: Write failing RPC handshake and normalization tests**

The fake event bus must answer the request emitted by the gateway. Add tests for
the versioned ready/request/reply events:

```ts
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
      const data = request.method === 'ping'
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
              runs: [{
                id: 'run-1',
                kind: 'workflow',
                label: 'review',
                state: 'running',
                startedAt: 1000,
                activity: { lastActivityAt: 1100 },
              }],
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
    const gateway = await connectGateway({ events, sessionId: 'session-1', readyTimeoutMs: 50, requestTimeoutMs: 50 });
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
    await expect(connectGateway({ events, sessionId: 'session-1', readyTimeoutMs: 50, requestTimeoutMs: 50 })).rejects.toThrow(
      'session',
    );
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
});
```

- [ ] **Step 2: Run the gateway tests and verify the RED phase**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/gateway.test.ts
```

Expected: FAIL because `connectGateway` is not implemented.

- [ ] **Step 3: Implement the event-bus request/reply adapter**

Create `src/gateway.ts` with these constants and request contract:

```ts
import { randomUUID } from 'node:crypto';
import type {
  ControlReceipt,
  ControlTarget,
  EventBus,
  GatewayCapability,
  GatewayConnection,
  GatewaySnapshot,
} from './types';

const READY_EVENT = 'subagents:rpc:v1:ready';
const REQUEST_EVENT = 'subagents:rpc:v1:request';
const REPLY_PREFIX = 'subagents:rpc:v1:reply:';
const PROTOCOL_VERSION = 1;

interface GatewayOptions {
  events: EventBus;
  sessionId: string;
  readyTimeoutMs: number;
  requestTimeoutMs: number;
  requestId?: () => string;
}

interface RpcReply {
  version: number;
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\r\n]/.test(value)) {
    throw new Error(`${field} must be a bounded string`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function capabilitiesFrom(value: unknown): ReadonlySet<GatewayCapability> {
  const source = requireRecord(value, 'capabilities');
  const result = new Set<GatewayCapability>();
  for (const name of ['status', 'interrupt', 'stop'] as const) {
    if (source[name] === true) result.add(name);
  }
  return result;
}

function replyError(reply: RpcReply): Error {
  const message = isRecord(reply.error) && typeof reply.error.message === 'string'
    ? reply.error.message.slice(0, 1000)
    : 'pi-subagents RPC request failed';
  return new Error(message);
}

export async function connectGateway(options: GatewayOptions): Promise<GatewayConnection> {
  const requestId = options.requestId ?? randomUUID;
  const ready = await request(options.events, 'ping', {}, options.readyTimeoutMs, requestId);
  const readyData = requireRecord(ready, 'ping data');
  const session = requireRecord(readyData.session, 'session');
  const remoteSession = boundedString(session.sessionId, 'session.sessionId');
  if (remoteSession !== options.sessionId) throw new Error('pi-subagents session mismatch');
  const capabilities = capabilitiesFrom(readyData.capabilities);
  if (!capabilities.has('status')) {
    throw new Error('pi-subagents lacks required status capability');
  }
  const eventNames = isRecord(readyData.events) ? readyData.events : {};
  const eventDisposers: Array<() => void> = [];
  let wakeHandler: (() => void) | undefined;

  function onWake(handler: () => void): () => void {
    wakeHandler = handler;
    for (const name of ['asyncComplete', 'childStatus', 'processTerminal'] as const) {
      const value = eventNames[name];
      if (typeof value !== 'string' || value.length === 0) continue;
      eventDisposers.push(options.events.on(value, () => wakeHandler?.()));
    }
    return () => {
      if (wakeHandler === handler) wakeHandler = undefined;
    };
  }

  const connection: GatewayConnection = {
    sessionId: options.sessionId,
    capabilities,
    async status(): Promise<GatewaySnapshot> {
      const value = await request(options.events, 'status', {}, options.requestTimeoutMs, requestId);
      return normalizeStatus(value, options.sessionId);
    },
    async interrupt(target: ControlTarget): Promise<ControlReceipt> {
      if (!capabilities.has('interrupt')) return { state: 'rejected', message: 'pi-subagents does not advertise interrupt' };
      return control(options.events, 'interrupt', target, options.requestTimeoutMs, requestId);
    },
    async stop(target: ControlTarget): Promise<ControlReceipt> {
      if (!capabilities.has('stop')) return { state: 'rejected', message: 'pi-subagents does not advertise stop' };
      return control(options.events, 'stop', target, options.requestTimeoutMs, requestId);
    },
    onWake,
    dispose(): void {
      for (const dispose of eventDisposers.splice(0)) dispose();
      wakeHandler = undefined;
    },
  };
  return connection;
}
```

Implement `request`, `control`, and `normalizeStatus` in the same module.
`request` must subscribe before emitting, validate protocol/request IDs, bound
error text, timeout with cleanup, and emit only documented params. `control`
must translate `{ kind: 'run', runId }` to `{ id: runId }` and `{ kind:
'foreground-current' }` to an empty target; it must not send the opaque fleet
display key as a run ID.

Register `READY_EVENT` before the first probe. Send an immediate ping for an
already-ready pi-subagents owner; if that probe times out, wait for one ready
event and retry once within the same bounded startup window. Remove the ready
listener on either success or failure. This supports both extension load orders
without polling indefinitely.

`normalizeStatus` must consume the public `asyncSnapshot` run/node data and
current foreground fleet data. If a foreground control cannot be mapped to a run
ID, emit one `WorkflowSnapshot` with `controlTarget: { kind:
'foreground-current' }` only when exactly one current foreground workflow is
identifiable; otherwise increment `unconfirmed` and do not invent an ID.
Preserve `processTerminal: 'unknown'` when the proof is absent.

- [ ] **Step 4: Run gateway tests, typecheck, and commit**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/gateway.test.ts
npm run typecheck
```

Expected: gateway tests PASS and typecheck exits 0.

```bash
git -C /data/pi add extensions/pi-subagent-monitor/src/gateway.ts extensions/pi-subagent-monitor/test/gateway.test.ts extensions/pi-subagent-monitor/test/support/fakes.ts
git -C /data/pi commit -m "feat: add public pi-subagents gateway"
```

---

## Task 5: Add the workflow registry and reconciliation logic

**Files:**

- Create: `extensions/pi-subagent-monitor/src/registry.ts`
- Create: `extensions/pi-subagent-monitor/test/registry.test.ts`

- [ ] **Step 1: Write failing registry tests**

```ts
import { describe, expect, it } from 'vitest';
import { RunRegistry } from '../src/registry';
import { gatewaySnapshot, workflowSnapshot } from './support/fakes';

describe('run registry', () => {
  it('starts and updates a workflow without merging stale fields', () => {
    const registry = new RunRegistry('session-1');
    const first = workflowSnapshot({ totalTokens: 10, currentTool: 'read' });
    const second = workflowSnapshot({ totalTokens: 20, currentTool: undefined });
    registry.reconcile(gatewaySnapshot([first]), 1000, () => ({
      wallClockMs: 600000,
      inactivityMs: 0,
      tokenCount: 1000,
      costUsd: 0,
      toolCalls: 0,
      turns: 0,
      activeToolMs: 0,
    }));
    registry.reconcile(gatewaySnapshot([second]), 2000, () => ({
      wallClockMs: 600000,
      inactivityMs: 0,
      tokenCount: 1000,
      costUsd: 0,
      toolCalls: 0,
      turns: 0,
      activeToolMs: 0,
    }));
    const record = registry.get('run-1');
    expect(record?.snapshot.totalTokens).toBe(20);
    expect(record?.snapshot.currentTool).toBeUndefined();
  });

  it('pauses and resumes the execution clock without resetting it', () => {
    const registry = new RunRegistry('session-1');
    const limits = () => ({
      wallClockMs: 100000,
      inactivityMs: 0,
      tokenCount: 0,
      costUsd: 0,
      toolCalls: 0,
      turns: 0,
      activeToolMs: 0,
    });
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ state: 'running' })]), 1000, limits);
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ state: 'paused' })]), 4000, limits);
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ state: 'running' })]), 9000, limits);
    expect(registry.get('run-1')?.clock.executionMs).toBe(3000);
  });

  it('keeps terminal records until a terminal snapshot is authoritative', () => {
    const registry = new RunRegistry('session-1');
    const limits = () => ({
      wallClockMs: 0,
      inactivityMs: 0,
      tokenCount: 0,
      costUsd: 0,
      toolCalls: 0,
      turns: 0,
      activeToolMs: 0,
    });
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ state: 'running' })]), 1000, limits);
    expect(registry.active()).toHaveLength(1);
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ state: 'stopped' })]), 2000, limits);
    expect(registry.active()).toHaveLength(0);
    expect(registry.get('run-1')?.snapshot.state).toBe('stopped');
  });

  it('does not admit snapshots from another session', () => {
    const registry = new RunRegistry('session-1');
    registry.reconcile(gatewaySnapshot([workflowSnapshot({ sessionId: 'session-2' })]), 1000, () => ({
      wallClockMs: 0,
      inactivityMs: 0,
      tokenCount: 0,
      costUsd: 0,
      toolCalls: 0,
      turns: 0,
      activeToolMs: 0,
    }));
    expect(registry.active()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run registry tests and verify RED**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/registry.test.ts
```

Expected: FAIL because `RunRegistry` is not implemented.

- [ ] **Step 3: Implement `RunRegistry`**

Create `src/registry.ts` with this public shape:

```ts
import { advanceClock, activityFingerprint } from './policy';
import type {
  GatewaySnapshot,
  LimitResolver,
  WorkflowRecord,
  WorkflowSnapshot,
} from './types';

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
      const lastActivityAt = fingerprint === previous.clock.activityFingerprint
        ? previous.clock.lastActivityAt
        : now;
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
    return [...this.records.values()].filter((record) => record.snapshot.state === 'queued' || record.snapshot.state === 'running');
  }

  public all(): WorkflowRecord[] {
    return [...this.records.values()];
  }

  public update(record: WorkflowRecord): void {
    this.records.set(record.snapshot.id, record);
  }
}
```

When a public snapshot has no stable ID, do not insert it into the map. Surface
its count through the runtime’s degraded/unknown status. Preserve terminal
records so history can be written after verification, but use `active()` for
control eligibility.

- [ ] **Step 4: Run focused tests and commit**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/registry.test.ts
npm run typecheck
```

Expected: all registry tests PASS and typecheck exits 0.

```bash
git -C /data/pi add extensions/pi-subagent-monitor/src/registry.ts extensions/pi-subagent-monitor/test/registry.test.ts
git -C /data/pi commit -m "feat: track monitored workflow state"
```

---

## Task 6: Implement bounded metrics-only history

**Files:**

- Create: `extensions/pi-subagent-monitor/src/history.ts`
- Create: `extensions/pi-subagent-monitor/test/history.test.ts`

- [ ] **Step 1: Write failing history and redaction tests**

```ts
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
    const record = (await store.list())[0] as Record<string, unknown>;
    expect(record.task).toBeUndefined();
    expect(record.cwd).toBeUndefined();
    expect(record.transcript).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run history tests and verify RED**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/history.test.ts
```

Expected: FAIL because `MetricsStore` is not implemented.

- [ ] **Step 3: Implement atomic bounded persistence**

Create `src/history.ts`. Use a JSON array file, a serialized write queue, a
private directory, and an atomic temporary-file rename. Keep only the fields
declared by `HistoryRecord`.

```ts
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
  return clean as HistoryRecord;
}

function isHistoryRecord(value: unknown): value is HistoryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.recordedAt === 'number'
    && typeof record.runId === 'string'
    && typeof record.kind === 'string'
    && typeof record.childCount === 'number'
    && typeof record.durationMs === 'number'
    && typeof record.finalState === 'string'
    && typeof record.controlOutcome === 'string'
    && typeof record.retryAttempts === 'number';
}

export class MetricsStore {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string, private readonly maxEntries: number) {}

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
```

A malformed history file must not prevent the monitor from starting; the next
append replaces it with a valid bounded array. Do not log the malformed body.

- [ ] **Step 4: Run tests, typecheck, and commit**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/history.test.ts
npm run typecheck
```

Expected: all history tests PASS and typecheck exits 0.

```bash
git -C /data/pi add extensions/pi-subagent-monitor/src/history.ts extensions/pi-subagent-monitor/test/history.test.ts
git -C /data/pi commit -m "feat: persist bounded monitor metrics"
```

---

## Task 7: Implement termination, verification, and bounded retry

**Files:**

- Create: `extensions/pi-subagent-monitor/src/termination.ts`
- Create: `extensions/pi-subagent-monitor/test/termination.test.ts`

- [ ] **Step 1: Write failing termination state-machine tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { TerminationCoordinator } from '../src/termination';
import { FakeGateway, gatewaySnapshot, workflowSnapshot } from './support/fakes';
import type { PolicyBreach, WorkflowRecord } from '../src/types';

describe('termination coordinator', () => {
  it('interrupts then stops the whole background workflow and confirms terminal state', async () => {
    const gateway = new FakeGateway();
    const updates: string[] = [];
    let terminal = false;
    let reconciliations = 0;
    const record: WorkflowRecord = {
      snapshot: workflowSnapshot({ kind: 'background', state: 'running' }),
      clock: {
        phase: 'running',
        observedAt: 1000,
        executionMs: 600001,
        lastActivityAt: 1000,
        activityFingerprint: 'x',
      },
      effectiveLimits: {
        wallClockMs: 600000,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      state: 'terminating',
      warnedSignals: new Set(),
      retryAttempt: 0,
    };
    const breach: PolicyBreach = { signal: 'wallClockMs', used: 600001, limit: 600000 };
    const coordinator = new TerminationCoordinator({
      gateway,
      get: () => terminal
        ? { ...record, snapshot: workflowSnapshot({ state: 'stopped', processTerminal: 'observed' }) }
        : record,
      reconcile: async () => {
        reconciliations += 1;
        terminal = reconciliations >= 3;
        gateway.current = gatewaySnapshot([workflowSnapshot({
          state: terminal ? 'stopped' : 'running',
          processTerminal: terminal ? 'observed' : 'unknown',
        })]);
      },
      sleep: async () => undefined,
      now: () => 2000,
      graceMs: 100,
      retryBaseMs: 100,
      retryMaxMs: 1000,
      onState: (_runId, state) => updates.push(state),
    });
    const result = await coordinator.breach(record, breach);
    expect(gateway.interrupted).toEqual(['run-1']);
    expect(gateway.stopped).toEqual(['run-1']);
    expect(result.state).toBe('confirmed');
    expect(updates).toContain('confirmed');
  });

  it('includes a child discovered during grace and reports unknown control', async () => {
    const gateway = new FakeGateway();
    const reconcile = vi.fn(async () => {
      gateway.current = gatewaySnapshot([workflowSnapshot({
        children: [
          { id: 'step:0', state: 'running' },
          { id: 'step:1', state: 'running' },
        ],
      })]);
    });
    const record = {
      snapshot: workflowSnapshot({ kind: 'foreground', controlTarget: { kind: 'foreground-current' } }),
      clock: { phase: 'running', observedAt: 1000, executionMs: 100, activityFingerprint: 'x' },
      effectiveLimits: { wallClockMs: 100, inactivityMs: 0, tokenCount: 0, costUsd: 0, toolCalls: 0, turns: 0, activeToolMs: 0 },
      state: 'terminating' as const,
      warnedSignals: new Set(),
      retryAttempt: 0,
    };
    const coordinator = new TerminationCoordinator({
      gateway,
      get: () => record,
      reconcile,
      sleep: async () => undefined,
      now: () => 2000,
      graceMs: 1,
      retryBaseMs: 1,
      retryMaxMs: 2,
      onState: vi.fn(),
    });
    const result = await coordinator.breach(record, { signal: 'wallClockMs', used: 101, limit: 100 });
    expect(reconcile).toHaveBeenCalled();
    expect(result.state).toBe('unknown-control');
  });
});
```

- [ ] **Step 2: Run termination tests and verify RED**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/termination.test.ts
```

Expected: FAIL because `TerminationCoordinator` is not implemented.

- [ ] **Step 3: Implement the documented control state machine**

Create `src/termination.ts` with an injected gateway, clock, sleep function, and
reconciliation callback. Keep Pi parent shutdown out of the dependency interface
so it cannot be called accidentally.

```ts
import type {
  ControlReceipt,
  GatewayConnection,
  PolicyBreach,
  WorkflowRecord,
} from './types';

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

export class TerminationCoordinator {
  private readonly pending = new Set<string>();
  private disposed = false;

  public constructor(private readonly options: TerminationOptions) {}

  public dispose(): void {
    this.disposed = true;
    this.pending.clear();
  }

  public async breach(record: WorkflowRecord, breach: PolicyBreach): Promise<TerminationResult> {
    if (this.disposed) {
      return { state: 'failed', control: 'failed', retryAttempt: record.retryAttempt, message: 'termination coordinator disposed' };
    }
    if (this.pending.has(record.snapshot.id)) {
      return { state: 'unknown-control', control: 'unknown', retryAttempt: record.retryAttempt, message: 'termination already pending' };
    }
    this.pending.add(record.snapshot.id);
    this.options.onState(record.snapshot.id, 'terminating');
    try {
      const graceful = await this.options.gateway.interrupt(record.snapshot.controlTarget);
      if (this.disposed) return this.disposedResult(record);
      await this.options.reconcile();
      if (this.disposed) return this.disposedResult(record);
      if (this.isConfirmed(record.snapshot.id)) return this.confirmed(record.snapshot.id, graceful, record.retryAttempt);
      await this.options.sleep(this.options.graceMs);
      if (this.disposed) return this.disposedResult(record);
      await this.options.reconcile();
      if (this.disposed) return this.disposedResult(record);
      if (this.isConfirmed(record.snapshot.id)) return this.confirmed(record.snapshot.id, graceful, record.retryAttempt);
      const escalated = await this.options.gateway.stop(record.snapshot.controlTarget);
      if (this.disposed) return this.disposedResult(record);
      await this.options.reconcile();
      if (this.disposed) return this.disposedResult(record);
      if (this.isConfirmed(record.snapshot.id)) return this.confirmed(record.snapshot.id, escalated, record.retryAttempt);
      this.options.onState(record.snapshot.id, 'unknown-control');
      return {
        state: 'unknown-control',
        control: escalated.state === 'rejected' ? 'failed' : 'unknown',
        retryAttempt: record.retryAttempt,
        message: `limit ${breach.signal} remains unconfirmed`,
      };
    } catch (error) {
      this.options.onState(record.snapshot.id, 'unknown-control');
      return {
        state: 'unknown-control',
        control: 'failed',
        retryAttempt: record.retryAttempt,
        message: error instanceof Error ? error.message.slice(0, 500) : 'termination control failed',
      };
    } finally {
      this.pending.delete(record.snapshot.id);
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
    const retryAttempt = record.retryAttempt + 1;
    const delay = Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** record.retryAttempt);
    await this.options.sleep(delay);
    if (this.disposed) {
      return { state: 'failed', control: 'failed', retryAttempt, message: 'termination coordinator disposed' };
    }
    return this.breach({ ...record, retryAttempt }, record.breach);
  }

  private disposedResult(record: WorkflowRecord): TerminationResult {
    return { state: 'failed', control: 'failed', retryAttempt: record.retryAttempt, message: 'termination coordinator disposed' };
  }

  private isConfirmed(runId: string): boolean {
    const current = this.options.get(runId);
    if (current === undefined) return false;
    const state = current.snapshot.state;
    return state === 'complete' || state === 'failed' || state === 'partial' || state === 'stopped';
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
}
```

The runtime must update the registry from each reconciliation before calling
`isConfirmed`, so the coordinator never treats a control acknowledgement as
terminal proof. During grace and retry, reconcile the whole current-session
snapshot and include any child still belonging to the same root. An
`unknown-control` result schedules retry with bounded backoff and leaves Pi
open. It must not call `ctx.abort()`, `ctx.shutdown()`, `process.kill()`, or a
private pi-subagents module.

- [ ] **Step 4: Add retry verification, run tests, and commit**

Add this test to verify that the coordinator preserves the original breach
across a retry and confirms a later terminal snapshot:

```ts
it('retries the original breach and confirms a later terminal snapshot', async () => {
  const gateway = new FakeGateway();
  let terminal = false;
  const record = {
    snapshot: workflowSnapshot({ state: 'running' }),
    clock: { phase: 'running' as const, observedAt: 1000, executionMs: 101, activityFingerprint: 'x' },
    effectiveLimits: { wallClockMs: 100, inactivityMs: 0, tokenCount: 0, costUsd: 0, toolCalls: 0, turns: 0, activeToolMs: 0 },
    state: 'unknown-control' as const,
    warnedSignals: new Set(),
    breach: { signal: 'wallClockMs' as const, used: 101, limit: 100 },
    retryAttempt: 0,
  };
  const coordinator = new TerminationCoordinator({
    gateway,
    get: () => terminal ? { ...record, snapshot: workflowSnapshot({ state: 'stopped', processTerminal: 'observed' }) } : record,
    reconcile: async () => {
      terminal = true;
    },
    sleep: async () => undefined,
    now: () => 2000,
    graceMs: 1,
    retryBaseMs: 1,
    retryMaxMs: 2,
    onState: vi.fn(),
  });
  const result = await coordinator.retry(record);
  expect(result.state).toBe('confirmed');
  expect(gateway.interrupted).toEqual(['run-1']);
});
```

The coordinator options deliberately contain no parent shutdown callback. A
static assertion that `termination.ts` contains no `ctx.abort`, `ctx.shutdown`,
`process.kill`, or private pi-subagents import completes the no-parent-shutdown
check.

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/termination.test.ts
npm run typecheck
```

Expected: all termination tests PASS and typecheck exits 0.

```bash
git -C /data/pi add extensions/pi-subagent-monitor/src/termination.ts extensions/pi-subagent-monitor/test/termination.test.ts
git -C /data/pi commit -m "feat: add bounded workflow termination"
```

---

## Task 8: Add status formatting, notifications, and operator commands

**Files:**

- Create: `extensions/pi-subagent-monitor/src/presentation.ts`
- Create: `extensions/pi-subagent-monitor/src/commands.ts`
- Create: `extensions/pi-subagent-monitor/test/presentation.test.ts`
- Create: `extensions/pi-subagent-monitor/test/commands.test.ts`

- [ ] **Step 1: Write failing presentation tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { formatStatus, notificationKey, notifyOnce } from '../src/presentation';
import type { WorkflowRecord } from '../src/types';
import { workflowSnapshot } from './support/fakes';

describe('presentation', () => {
  it('formats a compact status without task or transcript text', () => {
    const record: WorkflowRecord = {
      snapshot: workflowSnapshot({ totalTokens: 1200, toolCount: 8, turnCount: 3, currentTool: 'read' }),
      clock: {
        phase: 'running',
        observedAt: 50000,
        executionMs: 55000,
        lastActivityAt: 44000,
        activityFingerprint: 'fingerprint',
      },
      effectiveLimits: {
        wallClockMs: 60000,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      state: 'warning',
      warnedSignals: new Set(['wallClockMs']),
      retryAttempt: 0,
    };
    const text = formatStatus('enforce', [record], 50000);
    expect(text).toContain('1 workflow');
    expect(text).toContain('5s');
    expect(text).toContain('read');
    expect(text).not.toContain('task');
    expect(text).not.toContain('transcript');
  });

  it('deduplicates the same notification key', () => {
    const notify = vi.fn();
    const seen = new Set<string>();
    const key = notificationKey('run-1', 'wallClockMs', 'warning');
    expect(notifyOnce(seen, key, notify, 'time warning', 'warning')).toBe(true);
    expect(notifyOnce(seen, key, notify, 'time warning', 'warning')).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
```

Create `test/commands.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { registerMonitorCommands } from '../src/commands';

describe('monitor commands', () => {
  it('routes the default command to status', async () => {
    const status = vi.fn(async () => undefined);
    const pi = { registerCommand: vi.fn() };
    registerMonitorCommands(pi as never, {
      status,
      setMode: vi.fn(async () => undefined),
      history: vi.fn(async () => undefined),
      extend: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
    });
    const options = pi.registerCommand.mock.calls[0]?.[1] as { handler: (args: string, ctx: unknown) => Promise<void> };
    await options.handler('', {});
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('reports invalid commands without invoking runtime handlers', async () => {
    const notify = vi.fn();
    const pi = { registerCommand: vi.fn() };
    registerMonitorCommands(pi as never, {
      status: vi.fn(async () => undefined),
      setMode: vi.fn(async () => undefined),
      history: vi.fn(async () => undefined),
      extend: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
    });
    const options = pi.registerCommand.mock.calls[0]?.[1] as { handler: (args: string, ctx: { ui: { notify: typeof notify } }) => Promise<void> };
    await options.handler('unknown', { ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Usage:'), 'warning');
  });
});
```

- [ ] **Step 2: Run presentation and command tests and verify RED**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/presentation.test.ts
```

Expected: FAIL because presentation functions are not implemented.

- [ ] **Step 3: Implement pure status and notification helpers**

Create `src/presentation.ts`:

```ts
import type { LimitName, MonitorMode, MonitorState, WorkflowRecord } from './types';

export type NoticeLevel = 'info' | 'warning' | 'error';

export interface MonitorUi {
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, level: NoticeLevel): void;
  confirm(title: string, body: string): Promise<boolean>;
}

function duration(ms: number): string {
  if (ms < 1000) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function timeRemainingMs(record: WorkflowRecord, now: number): number {
  const remaining: number[] = [];
  const limits = record.effectiveLimits;
  if (limits.wallClockMs > 0) {
    const elapsed = record.clock.executionMs + Math.max(0, now - record.clock.observedAt);
    remaining.push(Math.max(0, limits.wallClockMs - elapsed));
  }
  if (limits.inactivityMs > 0 && record.clock.lastActivityAt !== undefined) {
    const idleMs = Math.max(0, now - record.clock.lastActivityAt);
    remaining.push(Math.max(0, limits.inactivityMs - idleMs));
  }
  if (limits.activeToolMs > 0 && record.snapshot.currentToolStartedAt !== undefined) {
    const activeToolMs = Math.max(0, now - record.snapshot.currentToolStartedAt);
    remaining.push(Math.max(0, limits.activeToolMs - activeToolMs));
  }
  return remaining.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...remaining);
}

function budgetText(record: WorkflowRecord, now: number): string {
  const timeBudget = timeRemainingMs(record, now);
  if (timeBudget !== Number.MAX_SAFE_INTEGER) return `time ${duration(timeBudget)}`;
  if (record.effectiveLimits.tokenCount > 0 && record.snapshot.totalTokens !== undefined) {
    return `${Math.max(0, record.effectiveLimits.tokenCount - record.snapshot.totalTokens)} tok`;
  }
  if (record.effectiveLimits.costUsd > 0 && record.snapshot.totalCost !== undefined) {
    return `$${Math.max(0, record.effectiveLimits.costUsd - record.snapshot.totalCost).toFixed(2)}`;
  }
  if (record.effectiveLimits.toolCalls > 0 && record.snapshot.toolCount !== undefined) {
    return `${Math.max(0, record.effectiveLimits.toolCalls - record.snapshot.toolCount)} tools`;
  }
  if (record.effectiveLimits.turns > 0 && record.snapshot.turnCount !== undefined) {
    return `${Math.max(0, record.effectiveLimits.turns - record.snapshot.turnCount)} turns`;
  }
  return 'uncapped';
}

function stateLabel(state: MonitorState): string {
  return state === 'unknown-control' ? 'unknown-control' : state;
}

export function formatStatus(
  mode: MonitorMode,
  records: readonly WorkflowRecord[],
  now: number,
  unconfirmed = 0,
): string | undefined {
  const active = records.filter((record) => record.snapshot.state === 'queued' || record.snapshot.state === 'running');
  const unknown = unconfirmed > 0 ? ` | ${unconfirmed} unconfirmed` : '';
  if (active.length === 0) return `${mode}${unknown}`;
  const first = [...active].sort((left, right) => timeRemainingMs(left, now) - timeRemainingMs(right, now))[0];
  const noun = active.length === 1 ? 'workflow' : 'workflows';
  const tool = first.snapshot.currentTool === undefined ? '' : ` | ${first.snapshot.currentTool}`;
  const counters = first.snapshot.totalTokens === undefined ? '' : ` | ${first.snapshot.totalTokens} tok`;
  return `${mode} | ${active.length} ${noun} | next ${budgetText(first, now)} | ${stateLabel(first.state)}${tool}${counters}${unknown}`;
}

export function notificationKey(runId: string, signal: LimitName | 'gateway', phase: string): string {
  return `${runId}:${signal}:${phase}`;
}

export function notifyOnce(
  seen: Set<string>,
  key: string,
  notify: (message: string, level: NoticeLevel) => void,
  message: string,
  level: NoticeLevel,
): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  notify(message.slice(0, 1000), level);
  return true;
}
```

Keep all raw task/goal/transcript text out of formatting. A status with multiple
workflows must show the count and nearest deadline, not concatenate arbitrary
task labels.

- [ ] **Step 4: Implement command parsing and handlers**

Create `src/commands.ts` around a narrow runtime interface:

```ts
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

export interface MonitorCommandRuntime {
  status(ctx: ExtensionCommandContext): Promise<void>;
  setMode(mode: 'observe' | 'enforce', ctx: ExtensionCommandContext): Promise<void>;
  history(ctx: ExtensionCommandContext): Promise<void>;
  extend(args: string, ctx: ExtensionCommandContext): Promise<void>;
  run(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

export function registerMonitorCommands(pi: ExtensionAPI, runtime: MonitorCommandRuntime): void {
  pi.registerCommand('subagent-monitor', {
    description: 'Inspect and control subagent monitoring',
    handler: async (args, ctx) => {
      const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (command ?? 'status') {
        case 'status':
          await runtime.status(ctx);
          return;
        case 'observe':
          await runtime.setMode('observe', ctx);
          return;
        case 'enforce':
          await runtime.setMode('enforce', ctx);
          return;
        case 'history':
          await runtime.history(ctx);
          return;
        case 'extend':
          await runtime.extend(rest.join(' '), ctx);
          return;
        case 'run':
          await runtime.run(rest.join(' '), ctx);
          return;
        default:
          ctx.ui.notify('Usage: /subagent-monitor status|observe|enforce|history|extend|run', 'warning');
      }
    },
  });
}
```

`extend` must confirm through `ctx.ui.confirm` before raising a stricter run
policy up to the global non-zero ceiling. `run` must parse one bounded JSON
object and pass it through the same wrapper validator as the custom tool;
invalid JSON gets a bounded warning and no launch.

- [ ] **Step 5: Run tests, typecheck, and commit**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/presentation.test.ts test/commands.test.ts
npm run typecheck
```

Expected: presentation and command tests PASS and typecheck exits 0. Runtime
tests in Task 10 cover bounded JSON rejection for the `run` path.

```bash
git -C /data/pi add extensions/pi-subagent-monitor/src/presentation.ts extensions/pi-subagent-monitor/src/commands.ts extensions/pi-subagent-monitor/test/presentation.test.ts extensions/pi-subagent-monitor/test/commands.test.ts
git -C /data/pi commit -m "feat: add monitor status and operator commands"
```

---

## Task 9: Implement the explicit public-API launch wrapper

**Files:**

- Create: `extensions/pi-subagent-monitor/src/wrapper.ts`
- Create: `extensions/pi-subagent-monitor/test/wrapper.test.ts`

- [ ] **Step 1: Write failing wrapper validation and association tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { parseLaunchArgs, resolveLaunch, createLaunchWrapper } from '../src/wrapper';
import { FakeEventBus } from './support/fakes';

describe('launch wrapper', () => {
  it('rejects malformed JSON before launch parsing reaches the wrapper', () => {
    expect(() => parseLaunchArgs('{broken')).toThrow('valid JSON');
    expect(() => parseLaunchArgs('x'.repeat(16001))).toThrow('bounded');
  });

  it('accepts a stricter finite policy and rejects a relaxed global policy', () => {
    const global = {
      wallClockMs: 600000,
      inactivityMs: 120000,
      tokenCount: 100000,
      costUsd: 5,
      toolCalls: 100,
      turns: 20,
      activeToolMs: 90000,
    };
    const request = resolveLaunch({
      kind: 'single',
      agent: 'reviewer',
      task: 'Review the current diff.',
      limits: { wallClockMs: 300000, turns: 10 },
    }, global);
    expect(request.effectiveLimits.wallClockMs).toBe(300000);
    expect(request.effectiveLimits.turns).toBe(10);
    expect(() => resolveLaunch({
      kind: 'single',
      agent: 'reviewer',
      task: 'Review the current diff.',
      limits: { wallClockMs: 900000 },
    }, global)).toThrow('global ceiling');
  });

  it('does not send monitor policy fields through the public RPC payload', async () => {
    const events = new FakeEventBus();
    const requests: unknown[] = [];
    events.on('subagents:rpc:v1:request', (payload) => {
      requests.push(payload);
      const request = payload as { requestId: string };
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: { runId: 'run-9', state: 'running' },
      });
    });
    const wrapper = createLaunchWrapper({
      events,
      sessionId: 'session-1',
      cwd: '/repo',
      globalLimits: {
        wallClockMs: 600000,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      associate: vi.fn(),
    });
    await wrapper.launch({
      kind: 'single',
      agent: 'reviewer',
      task: 'Review the current diff.',
      async: true,
      limits: { wallClockMs: 300000 },
    });
    const spawn = requests[0] as { method: string; params: Record<string, unknown> };
    expect(spawn.method).toBe('spawn');
    expect(spawn.params.monitorPolicy).toBeUndefined();
    expect(spawn.params.policy).toBeUndefined();
  });

  it('rejects unsupported foreground composite overrides before launch', async () => {
    const launcher = createLaunchWrapper({
      events: new FakeEventBus(),
      sessionId: 'session-1',
      cwd: '/repo',
      globalLimits: {
        wallClockMs: 0,
        inactivityMs: 0,
        tokenCount: 0,
        costUsd: 0,
        toolCalls: 0,
        turns: 0,
        activeToolMs: 0,
      },
      associate: vi.fn(),
    });
    await expect(launcher.launch({
      kind: 'parallel-review',
      task: 'Review the current diff.',
      async: false,
      steps: [
        { key: 'correctness', agent: 'reviewer', task: 'Check correctness.' },
        { key: 'tests', agent: 'reviewer', task: 'Check tests.' },
      ],
      limits: { wallClockMs: 300000 },
    })).rejects.toThrow('foreground composite');
  });
});
```

- [ ] **Step 2: Run wrapper tests and verify RED**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/wrapper.test.ts
```

Expected: FAIL because wrapper exports do not yet exist.

- [ ] **Step 3: Define the TypeBox request schema and policy resolver**

Create `src/wrapper.ts` with a strict schema. Use `StringEnum` for all string
enums, matching Pi’s Google-compatible schema guidance.

```ts
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { resolveLimits } from './config';
import type {
  EventBus,
  LaunchRequest,
  LaunchReceipt,
  Limits,
} from './types';

export const LIMITS_SCHEMA = Type.Object({
  wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })),
  inactivityMs: Type.Optional(Type.Integer({ minimum: 0 })),
  tokenCount: Type.Optional(Type.Integer({ minimum: 0 })),
  costUsd: Type.Optional(Type.Number({ minimum: 0 })),
  toolCalls: Type.Optional(Type.Integer({ minimum: 0 })),
  turns: Type.Optional(Type.Integer({ minimum: 0 })),
  activeToolMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

export interface LaunchWrapper {
  launch(request: LaunchRequest): Promise<LaunchReceipt>;
}

export interface LaunchWrapperOptions {
  events: EventBus;
  sessionId: string;
  cwd: string;
  globalLimits: Limits;
  associate(runId: string, limits: Limits): void;
}

export const LAUNCH_SCHEMA = Type.Object({
  kind: StringEnum(['single', 'parallel-review', 'review-loop', 'implement-review', 'chain-parallel'] as const),
  task: Type.String({ minLength: 1, maxLength: 16000 }),
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  steps: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ minLength: 1, maxLength: 128 }),
    agent: Type.String({ minLength: 1, maxLength: 128 }),
    task: Type.String({ minLength: 1, maxLength: 16000 }),
  }), { maxItems: 16 })),
  async: Type.Optional(Type.Boolean()),
  limits: Type.Optional(LIMITS_SCHEMA),
});

export function resolveLaunch(request: LaunchRequest, globalLimits: Limits): { request: LaunchRequest; effectiveLimits: Limits } {
  if (request.task.length === 0 || request.task.length > 16000) throw new Error('task must contain 1-16000 characters');
  if (request.kind === 'single' && !request.agent) throw new Error('single launch requires agent');
  if (request.kind !== 'single' && (!request.steps || request.steps.length === 0)) throw new Error('workflow launch requires steps');
  if (request.async === false && request.kind !== 'single') throw new Error('foreground composite overrides are unsupported');
  return {
    request,
    effectiveLimits: resolveLimits(globalLimits, request.limits ?? {}),
  };
}

export function parseLaunchArgs(args: string): unknown {
  const text = args.trim();
  if (text.length === 0 || text.length > 16000) throw new Error('run arguments must be bounded');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('run arguments must be valid JSON');
  }
}
```

Use TypeBox `Value.Check` or the package’s schema validation path in the tool
execution boundary. Do not concatenate task text into shell commands. The
wrapper sends task text only to the documented launch contract and stores only
the resulting run metrics.

- [ ] **Step 4: Implement public foreground and detached launch association**

Add a `createLaunchWrapper` factory that accepts `EventBus`, session ID, current
working directory, global limits, and an `associate(runId, limits)` callback.
Its exported return type is `LaunchWrapper`. For detached launches, emit only
documented RPC fields:

```ts
import { randomUUID } from 'node:crypto';

const requestId = randomUUID();
events.emit('subagents:rpc:v1:request', {
  version: 1,
  requestId,
  method: 'spawn',
  params: {
    agent: request.agent,
    task: request.task,
    async: true,
  },
});
```

Associate the returned `runId` with the already validated effective limits as
soon as the reply arrives. For foreground single-child launches, emit the
documented structured delegation request with `ownerRunId`, `nodeId`, `agent`,
`task`, `context`, `cwd`, and `result: { kind: 'text' }`; retain the effective
policy by `requestId` until a started/update response supplies `runId`.
Subscribe to `prompt-template:subagent:started`,
`prompt-template:subagent:update`, and `prompt-template:subagent:response` only
for association; do not scrape transcript text.

The wrapper must reject unsupported foreground composite requests before
emitting anything. Ordinary direct composite foreground calls remain globally
observed, with any unidentifiable control target shown as `unknown-control`
rather than passed to an unsafe guessed ID.

- [ ] **Step 5: Run wrapper tests, typecheck, and commit**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/wrapper.test.ts
npm run typecheck
```

Expected: all wrapper tests PASS and typecheck exits 0.

```bash
git -C /data/pi add extensions/pi-subagent-monitor/src/wrapper.ts extensions/pi-subagent-monitor/test/wrapper.test.ts
git -C /data/pi commit -m "feat: add bounded monitored launch wrapper"
```

---

## Task 10: Wire the runtime lifecycle and Pi extension entrypoint

**Files:**

- Create: `extensions/pi-subagent-monitor/src/runtime.ts`
- Create: `extensions/pi-subagent-monitor/src/index.ts`
- Create: `extensions/pi-subagent-monitor/test/runtime.test.ts`
- Create: `extensions/pi-subagent-monitor/test/index.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Create fake Pi and context helpers in the test support file, then write tests
that prove startup is deferred to `session_start`, enforcement is explicit,
polling reconciles, and shutdown clears status/timers.

```ts
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { MonitorRuntime } from '../src/runtime';
import monitorExtension from '../src';
import { DEFAULT_CONFIG } from '../src/config';
import { MetricsStore } from '../src/history';
import { RunRegistry } from '../src/registry';
import { FakeEventBus, FakeGateway, gatewaySnapshot, workflowSnapshot } from './support/fakes';

describe('extension lifecycle', () => {
  it('registers the tool and command without starting a timer in the factory', () => {
    const pi = {
      events: new FakeEventBus(),
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    };
    monitorExtension(pi as never);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(pi.registerCommand).toHaveBeenCalledWith('subagent-monitor', expect.any(Object));
    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
  });

  it('keeps Pi open when a control remains unknown', async () => {
    const gateway = new FakeGateway();
    const notify = vi.fn();
    const shutdown = vi.fn();
    let currentNow = 1000;
    const ui = { setStatus: vi.fn(), notify, confirm: vi.fn(async () => false) };
    const history = { append: vi.fn(async () => undefined), list: vi.fn(async () => []) } as unknown as MetricsStore;
    const runtime = new MonitorRuntime({
      loadConfig: async () => ({
        config: {
          ...DEFAULT_CONFIG,
          mode: 'enforce',
          limits: { ...DEFAULT_CONFIG.limits, wallClockMs: 100 },
        },
      }),
      connectGateway: async () => gateway,
      createRegistry: (sessionId) => new RunRegistry(sessionId),
      createHistory: () => history,
      createWrapper: () => ({ launch: vi.fn() }),
      ui: () => ui,
      now: () => currentNow,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: vi.fn(),
      setTimeout: (callback, delayMs) => {
        if (delayMs === 15000) callback();
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
    });
    const context = {
      ui,
      hasUI: true,
      mode: 'tui',
      shutdown,
      sessionManager: { getSessionId: () => 'session-1' },
    } as unknown as ExtensionContext;
    gateway.current = gatewaySnapshot([workflowSnapshot({ processTerminal: 'unknown' })]);
    await runtime.start(context);
    currentNow = 1000000;
    await runtime.reconcile(currentNow);
    expect(notify).toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });
});
```

Inject `RuntimeDependencies` into `MonitorRuntime` so tests can use
deterministic fakes. Keep `createMonitorRuntime(pi)` as the production factory
and expose only the public `MonitorRuntime` methods needed by commands.

- [ ] **Step 2: Run lifecycle tests and verify RED**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/runtime.test.ts test/index.test.ts
```

Expected: FAIL because the runtime and extension factory are not implemented.

- [ ] **Step 3: Implement session-scoped runtime orchestration**

Create `src/runtime.ts` with dependency injection for config loading, gateway
connection, timer functions, history, and UI. The runtime sequence is:

1. Load config; malformed config falls back to observe/zero limits and emits one
   bounded error.
2. Connect to the documented gateway at `session_start`.
3. Subscribe to gateway wake-ups and start the configured local reconciliation
   interval only after startup.
4. Query status, reconcile the registry, evaluate each active record, update
   status/notifications, and invoke termination only in enforce mode.
5. On terminal records, append a `HistoryRecord` once.
6. On unknown control, schedule bounded retries without calling parent shutdown.
7. On `session_shutdown`, clear every interval/retry timer, dispose the gateway,
   clear status, and prevent late async callbacks from controlling runs.

Use this lifecycle shape:

```ts
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { dirname, join } from 'node:path';
import { configPath, DEFAULT_CONFIG, loadConfig, type ConfigLoadResult } from './config';
import { connectGateway } from './gateway';
import { evaluatePolicy } from './policy';
import { MetricsStore } from './history';
import { RunRegistry } from './registry';
import { TerminationCoordinator } from './termination';
import { formatStatus, notificationKey, notifyOnce, type MonitorUi } from './presentation';
import { createLaunchWrapper, type LaunchWrapper } from './wrapper';
import type { GatewayConnection, HistoryRecord, Limits, MonitorConfig, MonitorMode, WorkflowRecord } from './types';

export interface RuntimeDependencies {
  loadConfig(): Promise<ConfigLoadResult>;
  connectGateway(sessionId: string): Promise<GatewayConnection>;
  createRegistry(sessionId: string): RunRegistry;
  createHistory(config: MonitorConfig): MetricsStore;
  createWrapper(sessionId: string, globalLimits: Limits, associate: (runId: string, limits: Limits) => void, cwd: string): LaunchWrapper;
  ui(ctx: ExtensionContext): MonitorUi;
  now(): number;
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export class MonitorRuntime {
  private config: MonitorConfig = structuredClone(DEFAULT_CONFIG);
  private gateway: GatewayConnection | undefined;
  private registry: RunRegistry | undefined;
  private history: MetricsStore | undefined;
  private wrapper: LaunchWrapper | undefined;
  private termination: TerminationCoordinator | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private wakeDispose: (() => void) | undefined;
  private ui: MonitorUi | undefined;
  private started = false;
  private stopped = false;
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
    this.ui = this.dependencies.ui(ctx);
    const loaded = await this.dependencies.loadConfig();
    this.config = loaded.config;
    if (loaded.error) this.ui.notify(loaded.error, 'error');
    const sessionId = ctx.sessionManager.getSessionId();
    this.registry = this.dependencies.createRegistry(sessionId);
    this.history = this.dependencies.createHistory(this.config);
    this.wrapper = this.dependencies.createWrapper(sessionId, this.config.limits, (runId, limits) => {
      this.associatePolicy(runId, limits);
    }, ctx.cwd);
    try {
      this.gateway = await this.dependencies.connectGateway(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'pi-subagents gateway unavailable';
      this.ui.notify(`Subagent monitor degraded: ${message}`, 'error');
      this.ui.setStatus('subagent-monitor', 'degraded');
      return;
    }
    if (this.stopped) {
      this.gateway.dispose();
      this.gateway = undefined;
      return;
    }
    this.termination = new TerminationCoordinator({
      gateway: this.gateway,
      get: (runId) => this.registry?.get(runId),
      reconcile: () => this.reconcile(this.dependencies.now()),
      sleep: (delayMs) => new Promise((resolve) => {
        this.dependencies.setTimeout(resolve, delayMs);
      }),
      now: () => this.dependencies.now(),
      graceMs: this.config.terminationGraceMs,
      retryBaseMs: this.config.retryBaseMs,
      retryMaxMs: this.config.retryMaxMs,
      onState: (runId, state) => this.setMonitorState(runId, state),
    });
    this.wakeDispose = this.gateway.onWake(() => {
      void this.reconcile(this.dependencies.now()).catch((error) => this.reportError(error));
    });
    if (this.stopped) return;
    this.interval = this.dependencies.setInterval(() => {
      void this.reconcile(this.dependencies.now()).catch((error) => this.reportError(error));
    }, this.config.pollIntervalMs);
    try {
      await this.reconcile(this.dependencies.now());
    } catch (error) {
      this.reportError(error);
    }
  }

  public async reconcile(now: number): Promise<void> {
    if (this.stopped || this.gateway === undefined || this.registry === undefined) return;
    const snapshot = await this.gateway.status();
    if (this.stopped) return;
    this.unconfirmed = snapshot.unconfirmed;
    this.registry.reconcile(snapshot, now, (workflow) => this.resolveLimits(workflow.id));
    for (const record of this.registry.active()) await this.evaluate(record, now);
    await this.persistTerminalRecords(now);
    this.render(now);
  }

  public async stop(): Promise<void> {
    await this.persistTerminalRecords(this.dependencies.now(), true);
    this.stopped = true;
    if (this.interval !== undefined) this.dependencies.clearInterval(this.interval);
    this.interval = undefined;
    this.wakeDispose?.();
    this.wakeDispose = undefined;
    for (const timer of this.retryTimers.values()) this.dependencies.clearTimeout(timer);
    this.retryTimers.clear();
    this.termination?.dispose();
    this.gateway?.dispose();
    this.gateway = undefined;
    this.ui?.setStatus('subagent-monitor', undefined);
  }

  public mode(): MonitorMode {
    return this.config.mode;
  }

  public associatePolicy(runId: string, limits: Limits): void {
    this.runPolicies.set(runId, limits);
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
    if (evaluation.breach === undefined || this.config.mode !== 'enforce' || record.state === 'terminating' || record.state === 'unknown-control' || record.state === 'confirmed') {
      this.registry?.update(record);
      return;
    }
    record.breach = evaluation.breach;
    record.state = 'terminating';
    this.registry?.update(record);
    if (this.termination === undefined) return;
    const result = await this.termination.breach(record, evaluation.breach);
    record.retryAttempt = result.retryAttempt;
    record.state = result.state === 'confirmed' ? 'confirmed' : 'unknown-control';
    this.registry?.update(record);
    if (result.state === 'unknown-control') this.scheduleRetry(record);
  }

  private scheduleRetry(record: WorkflowRecord): void {
    if (this.retryTimers.has(record.snapshot.id) || this.termination === undefined) return;
    const delay = Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** record.retryAttempt);
    const timer = this.dependencies.setTimeout(() => {
      this.retryTimers.delete(record.snapshot.id);
      void this.termination?.retry(record).then((result) => {
        const current = this.registry?.get(record.snapshot.id);
        if (current === undefined) return;
        current.retryAttempt = result.retryAttempt;
        current.state = result.state === 'confirmed' ? 'confirmed' : 'unknown-control';
        this.registry?.update(current);
        if (result.state === 'unknown-control') this.scheduleRetry(current);
        this.render(this.dependencies.now());
      });
    }, delay);
    this.retryTimers.set(record.snapshot.id, timer);
  }

  private async persistTerminalRecords(now: number, includeUnresolved = false): Promise<void> {
    if (this.registry === undefined || this.history === undefined) return;
    for (const record of this.registry.all()) {
      const state = record.snapshot.state;
      const terminal = state === 'complete' || state === 'failed' || state === 'partial' || state === 'stopped' || state === 'rejected'
        || (includeUnresolved && record.state === 'unknown-control');
      if (!terminal || this.persisted.has(record.snapshot.id)) continue;
      const historyRecord: HistoryRecord = {
        version: 1,
        recordedAt: now,
        runId: record.snapshot.id,
        kind: record.snapshot.kind,
        childCount: record.snapshot.children.length,
        durationMs: record.clock.executionMs,
        finalState: state === 'complete' || state === 'failed' || state === 'stopped' ? state : record.state,
        ...(record.breach === undefined ? {} : { trigger: record.breach.signal }),
        ...(record.snapshot.totalTokens === undefined ? {} : { totalTokens: record.snapshot.totalTokens }),
        ...(record.snapshot.totalCost === undefined ? {} : { totalCost: record.snapshot.totalCost }),
        ...(record.snapshot.toolCount === undefined ? {} : { toolCalls: record.snapshot.toolCount }),
        ...(record.snapshot.turnCount === undefined ? {} : { turns: record.snapshot.turnCount }),
        controlOutcome: record.state === 'confirmed' ? 'confirmed' : record.state === 'unknown-control' ? 'unknown' : 'not-needed',
        retryAttempts: record.retryAttempt,
      };
      try {
        await this.history.append(historyRecord);
        this.persisted.add(record.snapshot.id);
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'monitor reconciliation failed';
    this.ui?.notify(`Subagent monitor degraded: ${message}`, 'error');
    this.ui?.setStatus('subagent-monitor', 'degraded');
  }

  private setMonitorState(runId: string, state: 'terminating' | 'confirmed' | 'unknown-control'): void {
    const record = this.registry?.get(runId);
    if (record === undefined) return;
    record.state = state;
    this.registry?.update(record);
  }

  private render(now: number): void {
    if (this.registry === undefined || this.ui === undefined) return;
    this.ui.setStatus('subagent-monitor', formatStatus(this.config.mode, this.registry.all(), now, this.unconfirmed));
  }
}

export function createMonitorRuntime(pi: ExtensionAPI): MonitorRuntime {
  const configFile = configPath();
  const historyFile = join(dirname(configFile), 'history.json');
  return new MonitorRuntime({
    loadConfig: () => loadConfig(configFile),
    connectGateway: (sessionId) => connectGateway({
      events: pi.events,
      sessionId,
      readyTimeoutMs: 2000,
      requestTimeoutMs: 2000,
    }),
    createRegistry: (sessionId) => new RunRegistry(sessionId),
    createHistory: (config) => new MetricsStore(historyFile, config.historyMaxEntries),
    createWrapper: (sessionId, globalLimits, associate, cwd) => createLaunchWrapper({
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
```

Add public command/tool methods to `MonitorRuntime` with these exact signatures:
`status(ctx: ExtensionCommandContext): Promise<void>`, `setMode(mode:
MonitorMode, ctx: ExtensionCommandContext): Promise<void>`, `history(ctx:
ExtensionCommandContext): Promise<void>`, `extend(args: string, ctx:
ExtensionCommandContext): Promise<void>`, `run(args: string, ctx:
ExtensionCommandContext): Promise<void>`, `toolStatus(): { content: Array<{
type: 'text'; text: string }>; details: Record<string, unknown> }`, and
`toolRun(request: unknown, ctx: ExtensionContext): Promise<{ content: Array<{
type: 'text'; text: string }>; details: Record<string, unknown> }>`.

`status` formats `registry.all()` through `formatStatus` and sends a bounded
notification; `setMode` changes only in-memory session mode; `history` renders
at most the configured history cap; `extend` confirms and updates only a
stricter policy up to the global ceiling; `run` parses bounded JSON and calls
`LaunchWrapper`; `toolStatus` and `toolRun` use the same command/runtime paths.
The production class must not contain `ctx.shutdown`, `ctx.abort`,
`process.kill`, or direct filesystem scans of pi-subagents artifacts.
`start(ctx)` must take current-session identity from
`ctx.sessionManager.getSessionId()` and pass it to the gateway.

- [ ] **Step 4: Implement the Pi factory and custom tool**

Create `src/index.ts`:

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { registerMonitorCommands } from './commands';
import { createMonitorRuntime } from './runtime';
import { LAUNCH_SCHEMA } from './wrapper';

export default function piSubagentMonitor(pi: ExtensionAPI): void {
  const runtime = createMonitorRuntime(pi);

  pi.registerTool({
    name: 'subagent_monitor',
    label: 'Monitored Subagent',
    description: 'Launch a bounded pi-subagents run with an optional stricter monitor policy.',
    promptSnippet: 'Launch or inspect a subagent workflow under explicit safety limits',
    parameters: Type.Object({
      operation: StringEnum(['run', 'status'] as const),
      request: Type.Optional(LAUNCH_SCHEMA),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.operation === 'status') return runtime.toolStatus();
      return runtime.toolRun(params.request, ctx);
    },
  });

  registerMonitorCommands(pi, runtime);
  pi.on('session_start', async (_event, ctx) => {
    await runtime.start(ctx);
  });
  pi.on('session_shutdown', async () => {
    await runtime.stop();
  });
}
```

The runtime’s public tool result must include bounded status/effective policy
text and `details` with opaque run identity only.

- [ ] **Step 5: Run lifecycle tests and commit**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test -- --run test/runtime.test.ts test/index.test.ts
npm run typecheck
```

Expected: all lifecycle tests PASS and typecheck exits 0. Run the complete local
test suite before committing:

```bash
npm test
```

Expected: every test file passes with zero failures.

```bash
git -C /data/pi add extensions/pi-subagent-monitor/src/runtime.ts extensions/pi-subagent-monitor/src/index.ts extensions/pi-subagent-monitor/test/runtime.test.ts extensions/pi-subagent-monitor/test/index.test.ts
git -C /data/pi commit -m "feat: wire subagent monitor lifecycle"
```

---

## Task 11: Document installation, configuration, and safety behavior

**Files:**

- Create: `extensions/pi-subagent-monitor/README.md`
- Modify: `/data/pi/README.md`

- [ ] **Step 1: Write the extension README**

Create `extensions/pi-subagent-monitor/README.md` with these sections and
concrete examples:

1. Purpose: explain runaway review/fix/re-review cost protection.
2. Install:

```bash
pi install npm:pi-subagent-monitor
```

1. Observe-only default: state that a fresh install does not stop work and all
   actual limits are `0`.
2. Configuration path: `~/.pi/agent/extensions/pi-subagent-monitor/config.json`.
3. Configuration example:

```json
{
  "mode": "enforce",
  "limits": {
    "wallClockMs": 3600000,
    "inactivityMs": 600000,
    "tokenCount": 200000,
    "costUsd": 0,
    "toolCalls": 0,
    "turns": 0,
    "activeToolMs": 900000
  },
  "warningLeadMs": 60000,
  "terminationGraceMs": 15000
}
```

1. Explain that `0` disables an actual limit, paused time does not consume
   wall-clock execution time, token totals are authoritative when reported, and
   missing dollar cost stays unknown.
2. Commands: document `status`, `observe`, `enforce`, `history`, `extend`, and
   JSON-based `run` usage.
3. Control behavior: graceful interrupt, bounded escalation/retry, confirmed
   terminal proof, `unknown-control`, and the fact that Pi remains open.
4. Compatibility: current documented pi-subagents RPC/event contracts, TUI/RPC
   support, no private imports, no model-generated ETA, and no direct process
   kill.
5. Troubleshooting: run pi-subagents’ own doctor/status controls when the
    gateway is unavailable and inspect the monitor’s persistent status without
    expecting it to claim a stop.

Do not include real credentials, private paths beyond the documented config
path, transcripts, or task content in examples.

- [ ] **Step 2: Update the monorepo README extension table**

Add one row immediately after `pi-prompt-queue`:

```markdown
| [pi-subagent-monitor](./extensions/pi-subagent-monitor) | Monitor subagent workflow time, activity, usage, and safety limits |
```

Do not change the existing Pi introduction or the `pi-prompt-queue` row.

- [ ] **Step 3: Run documentation checks and commit**

Run:

```bash
cd /data/pi/extensions/pi-subagent-monitor
markdownlint --fix README.md
markdownlint README.md
cd /data/pi
markdownlint --fix README.md
markdownlint README.md
git diff --check
```

Expected: both README files pass Markdownlint and `git diff --check` exits 0.

```bash
git -C /data/pi add extensions/pi-subagent-monitor/README.md README.md
git -C /data/pi commit -m "docs: document subagent monitor usage"
```

---

## Task 12: Run the complete quality gate and verify scope

**Files:**

- Modify: only files already listed in this plan if formatting requires it
- Do not stage: `extensions/pi-chat/`

- [ ] **Step 1: Install from the package lockfile**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm ci
```

Expected: exit 0 with the lockfile and package manifest in sync.

- [ ] **Step 2: Run formatting and static checks**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm run format:check
npm run typecheck
markdownlint README.md
cd /data/pi
markdownlint README.md
git diff --check
```

Expected: every command exits 0. If formatting differs, run `npm run format`,
inspect the diff, and commit the formatting-only correction before continuing.

- [ ] **Step 3: Run all automated tests**

```bash
cd /data/pi/extensions/pi-subagent-monitor
npm test
```

Expected: every unit/integration/presentation/lifecycle test passes with zero
failures. The suite must cover capability failure, event loss, current-session
filtering, paused clocks, all limit types, warning deduplication, child
discovery during grace, unknown-control retry, no-parent-shutdown behavior,
wrapper rejection, and history redaction.

- [ ] **Step 4: Run a no-model module-load smoke test**

From the package directory, import the extension entrypoint without constructing
a Pi session or submitting a model prompt:

```bash
cd /data/pi/extensions/pi-subagent-monitor
node --experimental-strip-types --input-type=module -e "await import('./src/index.ts')"
```

Expected: the module imports with exit code 0 and starts no timers, child runs,
or model requests. A missing peer dependency must fail with its package name;
resolve that dependency through the package manifest rather than switching to a
private or external runner.

- [ ] **Step 5: Verify the final diff is scoped**

```bash
cd /data/pi
git status --short --branch
git diff --stat origin/main...HEAD
git log --oneline --decorate -12
```

Expected: tracked changes are limited to the approved files under
`docs/agent/specs/` and `docs/agent/plans/`, the new
`extensions/pi-subagent-monitor/` package, the root README row, and commits
created by this plan. The pre-existing untracked `extensions/pi-chat/` remains
untracked and is not included in any commit.

- [ ] **Step 6: Commit any final test/documentation correction**

Only if Steps 1–5 required a correction, stage the exact changed files and use a
focused message:

```bash
git -C /data/pi add extensions/pi-subagent-monitor README.md
git -C /data/pi commit -m "chore: finalize subagent monitor quality checks"
```

Expected: no ignored files are staged, `git status --short` still shows only the
intentionally untracked `extensions/pi-chat/` if no unrelated work was added,
and the final verification commands are rerun after this commit.

## Spec coverage checklist

- **Standalone companion and current public API:** Tasks 1, 4, 9, and 10.
- **Current-session foreground/background discovery:** Tasks 4, 5, and 10.
- **TUI/RPC status and notifications:** Tasks 8 and 10.
- **Observe-only default and zero-disabled limits:** Task 2 and Task 10.
- **Wall-clock, inactivity, token, cost, tool, turn, and active-tool limits:**
  Task 3.
- **Telemetry-only progress and remaining safety budget:** Tasks 3 and 8.
- **Pause-aware execution clock:** Tasks 3 and 5.
- **80% counter warnings and time lead warnings:** Task 3.
- **Aggregate workflow-tree termination:** Task 7.
- **Graceful escalation, proof, unknown control, and bounded retry:** Task 7.
- **Keep Pi open after control failure:** Tasks 7 and 10.
- **Metrics-only bounded history:** Task 6.
- **Tighten-only per-run overrides and active extension:** Tasks 2, 8, and 9.
- **Supported wrapper launch shapes and unsupported foreground composites:**
  Task 9.
- **No private imports, process kill, prompt edits, or execution-mode
  fallback:** Tasks 4, 7, 9, and 10.
- **README and monorepo documentation:** Task 11.
- **Automated and manual verification:** Task 12.
