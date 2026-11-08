export type MonitorMode = 'observe' | 'enforce';

export type WorkflowState =
  'queued' | 'running' | 'paused' | 'complete' | 'failed' | 'partial' | 'stopped' | 'rejected';

export type WorkflowKind = 'foreground' | 'background';

export type LimitName =
  'wallClockMs' | 'inactivityMs' | 'tokenCount' | 'costUsd' | 'toolCalls' | 'turns' | 'activeToolMs';

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

export type ControlTarget = { kind: 'run'; runId: string } | { kind: 'foreground-current' };

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

export type MonitorState = 'observed' | 'warning' | 'terminating' | 'confirmed' | 'unknown-control' | 'degraded';

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

export type LaunchKind = 'single' | 'parallel-review' | 'review-loop' | 'implement-review' | 'chain-parallel';

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
