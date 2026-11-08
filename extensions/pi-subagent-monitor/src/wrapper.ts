import { randomUUID } from 'node:crypto';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { resolveLimits } from './config';
import type { EventBus, LaunchRequest, LaunchReceipt, LaunchStep, Limits } from './types';

const RPC_REQUEST_EVENT = 'subagents:rpc:v1:request';
const RPC_REPLY_PREFIX = 'subagents:rpc:v1:reply:';
const STRUCTURED_REQUEST_EVENT = 'prompt-template:subagent:request';
const STRUCTURED_EVENTS = [
  'prompt-template:subagent:started',
  'prompt-template:subagent:update',
  'prompt-template:subagent:response',
] as const;
const PROTOCOL_VERSION = 1;
const MAX_ARGUMENTS = 16000;
const MAX_AGENT = 128;
const MAX_KEY = 128;
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

export const LIMITS_SCHEMA = Type.Object({
  wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })),
  inactivityMs: Type.Optional(Type.Integer({ minimum: 0 })),
  tokenCount: Type.Optional(Type.Integer({ minimum: 0 })),
  costUsd: Type.Optional(Type.Number({ minimum: 0 })),
  toolCalls: Type.Optional(Type.Integer({ minimum: 0 })),
  turns: Type.Optional(Type.Integer({ minimum: 0 })),
  activeToolMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const LAUNCH_SCHEMA = Type.Object({
  kind: StringEnum(['single', 'parallel-review', 'review-loop', 'implement-review', 'chain-parallel'] as const),
  task: Type.String({ minLength: 1, maxLength: MAX_ARGUMENTS }),
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_AGENT })),
  steps: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.String({ minLength: 1, maxLength: MAX_KEY }),
        agent: Type.String({ minLength: 1, maxLength: MAX_AGENT }),
        task: Type.String({ minLength: 1, maxLength: MAX_ARGUMENTS }),
      }),
      { maxItems: 16 },
    ),
  ),
  async: Type.Optional(Type.Boolean()),
  limits: Type.Optional(LIMITS_SCHEMA),
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
  requestTimeoutMs?: number;
  ownerRunId?: string;
}

interface RpcReply {
  version: number;
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: { message?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\r\n]/.test(value)) {
    throw new Error(`${field} must be a bounded string`);
  }
  return value;
}

function boundedTask(value: unknown, field = 'task'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ARGUMENTS) {
    throw new Error(`${field} must contain 1-${MAX_ARGUMENTS} characters`);
  }
  return value;
}

function parseLimits(value: unknown): Partial<Limits> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('limits must be an object');
  const result: Partial<Limits> = {};
  for (const key of Object.keys(value)) {
    if (!(LIMIT_NAMES as readonly string[]).includes(key)) throw new Error(`unknown limit ${key}`);
    const candidate = value[key];
    if (key === 'costUsd') {
      if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
        throw new Error(`${key} must be a valid non-negative value`);
      }
    } else if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new Error(`${key} must be a valid non-negative value`);
    }
    result[key as LimitName] = candidate as never;
  }
  return result;
}

function validateStep(value: unknown, index: number): LaunchStep {
  if (!isRecord(value)) throw new Error(`steps[${index}] must be an object`);
  const keys = Object.keys(value);
  if (keys.some((key) => !['key', 'agent', 'task'].includes(key)))
    throw new Error(`steps[${index}] has unknown fields`);
  return {
    key: boundedString(value.key, `steps[${index}].key`, MAX_KEY),
    agent: boundedString(value.agent, `steps[${index}].agent`, MAX_AGENT),
    task: boundedTask(value.task, `steps[${index}].task`),
  };
}

