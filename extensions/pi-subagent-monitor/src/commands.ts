import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { MonitorMode } from './types';

export interface MonitorCommandRuntime {
  status(ctx: ExtensionCommandContext): Promise<void>;
  setMode(mode: MonitorMode, ctx: ExtensionCommandContext): Promise<void>;
  history(ctx: ExtensionCommandContext): Promise<void>;
  extend(args: string, ctx: ExtensionCommandContext): Promise<void>;
  run(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

const USAGE = 'Usage: /subagent-monitor status|observe|enforce|history|extend <JSON>|run <JSON>';

export function registerMonitorCommands(pi: ExtensionAPI, runtime: MonitorCommandRuntime): void {
  pi.registerCommand('subagent-monitor', {
    description: 'Inspect and control subagent monitoring',
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const firstSpace = trimmed.search(/\s/);
      const command = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
      const rest = firstSpace < 0 ? '' : trimmed.slice(firstSpace).trim();
      switch (command || 'status') {
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
          await runtime.extend(rest, ctx);
          return;
        case 'run':
          await runtime.run(rest, ctx);
          return;
        default:
          ctx.ui.notify(USAGE, 'warning');
      }
    },
  });
}
