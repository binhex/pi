import { randomUUID } from 'node:crypto';
import type {
  ChildSnapshot,
  ControlReceipt,
  ControlTarget,
  EventBus,
  GatewayCapability,
  GatewayConnection,
  GatewaySnapshot,
  WorkflowKind,
  WorkflowSnapshot,
  WorkflowState,
} from './types';

export const READY_EVENT = 'subagents:rpc:v1:ready';
export const REQUEST_EVENT = 'subagents:rpc:v1:request';
const REPLY_PREFIX = 'subagents:rpc:v1:reply:';
const PROTOCOL_VERSION = 1;
const MAX_ID_LENGTH = 256;
const MAX_EVENT_NAME_LENGTH = 256;

export interface GatewayOptions {
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

interface RpcRequest {
  version: number;
  requestId: string;
  method: string;
  params: Record<string, unknown>;
}

class GatewayRequestError extends Error {
  public constructor(
    message: string,
    public readonly timedOut = false,
  ) {
    super(message);
    this.name = 'GatewayRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, max = MAX_ID_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\r\n]/.test(value)) {
    throw new Error(`${field} must be a bounded string`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max = MAX_ID_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedString(value, field, max);
}

function boundedNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
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
  const message =
    isRecord(reply.error) && typeof reply.error.message === 'string'
      ? reply.error.message.slice(0, 1000)
      : 'pi-subagents RPC request failed';
  return new GatewayRequestError(message);
}

function isTimeout(error: unknown): boolean {
  return error instanceof GatewayRequestError && error.timedOut;
}

function request(
  events: EventBus,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  requestIdFactory: () => string,
): Promise<unknown> {
  const requestId = boundedString(requestIdFactory(), 'requestId');
  const requestPayload: RpcRequest = {
    version: PROTOCOL_VERSION,
    requestId,
    method,
    params,
  };
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const replyEvent = `${REPLY_PREFIX}${requestId}`;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    };
    const unsubscribe = events.on(replyEvent, (payload) => {
      if (settled) return;
      try {
        const reply = requireRecord(payload, 'RPC reply') as unknown as RpcReply;
        if (reply.version !== PROTOCOL_VERSION) throw new GatewayRequestError('unsupported pi-subagents RPC version');
        if (reply.requestId !== requestId) throw new GatewayRequestError('pi-subagents RPC reply request mismatch');
        if (typeof reply.success !== 'boolean') throw new GatewayRequestError('invalid pi-subagents RPC reply');
        settled = true;
        cleanup();
        if (!reply.success) reject(replyError(reply));
        else resolve(reply.data);
      } catch (error) {
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new GatewayRequestError('invalid pi-subagents RPC reply'));
      }
    });
    const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new GatewayRequestError(`pi-subagents RPC ${method} timed out`, true));
    }, safeTimeout);
    try {
      events.emit(REQUEST_EVENT, requestPayload);
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new GatewayRequestError('failed to emit pi-subagents RPC request'));
    }
  });
}

function control(
  events: EventBus,
  method: 'interrupt' | 'stop',
  target: ControlTarget,
  timeoutMs: number,
  requestIdFactory: () => string,
): Promise<ControlReceipt> {
  let params: Record<string, unknown>;
  try {
    params = target.kind === 'run' ? { id: boundedString(target.runId, 'runId') } : {};
  } catch (error) {
    return Promise.resolve({
      state: 'rejected' as const,
      runId: target.kind === 'run' ? target.runId : undefined,
      message: error instanceof Error ? error.message.slice(0, 500) : 'invalid control target',
    });
  }
  return request(events, method, params, timeoutMs, requestIdFactory)
    .then((data) => normalizeControlReceipt(data, target))
    .catch((error: unknown) => ({
      state: 'unknown' as const,
      runId: target.kind === 'run' ? target.runId : undefined,
      message: error instanceof Error ? error.message.slice(0, 500) : 'pi-subagents control request failed',
    }));
}

function normalizeControlReceipt(value: unknown, target: ControlTarget): ControlReceipt {
  const data = isRecord(value) ? value : {};
  const state = data.state;
  const accepted = data.accepted === true || state === 'accepted' || data.ok === true;
  const rejected = data.rejected === true || state === 'rejected' || data.ok === false;
  const message =
    typeof data.message === 'string'
      ? data.message.slice(0, 500)
      : accepted
        ? `${state === 'accepted' ? 'control' : 'control request'} accepted`
        : rejected
          ? 'control request rejected'
          : 'control result is unknown';
  return {
    state: accepted ? 'accepted' : rejected ? 'rejected' : 'unknown',
    runId: target.kind === 'run' ? target.runId : optionalString(data.runId, 'runId'),
    message,
  };
}