function validateLaunchRequest(value: LaunchRequest): LaunchRequest {
  if (!isRecord(value)) throw new Error('launch request must be an object');
  const allowed = ['kind', 'task', 'agent', 'steps', 'async', 'limits'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('launch request has unknown fields');
  const kinds = ['single', 'parallel-review', 'review-loop', 'implement-review', 'chain-parallel'];
  if (typeof value.kind !== 'string' || !kinds.includes(value.kind)) throw new Error('kind is unsupported');
  const task = boundedTask(value.task);
  if (value.agent !== undefined) boundedString(value.agent, 'agent', MAX_AGENT);
  if (value.async !== undefined && typeof value.async !== 'boolean') throw new Error('async must be boolean');
  const steps =
    value.steps === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 16) {
            throw new Error('workflow launch requires 1-16 steps');
          }
          const parsed = value.steps.map((step, index) => validateStep(step, index));
          if (new Set(parsed.map((step) => step.key)).size !== parsed.length)
            throw new Error('steps keys must be unique');
          return parsed;
        })();
  if (value.kind === 'single' && value.agent === undefined) throw new Error('single launch requires agent');
  if (value.kind !== 'single' && steps === undefined) throw new Error('workflow launch requires steps');
  if (value.async === false && value.kind !== 'single')
    throw new Error('foreground composite overrides are unsupported');
  const limits = parseLimits(value.limits);
  return {
    kind: value.kind as LaunchRequest['kind'],
    task,
    ...(value.agent === undefined ? {} : { agent: value.agent }),
    ...(steps === undefined ? {} : { steps }),
    ...(value.async === undefined ? {} : { async: value.async }),
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
  };
}

export function resolveLaunch(
  request: LaunchRequest,
  globalLimits: Limits,
): { request: LaunchRequest; effectiveLimits: Limits } {
  const validated = validateLaunchRequest(request);
  return {
    request: validated,
    effectiveLimits: resolveLimits(globalLimits, validated.limits ?? {}),
  };
}

export function parseLaunchArgs(args: string): unknown {
  if (typeof args !== 'string') throw new Error('run arguments must be valid JSON');
  const text = args.trim();
  if (text.length === 0 || text.length > MAX_ARGUMENTS) throw new Error('run arguments must be bounded');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('run arguments must be valid JSON');
  }
}

function replyError(reply: RpcReply): Error {
  const message =
    isRecord(reply.error) && typeof reply.error.message === 'string'
      ? reply.error.message.slice(0, 500)
      : 'pi-subagents launch request failed';
  return new Error(message);
}

function requestRpc(
  events: EventBus,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  requestId: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
    const unsubscribe = events.on(replyEvent, (payload) => {
      if (settled) return;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe();
      };
      try {
        if (
          !isRecord(payload) ||
          payload.version !== PROTOCOL_VERSION ||
          payload.requestId !== requestId ||
          typeof payload.success !== 'boolean'
        ) {
          throw new Error('invalid pi-subagents RPC launch reply');
        }
        settled = true;
        cleanup();
        if (payload.success !== true) reject(replyError(payload as unknown as RpcReply));
        else resolve(payload.data);
      } catch (error) {
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error('invalid pi-subagents RPC launch reply'));
      }
    });
    timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new Error('pi-subagents launch request timed out'));
      },
      Math.max(1, timeoutMs),
    );
    try {
      events.emit(RPC_REQUEST_EVENT, {
        version: PROTOCOL_VERSION,
        requestId,
        method,
        params,
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      reject(error instanceof Error ? error : new Error('failed to emit launch request'));
    }
  });
}

function launchReceipt(data: unknown, requestId: string, effectiveLimits: Limits, sessionId: string): LaunchReceipt {
  if (!isRecord(data)) throw new Error('pi-subagents launch reply must be an object');
  const reportedSession = data.sessionId ?? (isRecord(data.session) ? data.session.sessionId : undefined);
  if (reportedSession !== undefined && reportedSession !== sessionId) throw new Error('pi-subagents session mismatch');
  const runIdValue = data.runId ?? data.id;
  const runId = runIdValue === undefined ? undefined : boundedString(runIdValue, 'runId', 256);
  const state = data.state === 'completed' || data.state === 'complete' ? 'completed' : 'started';
  return {
    requestId,
    runId,
    state,
    effectiveLimits,
    message:
      typeof data.message === 'string'
        ? data.message.slice(0, 500)
        : state === 'completed'
          ? 'launch completed'
          : 'launch started',
  };
}

