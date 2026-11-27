import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { ICliFeatureModule, FeatureCommand } from '../ICliFeatureModule.js';
import type { ApiClient } from '../../auth/ApiClient.js';
import type { WebSocketConnectionManager } from '../../ws/WebSocketConnectionManager.js';
import type { ITavernService } from './ITavernService.js';
import type { HeartbeatLogEntry } from './types.js';
import { TavernService } from './TavernService.js';
import { TavernActivityStream } from './TavernActivityStream.js';
import { createTavernTools } from './tavernTools.js';

/** Icons for heartbeat log actions shown in /tavern command */
const ACTION_ICONS: Record<string, string> = {
  speech: '\u{1F4AC}',
  thought: '\u{1F4AD}',
  memory: '\u{1F9E0}',
  move: '\u{1F6B6}',
  reply: '\u{1F4E9}',
  post_quest: '\u{1F4DC}',
  claim_quest: '\u{2694}\uFE0F',
  complete_quest: '\u{2705}',
  tool_use: '\u{1F527}',
  email: '\u{1F4E7}',
  gate_paused: '\u{23F8}\uFE0F',
  gate_timed: '\u{23F3}',
  gate_proceed: '\u{25B6}\uFE0F',
  idle: '\u{1F4A4}',
  intent: '\u{1F3AF}',
  report: '\u{1F4CB}',
  credits: '\u{1FA99}',
  move_decoration: '\u{1F3A8}',
  yolo_override: '\u{26A1}',
};

/**
 * ICliFeatureModule implementation for the Tavern.
 *
 * Composes the service, tool adapters, WS activity stream, and slash
 * commands into a single module that the FeatureModuleRegistry can manage.
 */
export class TavernModule implements ICliFeatureModule {
  readonly name = 'tavern';
  readonly description = 'Interact with autonomous AI agents in the B4M Tavern';

  private readonly service: ITavernService;
  private readonly activityStream: TavernActivityStream;
  private readonly getActivityLog: () => HeartbeatLogEntry[];

  constructor(
    apiClient: ApiClient,
    onLogEntry: (entry: HeartbeatLogEntry) => void,
    getActivityLog: () => HeartbeatLogEntry[]
  ) {
    this.service = new TavernService(apiClient);
    this.activityStream = new TavernActivityStream(onLogEntry);
    this.getActivityLog = getActivityLog;
  }

  getTools(): ICompletionOptionTools[] {
    return createTavernTools(this.service);
  }

  getSystemPromptSection(): string {
    return `## Tavern Integration
You can interact with autonomous AI agents in the B4M Tavern using tavern_* tools.

IMPORTANT: Many tools require agent IDs (MongoDB ObjectIds like "6540b58d1f703ade3ea1e82b"). Always use tavern_list_agents FIRST to discover agent names and their IDs before using tools that need an agent_id.

Available actions:
- **tavern_list_agents**: List all agents with their IDs, names, and status — USE THIS FIRST
- **tavern_create_agent**: Create a new agent with a personality (heartbeats disabled by default)
- **tavern_edit_agent**: Update an agent's personality, system prompt, or heartbeat config (per-agent toggle)
- **tavern_delete_agent**: Permanently delete an agent
- **tavern_mention**: Talk to a specific agent by name or broadcast to all agents
- **tavern_list_quests**: View the quest board
- **tavern_post_quest**: Post a new quest for agents to claim
- **tavern_delete_quest**: Remove a quest from the board
- **tavern_read_notebook**: Read an agent's activity history (requires agent ID from tavern_list_agents)
- **tavern_list_gates**: See pending confidence gates awaiting human approval
- **tavern_resolve_gate**: Approve or reject a confidence gate
- **tavern_toggle_heartbeats**: Enable/disable agent background heartbeats
- **tavern_trigger_heartbeat**: Manually trigger a heartbeat cycle
- **tavern_abort_heartbeats**: Emergency stop all in-flight heartbeats
- **tavern_status**: Quick overview of agents, quests, and gates — good for situational awareness

When the user mentions talking to agents, checking the quest board, or managing the tavern, use these tools.
Agents have personalities, moods, quests, and memories - they are autonomous entities, not chatbots.`;
  }

  getCommands(): FeatureCommand[] {
    return [
      {
        name: 'tavern',
        description: 'Show recent Tavern agent activity stream',
        execute: () => {
          const activityLog = this.getActivityLog();

          if (activityLog.length === 0) {
            console.log('\nTavern Activity: No activity yet.');
            console.log('  Agents broadcast activity during heartbeats.');
            console.log('  Try: "trigger a heartbeat cycle" to generate activity.\n');
            return;
          }

          const recentEntries = activityLog.slice(-20);
          console.log(`\nTavern Activity (last ${recentEntries.length} of ${activityLog.length} entries):\n`);
          for (const entry of recentEntries) {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            const icon = ACTION_ICONS[entry.action] ?? '\u00B7';
            const target = entry.targetAgentName ? ` \u2192 ${entry.targetAgentName}` : '';
            const text = entry.text ? `: ${entry.text.slice(0, 120)}${entry.text.length > 120 ? '...' : ''}` : '';
            console.log(`  ${time}  ${icon} ${entry.agentName}${target} [${entry.action}]${text}`);
          }
          console.log('');
        },
      },
    ];
  }

  registerWsHandlers(wsManager: WebSocketConnectionManager): void {
    this.activityStream.registerHandlers(wsManager);
  }

  dispose(): void {
    this.activityStream.dispose();
  }
}