function stateFrom(value: unknown, fallback: WorkflowState = 'running'): WorkflowState {
  if (typeof value !== 'string') return fallback;
  switch (value.toLowerCase()) {
    case 'queued':
    case 'pending':
      return 'queued';
    case 'running':
    case 'active':
      return 'running';
    case 'paused':
    case 'suspended':
      return 'paused';
    case 'complete':
    case 'completed':
    case 'done':
      return 'complete';
    case 'failed':
    case 'error':
      return 'failed';
    case 'partial':
      return 'partial';
    case 'stopped':
    case 'cancelled':
    case 'canceled':
    case 'interrupted':
      return 'stopped';
    case 'rejected':
      return 'rejected';
    default:
      return fallback;
  }
}

function kindFrom(value: unknown, fallback: WorkflowKind): WorkflowKind {
  if (typeof value !== 'string') return fallback;
  const lower = value.toLowerCase();
  return lower === 'foreground' || lower === 'current' ? 'foreground' : 'background';
}

function processTerminalFrom(value: unknown): 'observed' | 'unknown' | 'unavailable' {
  if (value === 'observed' || value === 'unknown' || value === 'unavailable') return value;
  if (value === true) return 'observed';
  if (value === false) return 'unknown';
  if (isRecord(value)) {
    if (value.observed === true || value.terminal === true || value.exited === true) return 'observed';
    if (value.available === false) return 'unavailable';
  }
  return 'unknown';
}

function valueFrom(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function usageFrom(source: Record<string, unknown>): {
  totalTokens?: number;
  totalCost?: number;
  toolCount?: number;
  turnCount?: number;
} {
  const usage = isRecord(source.usage) ? source.usage : isRecord(source.metrics) ? source.metrics : {};
  return {
    totalTokens: boundedNumber(
      valueFrom(source, 'totalTokens', 'tokens', 'tokenCount') ??
        valueFrom(usage, 'totalTokens', 'tokens', 'tokenCount'),
      'totalTokens',
    ),
    totalCost: boundedNumber(
      valueFrom(source, 'totalCost', 'costUsd', 'cost') ?? valueFrom(usage, 'totalCost', 'costUsd', 'cost'),
      'totalCost',
    ),
    toolCount: boundedNumber(
      valueFrom(source, 'toolCount', 'toolCalls') ?? valueFrom(usage, 'toolCount', 'toolCalls'),
      'toolCount',
    ),
    turnCount: boundedNumber(
      valueFrom(source, 'turnCount', 'turns') ?? valueFrom(usage, 'turnCount', 'turns'),
      'turnCount',
    ),
  };
}

function normalizeChild(value: unknown, index: number): ChildSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalString(valueFrom(value, 'id', 'nodeId', 'key'), `children[${index}].id`);
  if (id === undefined) return undefined;
  const activity = isRecord(value.activity) ? value.activity : {};
  const tool = isRecord(value.tool) ? value.tool : {};
  const usage = usageFrom(value);
  return {
    id,
    state: stateFrom(valueFrom(value, 'state', 'status'), 'running'),
    runId: optionalString(valueFrom(value, 'runId', 'childRunId'), `children[${index}].runId`),
    agent: optionalString(value.agent, `children[${index}].agent`, 128),
    startedAt: boundedNumber(valueFrom(value, 'startedAt', 'startTime'), `children[${index}].startedAt`),
    lastActivityAt: boundedNumber(
      valueFrom(value, 'lastActivityAt') ?? valueFrom(activity, 'lastActivityAt', 'lastMeaningfulAt', 'at'),
      `children[${index}].lastActivityAt`,
    ),
    currentTool: optionalString(
      valueFrom(value, 'currentTool') ?? valueFrom(tool, 'name') ?? valueFrom(activity, 'currentTool'),
      `children[${index}].currentTool`,
      128,
    ),
    currentToolStartedAt: boundedNumber(
      valueFrom(value, 'currentToolStartedAt') ??
        valueFrom(tool, 'startedAt') ??
        valueFrom(activity, 'currentToolStartedAt'),
      `children[${index}].currentToolStartedAt`,
    ),
    ...usage,
  };
}