function eventRequestId(value: Record<string, unknown>): string | undefined {
  const requestId = value.requestId ?? value.nodeId ?? value.id;
  return typeof requestId === 'string' ? requestId : undefined;
}

function eventRunId(value: Record<string, unknown>): string | undefined {
  const runId = value.runId ?? value.childRunId ?? value.workflowId;
  return typeof runId === 'string' && runId.length > 0 && runId.length <= 256 && !/[\r\n]/.test(runId)
    ? runId
    : undefined;
}

function createForegroundLaunch(
  options: LaunchWrapperOptions,
  request: LaunchRequest,
  effectiveLimits: Limits,
): Promise<LaunchReceipt> {
  const requestId = randomUUID();
  const nodeId = requestId;
  const ownerRunId = options.ownerRunId ?? options.sessionId;
  return new Promise<LaunchReceipt>((resolve, reject) => {
    let settled = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disposers = STRUCTURED_EVENTS.map((eventName) =>
      options.events.on(eventName, (payload) => {
        if (closed || !isRecord(payload)) return;
        const eventRequest = eventRequestId(payload);
        const eventOwner = typeof payload.ownerRunId === 'string' ? payload.ownerRunId : undefined;
        if (eventRequest !== undefined && eventRequest !== requestId && eventRequest !== nodeId) return;
        if (eventOwner !== undefined && eventOwner !== ownerRunId) return;
        const runId = eventRunId(payload);
        if (runId !== undefined) options.associate(runId, effectiveLimits);
        if (eventName === 'prompt-template:subagent:started') {
          if (settled) return;
          settled = true;
          resolve({
            requestId,
            runId,
            state: 'started',
            effectiveLimits,
            message: 'foreground launch started',
          });
          if (runId !== undefined) {
            closed = true;
            if (timer !== undefined) clearTimeout(timer);
            for (const dispose of disposers) dispose();
          }
          return;
        }
        if (eventName === 'prompt-template:subagent:response') {
          if (!settled) {
            settled = true;
            resolve({
              requestId,
              runId,
              state: 'completed',
              effectiveLimits,
              message: 'foreground launch completed',
            });
          }
          closed = true;
          if (timer !== undefined) clearTimeout(timer);
          for (const dispose of disposers) dispose();
        }
      }),
    );
    timer = setTimeout(
      () => {
        if (closed) return;
        closed = true;
        for (const dispose of disposers) dispose();
        if (!settled) {
          settled = true;
          reject(new Error('foreground subagent launch did not report a started event'));
        }
      },
      Math.max(1, options.requestTimeoutMs ?? 2000),
    );
    try {
      options.events.emit(STRUCTURED_REQUEST_EVENT, {
        version: 1,
        requestId,
        ownerRunId,
        nodeId,
        agent: request.agent,
        task: request.task,
        context: {},
        cwd: options.cwd,
        result: { kind: 'text' },
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const dispose of disposers) dispose();
      reject(error instanceof Error ? error : new Error('failed to emit foreground launch request'));
    }
  });
}

export function createLaunchWrapper(options: LaunchWrapperOptions): LaunchWrapper {
  return {
    async launch(input: LaunchRequest): Promise<LaunchReceipt> {
      const { request, effectiveLimits } = resolveLaunch(input, options.globalLimits);
      const asyncLaunch = request.async !== false;
      if (!asyncLaunch) return createForegroundLaunch(options, request, effectiveLimits);
      const requestId = randomUUID();
      const params: Record<string, unknown> = {
        task: request.task,
        async: true,
      };
      if (request.agent !== undefined) params.agent = request.agent;
      if (request.kind !== 'single') {
        params.kind = request.kind;
        params.steps = request.steps;
      }
      const data = await requestRpc(options.events, 'spawn', params, options.requestTimeoutMs ?? 2000, requestId);
      const receipt = launchReceipt(data, requestId, effectiveLimits, options.sessionId);
      if (receipt.runId !== undefined) options.associate(receipt.runId, effectiveLimits);
      return receipt;
    },
  };
}
