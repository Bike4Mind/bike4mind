import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { ICliFeatureModule, FeatureCommand } from '../ICliFeatureModule.js';
import type { ApiClient } from '../../auth/ApiClient.js';
import type { WebSocketConnectionManager } from '../../ws/WebSocketConnectionManager.js';
import type { IHearthService } from './IHearthService.js';
import type { HearthEvent } from './types.js';
import { HearthService } from './HearthService.js';
import { HearthEventStream } from './HearthEventStream.js';
import { createHearthTools } from './hearthTools.js';

/** Icons for event kinds shown in /hearth command */
const KIND_ICONS: Record<string, string> = {
  message: '\u{1F4AC}',
  edit: '\u270F\uFE0F',
  reaction: '\u{1F44D}',
  artifact: '\u{1F4E6}',
  presence: '\u{1F7E2}',
  delegation: '\u{1F4E4}',
  'quest.update': '\u{1F4DC}',
  'gate.request': '\u23F8\uFE0F',
  'gate.resolve': '\u25B6\uFE0F',
  system: '\u2699\uFE0F',
};

/** Max live events retained for the /hearth command display */
const MAX_RECENT_EVENTS = 200;

/**
 * ICliFeatureModule implementation for Hearth, the append-only event log
 * shared by humans, agents, devices, and gateways.
 *
 * Composes the service, tool adapters, WS event stream, and the /hearth
 * slash command into a single module the FeatureModuleRegistry can manage.
 */
export class HearthModule implements ICliFeatureModule {
  readonly name = 'hearth';
  readonly description = 'Post to and catch up on the Hearth shared event log';

  private readonly service: IHearthService;
  private readonly eventStream: HearthEventStream;
  /** Ring buffer of live events received over WS while this session runs */
  private readonly recentEvents: HearthEvent[] = [];

  constructor(apiClient: ApiClient) {
    this.service = new HearthService(apiClient);
    this.eventStream = new HearthEventStream(event => {
      this.recentEvents.push(event);
      if (this.recentEvents.length > MAX_RECENT_EVENTS) {
        this.recentEvents.shift();
      }
    });
  }

  getTools(): ICompletionOptionTools[] {
    return createHearthTools(this.service);
  }

  getSystemPromptSection(): string {
    return `## Hearth Integration
You can read and write the Hearth shared event log using hearth_* tools. Hearth is an append-only log where humans, agents, devices, and gateways all participate as actors; channels order events by a monotonic sequence number and every actor has a per-channel cursor.

IMPORTANT: Tools require channel IDs. Always use hearth_channels FIRST to discover channels and their IDs.

Available actions:
- **hearth_channels**: List channels with their IDs and names - USE THIS FIRST
- **hearth_post**: Append an event (message by default) to a channel; can attach a typed machine payload and thread refs
- **hearth_catchup**: Fetch everything after your cursor in a channel, gap-free, and advance the cursor - use this to rebuild context after being away
- **hearth_watch**: Peek at events after your cursor WITHOUT advancing it
- **hearth_delegate**: Post a delegation event asking another actor (agent, device, gateway) to execute a task

When the user asks to post an update, check what happened in a channel, catch up on activity, or hand a task to another actor, use these tools.
Events have a human-readable body plus an optional typed machine payload - prefer attaching a machine payload when the event carries structured results other agents may consume.`;
  }

  getCommands(): FeatureCommand[] {
    return [
      {
        name: 'hearth',
        description: 'Show recent live Hearth events received this session',
        execute: () => {
          if (this.recentEvents.length === 0) {
            console.log('\nHearth: No live events received yet this session.');
            console.log('  Events stream in over WebSocket as actors post to channels.');
            console.log('  Ask the AI to run hearth_catchup to fetch channel history.\n');
            return;
          }

          const recent = this.recentEvents.slice(-20);
          console.log(`\nHearth Events (last ${recent.length} of ${this.recentEvents.length} this session):\n`);
          for (const event of recent) {
            const time = new Date(event.createdAt).toLocaleTimeString();
            const icon = KIND_ICONS[event.kind] ?? '\u00B7';
            const actor = event.actorName ?? event.actorId;
            const text = event.human.text.slice(0, 120) + (event.human.text.length > 120 ? '...' : '');
            console.log(`  ${time}  ${icon} [${event.channelId}#${event.seq}] ${actor}: ${text}`);
          }
          console.log('');
        },
      },
    ];
  }

  registerWsHandlers(wsManager: WebSocketConnectionManager): void {
    this.eventStream.registerHandlers(wsManager);
  }

  dispose(): void {
    this.eventStream.dispose();
  }
}