function normalizeWorkflow(
  value: unknown,
  sessionId: string,
  fallbackKind: WorkflowKind,
): WorkflowSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalString(valueFrom(value, 'id', 'runId'), 'workflow.id');
  if (id === undefined) return undefined;
  const activity = isRecord(value.activity) ? value.activity : {};
  const tool = isRecord(value.tool) ? value.tool : {};
  const usage = usageFrom(value);
  const childValues = valueFrom(value, 'children', 'nodes', 'steps');
  const children = Array.isArray(childValues)
    ? childValues
        .map((child, index) => normalizeChild(child, index))
        .filter((child): child is ChildSnapshot => child !== undefined)
    : [];
  const state = stateFrom(valueFrom(value, 'state', 'status'), 'running');
  const session = optionalString(valueFrom(value, 'sessionId', 'ownerSessionId'), 'workflow.sessionId') ?? sessionId;
  return {
    id,
    sessionId: session,
    kind: kindFrom(valueFrom(value, 'kind', 'mode', 'runMode'), fallbackKind),
    state,
    startedAt: boundedNumber(valueFrom(value, 'startedAt', 'startTime'), 'workflow.startedAt'),
    lastActivityAt: boundedNumber(
      valueFrom(value, 'lastActivityAt') ?? valueFrom(activity, 'lastActivityAt', 'lastMeaningfulAt', 'at'),
      'workflow.lastActivityAt',
    ),
    currentTool: optionalString(
      valueFrom(value, 'currentTool') ?? valueFrom(tool, 'name') ?? valueFrom(activity, 'currentTool'),
      'workflow.currentTool',
      128,
    ),
    currentToolStartedAt: boundedNumber(
      valueFrom(value, 'currentToolStartedAt') ??
        valueFrom(tool, 'startedAt') ??
        valueFrom(activity, 'currentToolStartedAt'),
      'workflow.currentToolStartedAt',
    ),
    ...usage,
    rootId: optionalString(valueFrom(value, 'rootId', 'workflowId'), 'workflow.rootId'),
    children,
    processTerminal: processTerminalFrom(valueFrom(value, 'processTerminal', 'terminal', 'process')),
    controlTarget: { kind: 'run', runId: id },
  };
}

function isActiveState(value: unknown): boolean {
  const state = stateFrom(value, 'running');
  return state === 'queued' || state === 'running' || state === 'paused';
}

function foregroundEntries(data: Record<string, unknown>): unknown[] {
  const fleet = isRecord(data.fleet) ? data.fleet : {};
  const entries = Array.isArray(fleet.entries) ? fleet.entries : [];
  const current = fleet.current ?? data.foreground ?? data.currentForeground;
  const candidates = current === undefined ? entries : [...entries, current];
  return candidates.filter((entry) => {
    if (!isRecord(entry)) return false;
    const kind = valueFrom(entry, 'kind', 'mode', 'runMode', 'type');
    return (
      (kind === undefined || kind === 'foreground' || kind === 'current') &&
      isActiveState(valueFrom(entry, 'state', 'status'))
    );
  });
}

function normalizeForeground(entry: unknown, sessionId: string): WorkflowSnapshot | undefined {
  if (!isRecord(entry)) return undefined;
  const explicitRunId = optionalString(valueFrom(entry, 'runId', 'workflowId'), 'foreground.runId');
  const id = explicitRunId ?? 'foreground-current';
  const normalized = normalizeWorkflow(
    {
      ...entry,
      id,
      kind: 'foreground',
      sessionId,
      controlTarget: explicitRunId ? { kind: 'run', runId: explicitRunId } : { kind: 'foreground-current' },
    },
    sessionId,
    'foreground',
  );
  if (normalized === undefined) return undefined;
  return {
    ...normalized,
    kind: 'foreground',
    controlTarget: explicitRunId ? { kind: 'run', runId: explicitRunId } : { kind: 'foreground-current' },
  };
}

export function normalizeStatus(value: unknown, sessionId: string): GatewaySnapshot {
  const data = requireRecord(value, 'status data');
  const reportedSession = optionalString(
    valueFrom(data, 'sessionId') ?? (isRecord(data.session) ? data.session.sessionId : undefined),
    'session.sessionId',
  );
  if (reportedSession !== undefined && reportedSession !== sessionId) {
    throw new Error('pi-subagents session mismatch');
  }
  const asyncSnapshot = isRecord(data.asyncSnapshot) ? data.asyncSnapshot : {};
  if (asyncSnapshot.version !== undefined && asyncSnapshot.version !== PROTOCOL_VERSION) {
    throw new Error('unsupported pi-subagents status snapshot version');
  }
  const runs = Array.isArray(asyncSnapshot.runs) ? asyncSnapshot.runs : [];
  const workflows: WorkflowSnapshot[] = [];
  let unconfirmed = 0;
  for (const run of runs) {
    const workflow = normalizeWorkflow(run, sessionId, 'background');
    if (workflow === undefined) {
      unconfirmed += 1;
      continue;
    }
    if (workflow.sessionId !== sessionId) continue;
    workflows.push(workflow);
  }
  const foreground = foregroundEntries(data);
  if (foreground.length === 1) {
    const workflow = normalizeForeground(foreground[0], sessionId);
    if (workflow !== undefined) workflows.push(workflow);
    else unconfirmed += 1;
  } else if (foreground.length > 1) {
    unconfirmed += 1;
  }
  const omitted =
    isRecord(data.fleet) && typeof data.fleet.omitted === 'number' && data.fleet.omitted >= 0
      ? Math.floor(data.fleet.omitted)
      : 0;
  return { sessionId, workflows, unconfirmed: unconfirmed + omitted };
}

