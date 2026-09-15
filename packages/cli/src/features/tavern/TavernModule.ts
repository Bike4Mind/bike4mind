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
- **tavern_get_quest_plan**: Fetch a quest master plan with review gate status and handoff state
- **tavern_update_review_gate**: Approve or reject a review gate on a sub-quest
- **tavern_update_quest_progress**: Update sub-quest status and record evidence of completion
- **tavern_write_handoff**: Write session handoff for continuity across sessions

When the user mentions talking to agents, checking the quest board, or managing the tavern, use these tools.
Agents have personalities, moods, quests, and memories — they are autonomous entities, not chatbots.

## Quest Workflow (Review Gates)
When working on a quest plan with review gates (reviewGate: true on sub-quests), you MUST:
1. Check review gate status with tavern_get_quest_plan before proceeding past a gated step
2. If the next sub-quest has reviewGate: true and reviewStatus is not 'approved', STOP and inform the user
3. Record evidence of completion with tavern_update_quest_progress when finishing a sub-quest
4. Write a handoff with tavern_write_handoff before ending a session with an active quest plan

## Session Handoff & Resume
When the user runs /quest resume <plan_id>, read the handoff context and continue from where the previous session left off. The handoff contains: summary of prior work, next steps, pending decisions, and blockers.`;
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
      {
        name: 'quest',
        description: 'Quest workflow commands: review gates, resume from handoff',
        execute: async (args: string[]) => {
          const subCommand = args[0];

          if (subCommand === 'resume') {
            const planId = args[1];
            if (!planId) {
              console.log('\nUsage: /quest resume <plan_id>');
              console.log('  Loads the quest plan and displays the session handoff for continuity.\n');
              return;
            }

            try {
              const plan = await this.service.getQuestPlan(planId);

              console.log(`\nQuest Plan: ${plan.goal}`);
              console.log(`State: ${plan.state ?? 'unknown'}`);

              if (plan.metrics) {
                const pct = Math.round(plan.metrics.completionRate * 100);
                console.log(
                  `Progress: ${plan.metrics.subQuestsCompleted}/${plan.metrics.subQuestsTotal} sub-quests (${pct}%)`
                );
              }

              if (!plan.handoff) {
                console.log('\n  No handoff found — this plan has no saved session context.');
                console.log('  The AI can still read the plan via tavern_get_quest_plan.\n');
                return;
              }

              const { handoff } = plan;
              console.log(`\nSession Handoff (${new Date(handoff.updatedAt).toLocaleString()}):`);
              console.log(`\n  Summary: ${handoff.summary}`);

              if (handoff.nextSteps.length > 0) {
                console.log('\n  Next Steps:');
                for (const step of handoff.nextSteps) {
                  console.log(`    \u2022 ${step}`);
                }
              }

              if (handoff.pendingDecisions.length > 0) {
                console.log('\n  Pending Decisions:');
                for (const decision of handoff.pendingDecisions) {
                  console.log(`    \u2753 ${decision}`);
                }
              }

              if (handoff.blockers.length > 0) {
                console.log('\n  Blockers:');
                for (const blocker of handoff.blockers) {
                  console.log(`    \u{1F6D1} ${blocker}`);
                }
              }

              console.log('');
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.log(`\nError fetching quest plan: ${message}\n`);
            }
            return;
          }

          if (subCommand === 'review') {
            const planId = args[1];
            if (!planId) {
              console.log('\nUsage: /quest review <plan_id>');
              console.log('  Fetches the quest plan and shows sub-quests with pending review gates.\n');
              return;
            }

            try {
              const plan = await this.service.getQuestPlan(planId);

              const pendingGates: Array<{
                questTitle: string;
                questId: string;
                subQuestTitle: string;
                subQuestId: string;
                status: string;
              }> = [];

              for (const quest of plan.quests) {
                for (const sq of quest.subQuests) {
                  if (sq.reviewGate) {
                    pendingGates.push({
                      questTitle: quest.title,
                      questId: quest.id,
                      subQuestTitle: sq.title,
                      subQuestId: sq.id,
                      status: sq.reviewStatus ?? 'pending',
                    });
                  }
                }
              }

              if (pendingGates.length === 0) {
                console.log(`\nQuest Plan: ${plan.goal}`);
                console.log('  No review gates configured in this plan.\n');
                return;
              }

              console.log(`\nQuest Plan: ${plan.goal}`);
              console.log(`State: ${plan.state ?? 'unknown'}\n`);
              console.log('Review Gates:');
              for (const gate of pendingGates) {
                const icon =
                  gate.status === 'approved' ? '\u2705' : gate.status === 'rejected' ? '\u274C' : '\u23F8\uFE0F';
                console.log(`  ${icon} [${gate.status}] ${gate.questTitle} > ${gate.subQuestTitle}`);
                console.log(`     quest_id: ${gate.questId}  sub_quest_id: ${gate.subQuestId}`);
              }
              console.log(
                '\n  To approve: ask the AI to approve a review gate, or use tavern_update_review_gate tool.\n'
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.log(`\nError fetching quest plan: ${message}\n`);
            }
            return;
          }

          // Default: show usage
          console.log('\nUsage:');
          console.log('  /quest review <plan_id>  \u2014 Show review gates and their status');
          console.log('  /quest resume <plan_id>  \u2014 Load handoff and resume from where you left off');
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
