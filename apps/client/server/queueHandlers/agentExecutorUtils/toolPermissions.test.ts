import { describe, it, expect } from 'vitest';
import type { AgentStep } from '@bike4mind/agents';
import { classifyToolPermission, selectGatedAction } from './toolPermissions';

const action = (toolName: string, toolInput: unknown = {}): AgentStep => ({
  type: 'action',
  content: '',
  metadata: { toolName, toolInput, timestamp: 0 },
});

const observation = (toolName: string, toolInput: unknown = {}): AgentStep => ({
  type: 'observation',
  content: 'result',
  metadata: { toolName, toolInput, timestamp: 0 },
});

const thought = (text: string): AgentStep => ({
  type: 'thought',
  content: text,
  metadata: { timestamp: 0 },
});

const finalAnswer = (text: string): AgentStep => ({
  type: 'final_answer',
  content: text,
  metadata: { timestamp: 0 },
});

describe('classifyToolPermission', () => {
  it('returns denied for explicitly denied tools (highest priority)', () => {
    expect(classifyToolPermission('web_search', [], ['web_search'])).toBe('denied');
    expect(classifyToolPermission('send_slack_message', ['send_slack_message'], ['send_slack_message'])).toBe('denied');
  });

  it('returns allowed for explicitly approved tools', () => {
    expect(classifyToolPermission('send_slack_message', ['send_slack_message'], [])).toBe('allowed');
  });

  it('returns allowed for always-safe read-only tools', () => {
    expect(classifyToolPermission('web_search', [], [])).toBe('allowed');
    expect(classifyToolPermission('deep_research', [], [])).toBe('allowed');
  });

  it('treats both inline visualization tools (recharts, mermaid_chart) as always-safe', () => {
    // Artifact-only tools must stay paired - otherwise agent mode runs one chart
    // tool silently while pausing the other for approval.
    expect(classifyToolPermission('recharts', [], [])).toBe('allowed');
    expect(classifyToolPermission('mermaid_chart', [], [])).toBe('allowed');
  });

  it('treats all five OptiHashi tools as always-safe', () => {
    // Same risk surface (LLM/solver call + /opti-gated, undoable __uiSideEffect; no stored-data
    // mutation or external call) - must stay grouped so agent mode doesn't auto-run one while
    // pausing its twin, and so the autonomous decompose -> formulate -> solve/schedule loop isn't
    // interrupted by an approval prompt at every step.
    expect(classifyToolPermission('optihashi_decompose', [], [])).toBe('allowed');
    expect(classifyToolPermission('optihashi_formulate', [], [])).toBe('allowed');
    expect(classifyToolPermission('optihashi_edit_problem', [], [])).toBe('allowed');
    expect(classifyToolPermission('optihashi_schedule', [], [])).toBe('allowed');
    expect(classifyToolPermission('optihashi_solve', [], [])).toBe('allowed');
  });

  it('returns needs_approval for MCP tools', () => {
    expect(classifyToolPermission('mcp__github__get_issue', [], [])).toBe('needs_approval');
  });

  it('returns needs_approval for known side-effect tools', () => {
    expect(classifyToolPermission('send_slack_message', [], [])).toBe('needs_approval');
    expect(classifyToolPermission('image_generation', [], [])).toBe('needs_approval');
    expect(classifyToolPermission('delegate_to_agent', [], [])).toBe('needs_approval');
  });

  it('returns needs_approval for unknown tools (safe default)', () => {
    expect(classifyToolPermission('totally_unknown_tool', [], [])).toBe('needs_approval');
  });
});

describe('selectGatedAction', () => {
  it('returns null when there are no action steps', () => {
    const steps = [thought('thinking'), finalAnswer('done')];
    expect(selectGatedAction(steps, [], [])).toBeNull();
  });

  it('ignores observation steps even when they carry a toolName', () => {
    // Regression for the original bug: the primary `step` returned by
    // ReActAgent.runIteration() for tool-calling iterations is the trailing
    // `observation`, whose metadata.toolName matches but whose type does not.
    const steps = [observation('send_slack_message')];
    expect(selectGatedAction(steps, [], [])).toBeNull();
  });

  it('finds the action step in a typical [thought, action, observation] iteration', () => {
    const steps = [
      thought('I should send a message'),
      action('send_slack_message', { channel: '#general', text: 'hi' }),
      observation('send_slack_message'),
    ];
    expect(selectGatedAction(steps, [], [])).toEqual({
      toolName: 'send_slack_message',
      toolInput: { channel: '#general', text: 'hi' },
      verdict: 'needs_approval',
    });
  });

  it('returns null when the only action is on an always-safe tool', () => {
    const steps = [action('web_search', { query: 'x' }), observation('web_search')];
    expect(selectGatedAction(steps, [], [])).toBeNull();
  });

  it('returns null when the action is on a session-approved tool', () => {
    const steps = [action('send_slack_message'), observation('send_slack_message')];
    expect(selectGatedAction(steps, ['send_slack_message'], [])).toBeNull();
  });

  it('returns denied for a denied tool even when other actions need approval', () => {
    const steps = [
      action('send_slack_message', { text: 'hi' }),
      observation('send_slack_message'),
      action('image_generation', { prompt: 'cat' }),
      observation('image_generation'),
    ];
    expect(selectGatedAction(steps, [], ['image_generation'])).toEqual({
      toolName: 'image_generation',
      toolInput: { prompt: 'cat' },
      verdict: 'denied',
    });
  });

  it('returns denied as soon as it sees a denied action, regardless of order', () => {
    const steps = [
      action('image_generation', { prompt: 'cat' }),
      observation('image_generation'),
      action('send_slack_message', { text: 'hi' }),
      observation('send_slack_message'),
    ];
    expect(selectGatedAction(steps, [], ['image_generation'])?.verdict).toBe('denied');
  });

  it('returns the FIRST needs_approval action when multiple tools were called in parallel', () => {
    // Parallel execution path appends [action, action, ..., observation, observation, ...].
    // Single-toolName pendingPermission requires a deterministic pick - first wins.
    const steps = [
      action('send_slack_message', { text: 'first' }),
      action('image_generation', { prompt: 'second' }),
      observation('send_slack_message'),
      observation('image_generation'),
    ];
    expect(selectGatedAction(steps, [], [])).toEqual({
      toolName: 'send_slack_message',
      toolInput: { text: 'first' },
      verdict: 'needs_approval',
    });
  });

  it('skips action steps that lack a toolName', () => {
    const malformed: AgentStep = { type: 'action', content: '', metadata: { timestamp: 0 } };
    expect(selectGatedAction([malformed], [], [])).toBeNull();
  });

  it('treats MCP tools as needing approval', () => {
    const steps = [action('mcp__github__get_issue', { number: 1 })];
    expect(selectGatedAction(steps, [], [])).toEqual({
      toolName: 'mcp__github__get_issue',
      toolInput: { number: 1 },
      verdict: 'needs_approval',
    });
  });

  it('treats unknown tools as needing approval (safe default)', () => {
    const steps = [action('mystery_tool')];
    expect(selectGatedAction(steps, [], [])?.verdict).toBe('needs_approval');
  });
});