export async function connectGateway(options: GatewayOptions): Promise<GatewayConnection> {
  const nextRequestId = options.requestId ?? randomUUID;
  let readySeen = false;
  const readyDisposer = options.events.on(READY_EVENT, () => {
    readySeen = true;
  });
  try {
    let ready: unknown;
    try {
      ready = await request(options.events, 'ping', {}, options.readyTimeoutMs, nextRequestId);
    } catch (error) {
      if (!isTimeout(error)) throw error;
      if (!readySeen) await waitForReady(options.events, options.readyTimeoutMs);
      ready = await request(options.events, 'ping', {}, options.readyTimeoutMs, nextRequestId);
    }
    const readyData = requireRecord(ready, 'ping data');
    const advertisedVersion = readyData.protocolVersion ?? readyData.version;
    if (advertisedVersion !== undefined && advertisedVersion !== PROTOCOL_VERSION) {
      throw new Error('unsupported pi-subagents RPC version');
    }
    const session =
      readyData.session === undefined
        ? { sessionId: readyData.sessionId }
        : requireRecord(readyData.session, 'session');
    const remoteSession = boundedString(session.sessionId, 'session.sessionId');
    if (remoteSession !== options.sessionId) throw new Error('pi-subagents session mismatch');
    const capabilities = capabilitiesFrom(readyData.capabilities);
    if (!capabilities.has('status')) throw new Error('pi-subagents lacks required status capability');
    const eventNames = isRecord(readyData.events) ? readyData.events : {};
    const wakeHandlers = new Set<() => void>();
    const eventDisposers: Array<() => void> = [];
    let disposed = false;
    let subscribed = false;
    const subscribeWakeEvents = (): void => {
      if (subscribed) return;
      subscribed = true;
      for (const name of ['asyncComplete', 'childStatus', 'processTerminal'] as const) {
        const value = eventNames[name];
        if (
          typeof value !== 'string' ||
          value.length === 0 ||
          value.length > MAX_EVENT_NAME_LENGTH ||
          /[\r\n]/.test(value)
        )
          continue;
        eventDisposers.push(
          options.events.on(value, () => {
            if (disposed) return;
            for (const handler of [...wakeHandlers]) handler();
          }),
        );
      }
    };
    const connection: GatewayConnection = {
      sessionId: options.sessionId,
      capabilities,
      async status(): Promise<GatewaySnapshot> {
        if (disposed) throw new Error('pi-subagents gateway disposed');
        const value = await request(options.events, 'status', {}, options.requestTimeoutMs, nextRequestId);
        return normalizeStatus(value, options.sessionId);
      },
      interrupt(target: ControlTarget): Promise<ControlReceipt> {
        if (disposed) return Promise.resolve({ state: 'unknown', message: 'pi-subagents gateway disposed' });
        if (!capabilities.has('interrupt'))
          return Promise.resolve({ state: 'rejected', message: 'pi-subagents does not advertise interrupt' });
        return control(options.events, 'interrupt', target, options.requestTimeoutMs, nextRequestId);
      },
      stop(target: ControlTarget): Promise<ControlReceipt> {
        if (disposed) return Promise.resolve({ state: 'unknown', message: 'pi-subagents gateway disposed' });
        if (!capabilities.has('stop'))
          return Promise.resolve({ state: 'rejected', message: 'pi-subagents does not advertise stop' });
        return control(options.events, 'stop', target, options.requestTimeoutMs, nextRequestId);
      },
      onWake(handler: () => void): () => void {
        if (disposed) return () => undefined;
        subscribeWakeEvents();
        wakeHandlers.add(handler);
        return () => {
          wakeHandlers.delete(handler);
        };
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        wakeHandlers.clear();
        for (const dispose of eventDisposers.splice(0)) dispose();
      },
    };
    return connection;
  } finally {
    readyDisposer();
  }
}

function waitForReady(events: EventBus, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const unsubscribe = events.on(READY_EVENT, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new GatewayRequestError('pi-subagents gateway did not become ready', true));
      },
      Math.max(1, timeoutMs),
    );
  });
}
