import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { registerMonitorCommands } from './commands';
import { createMonitorRuntime } from './runtime';
import { LAUNCH_SCHEMA } from './wrapper';

const TOOL_SCHEMA = Type.Object({
  operation: StringEnum(['run', 'status'] as const),
  request: Type.Optional(LAUNCH_SCHEMA),
});

export default function piSubagentMonitor(pi: ExtensionAPI): void {
  const runtime = createMonitorRuntime(pi);

  pi.registerTool({
    name: 'subagent_monitor',
    label: 'Monitored Subagent',
    description: 'Launch a bounded pi-subagents run with an optional stricter monitor policy.',
    promptSnippet: 'Launch or inspect a subagent workflow under explicit safety limits',
    parameters: TOOL_SCHEMA,
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
