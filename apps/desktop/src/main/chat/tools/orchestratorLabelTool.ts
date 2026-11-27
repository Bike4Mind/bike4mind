import { isOrchestratorLabel } from '@shared/chat';
import type { ToolDefinition } from './types';

export const ORCHESTRATOR_LABEL_TOOL_NAME = 'orchestrator_label';

// Bound only in a turn the user typed (ChatService): 'off' hides the Agents button.
export const orchestratorLabelTool: ToolDefinition = {
  schema: {
    name: ORCHESTRATOR_LABEL_TOOL_NAME,
    description: [
      "Show or hide the orchestrator icon on THIS conversation's sidebar row. Use it when the user, a",
      'skill or the prompt says to mark this session as an orchestrator (or to stop marking it), for',
      'example a skill that coordinates sub-sessions and wants the session to read as one from the start.',
      '',
      'Display only. It does NOT turn on Orchestrate mode, start or approve sub-sessions, or change any',
      'permission; sub-sessions still go through session_spawn and its approval as before.',
      '',
      "'on' shows the icon, 'off' hides it, and 'auto' goes back to the app's own rule (shown once this",
      "conversation is an orchestrator or has started an agent). 'off' is refused while this conversation",
      'has running agents; the user can hide the icon from the row menu.',
      '',
      'Works only in a turn the user typed: in an agent, loop, wake or other automatic turn it is refused.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          enum: ['on', 'off', 'auto'],
          description: "'on' to mark this conversation as an orchestrator, 'off' to hide the mark, 'auto' to clear it.",
        },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },

  async run(input, context) {
    const label = input.label;
    if (!isOrchestratorLabel(label)) throw new Error('The "label" argument must be "on", "off" or "auto".');
    const target = context.orchestratorLabel;
    if (!target) throw new Error('The orchestrator mark can only be changed in a turn the user typed.');
    context.beginWrite?.();
    const outcome = await target.set(label);
    if (!outcome.ok) {
      throw new Error(
        outcome.reason === 'live-agents'
          ? 'This conversation has running agents, so the orchestrator mark stays. The user can hide it from the row menu.'
          : 'This conversation no longer exists.'
      );
    }
    const said =
      label === 'on'
        ? 'Marked this conversation as an orchestrator in the sidebar'
        : label === 'off'
          ? 'Hid the orchestrator mark on this conversation'
          : "Handed this conversation's orchestrator mark back to the automatic rule";
    context.report?.label(said);
    return `${said}. Orchestrate mode and spawn approvals are unchanged.`;
  },
};
