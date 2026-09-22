import { describe, it, expect, vi } from 'vitest';
import type { GatedToolCall } from '@bike4mind/agents';
import {
  classifyToolPermission,
  selectGatedToolCall,
  shouldWithholdToolCall,
  partitionApprovedPause,
  resumeApprovedPause,
  type GatedAction,
} from './toolPermissions';

let nextId = 0;
const call = (name: string, input: unknown = {}): GatedToolCall => ({ id: `toolu_${nextId++}`, name, input });

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

  it('returns allowed for every read-only tool, not just the ones someone remembered to list', () => {
    // Regression: these all declare `none` side effects and used to be gated purely because
    // they were missing from a hand-kept Set - which is what made agent mode stop and ask
    // "may I check what time it is?" once per turn.
    for (const tool of [
      'current_datetime',
      'sunrise_sunset',
      'planet_visibility',
      'wikipedia_on_this_day',
      'moon_phase',
      'iss_tracker',
      'mission_status',
      'math_evaluate',
      'wolfram_alpha',
      'search_knowledge_base',
      'retrieve_knowledge_content',
      'count_knowledge_base',
      'fmp_financial_data',
    ]) {
      expect(classifyToolPermission(tool, [], []), tool).toBe('allowed');
    }
  });

  it('gates a read-only tool the user explicitly denied', () => {
    expect(classifyToolPermission('current_datetime', [], ['current_datetime'])).toBe('denied');
  });

  it('gates an MCP tool even though it could ship its own declaration', () => {
    // Rule 3 runs before the declaration lookup: an MCP tool is third-party, so a
    // side-effect claim travelling with it is not evidence of anything.
    expect(classifyToolPermission('mcp__clock__now', [], [])).toBe('needs_approval');
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

describe('shouldWithholdToolCall', () => {
  it('lets an always-safe tool run', () => {
    expect(shouldWithholdToolCall('web_search', [], [])).toBe(false);
  });

  it('lets a session-approved tool run', () => {
    expect(shouldWithholdToolCall('send_slack_message', ['send_slack_message'], [])).toBe(false);
  });

  it('withholds a side-effect tool so its provider is never called', () => {
    expect(shouldWithholdToolCall('image_generation', [], [])).toBe(true);
  });

  it('withholds a denied tool rather than running it and failing afterwards', () => {
    expect(shouldWithholdToolCall('web_search', [], ['web_search'])).toBe(true);
  });
});

describe('selectGatedToolCall', () => {
  it('returns null when nothing was withheld', () => {
    expect(selectGatedToolCall([], [], [])).toBeNull();
  });

  it('carries the tool_use id so the executor can replay the call after approval', () => {
    const gated = call('send_slack_message', { channel: '#general', text: 'hi' });
    expect(selectGatedToolCall([gated], [], [])).toEqual({
      toolName: 'send_slack_message',
      toolInput: { channel: '#general', text: 'hi' },
      verdict: 'needs_approval',
      toolCallId: gated.id,
    });
  });

  it('returns null when the withheld call is on a since-approved tool', () => {
    expect(selectGatedToolCall([call('send_slack_message')], ['send_slack_message'], [])).toBeNull();
  });

  it('returns denied for a denied tool even when other calls only need approval', () => {
    const denied = call('image_generation', { prompt: 'cat' });
    expect(selectGatedToolCall([call('send_slack_message', { text: 'hi' }), denied], [], ['image_generation'])).toEqual(
      {
        toolName: 'image_generation',
        toolInput: { prompt: 'cat' },
        verdict: 'denied',
        toolCallId: denied.id,
      }
    );
  });

  it('returns denied as soon as it sees a denied call, regardless of order', () => {
    const calls = [call('image_generation', { prompt: 'cat' }), call('send_slack_message', { text: 'hi' })];
    expect(selectGatedToolCall(calls, [], ['image_generation'])?.verdict).toBe('denied');
  });

  it('returns the FIRST needs_approval call when one iteration withheld several', () => {
    // Single-toolName pendingPermission requires a deterministic pick - first wins.
    const calls = [call('send_slack_message', { text: 'first' }), call('image_generation', { prompt: 'second' })];
    expect(selectGatedToolCall(calls, [], [])).toMatchObject({
      toolName: 'send_slack_message',
      toolInput: { text: 'first' },
      verdict: 'needs_approval',
    });
  });

  it('treats MCP tools as needing approval', () => {
    expect(selectGatedToolCall([call('mcp__github__get_issue', { number: 1 })], [], [])).toMatchObject({
      toolName: 'mcp__github__get_issue',
      toolInput: { number: 1 },
      verdict: 'needs_approval',
    });
  });

  it('treats unknown tools as needing approval (safe default)', () => {
    expect(selectGatedToolCall([call('mystery_tool')], [], [])?.verdict).toBe('needs_approval');
  });
});

describe('partitionApprovedPause', () => {
  it('approves only the call the card named, leaving a same-tool sibling withheld', () => {
    // Two calls to the same tool with different arguments - the card only ever showed
    // one of them, so approving it must not silently approve the other.
    const first = call('image_generation', { prompt: 'cat' });
    const second = call('image_generation', { prompt: 'dog' });
    const { nowApproved, stillWithheld } = partitionApprovedPause([first, second], first.id, [], []);
    expect(nowApproved).toEqual([first]);
    expect(stillWithheld).toEqual([second]);
  });

  it('approves every withheld call once a "remember for session" approval widens approvedTools', () => {
    const first = call('send_slack_message', { text: 'a' });
    const second = call('send_slack_message', { text: 'b' });
    // approvedToolCallId names only `first`, but `approvedTools` now covers the tool
    // outright - `second` rides along without needing its own card.
    const { nowApproved, stillWithheld } = partitionApprovedPause(
      [first, second],
      first.id,
      ['send_slack_message'],
      []
    );
    expect(nowApproved).toEqual([first, second]);
    expect(stillWithheld).toEqual([]);
  });

  it('leaves every call withheld when the approved id matches none of them', () => {
    const first = call('image_generation', { prompt: 'cat' });
    const { nowApproved, stillWithheld } = partitionApprovedPause([first], 'toolu_unrelated', [], []);
    expect(nowApproved).toEqual([]);
    expect(stillWithheld).toEqual([first]);
  });

  it('approves only the named call, leaving a second, unrelated gated tool to raise its own card next', () => {
    const approved = call('send_slack_message', { text: 'hi' });
    const stillGated = call('image_generation', { prompt: 'cat' });
    const { nowApproved, stillWithheld } = partitionApprovedPause([approved, stillGated], approved.id, [], []);
    expect(nowApproved).toEqual([approved]);
    expect(stillWithheld).toEqual([stillGated]);
  });
});

describe('resumeApprovedPause', () => {
  function makeDeps(overrides: Partial<Parameters<typeof resumeApprovedPause>[1]> = {}) {
    const deps: Parameters<typeof resumeApprovedPause>[1] = {
      executeGatedToolCall: vi.fn(async () => 'ok'),
      toCheckpoint: vi.fn(() => ({ iteration: 1 })),
      updatePermissionState: vi.fn(async () => {}),
      updateCheckpoint: vi.fn(async () => {}),
      billIterationIfNeeded: vi.fn(async () => {}),
      settleGatedCall: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
      sendWs: vi.fn(async () => {}),
      persistRunAsQuest: vi.fn(async () => {}),
      logger: { error: vi.fn() },
      ...overrides,
    };
    return deps;
  }

  it('replays the approved call, clears the pause, bills once, and reports replayed', async () => {
    const approved = call('image_generation', { prompt: 'cat' });
    const deps = makeDeps();

    const outcome = await resumeApprovedPause(
      {
        executionId: 'exec_1',
        iterationIndex: 2,
        withheld: [approved],
        approvedToolCallId: approved.id,
        approvedTools: [],
        deniedTools: [],
      },
      deps
    );

    expect(outcome).toEqual({ status: 'replayed' });
    expect(deps.executeGatedToolCall).toHaveBeenCalledTimes(1);
    expect(deps.executeGatedToolCall).toHaveBeenCalledWith({
      id: approved.id,
      name: approved.name,
      input: approved.input,
    });
    expect(deps.updatePermissionState).toHaveBeenCalledTimes(1);
    expect(deps.updateCheckpoint).toHaveBeenCalledTimes(1);
    expect(deps.billIterationIfNeeded).toHaveBeenCalledTimes(1);
    expect(deps.settleGatedCall).not.toHaveBeenCalled();
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it('fails the run on a mid-batch replay throw without clearing the pause', async () => {
    const approved = call('send_slack_message', { text: 'hi' });
    const deps = makeDeps({
      executeGatedToolCall: vi.fn(async () => {
        throw new Error('provider exploded');
      }),
    });

    const outcome = await resumeApprovedPause(
      {
        executionId: 'exec_2',
        iterationIndex: 0,
        withheld: [approved],
        approvedToolCallId: approved.id,
        approvedTools: [],
        deniedTools: [],
      },
      deps
    );

    expect(outcome).toEqual({ status: 'replay_error' });
    expect(deps.markFailed).toHaveBeenCalledWith(
      'exec_2',
      expect.objectContaining({ message: expect.stringContaining('provider exploded') })
    );
    // The pause must stay in place for a retry to see the same withheld call - a
    // mid-batch throw must not silently clear `pendingPermission`.
    expect(deps.updatePermissionState).not.toHaveBeenCalled();
    expect(deps.updateCheckpoint).not.toHaveBeenCalled();
  });

  it('re-pauses for a second gated call to the same tool with different arguments', async () => {
    const approvedCall = call('image_generation', { prompt: 'cat' });
    const secondCall = call('image_generation', { prompt: 'dog' });
    const deps = makeDeps();

    const outcome = await resumeApprovedPause(
      {
        executionId: 'exec_3',
        iterationIndex: 1,
        withheld: [approvedCall, secondCall],
        approvedToolCallId: approvedCall.id,
        approvedTools: [],
        deniedTools: [],
      },
      deps
    );

    expect(outcome).toEqual({ status: 'repaused' });
    expect(deps.executeGatedToolCall).toHaveBeenCalledTimes(1);
    expect(deps.executeGatedToolCall).toHaveBeenCalledWith(expect.objectContaining({ id: approvedCall.id }));
    // Cleared and re-billed even though a second card follows: the approved call already
    // ran and its provider spend must settle against this iteration regardless.
    expect(deps.updatePermissionState).toHaveBeenCalledTimes(1);
    expect(deps.billIterationIfNeeded).toHaveBeenCalledTimes(1);
    expect(deps.settleGatedCall).toHaveBeenCalledTimes(1);
    const [gatedArg, withheldArg] = (deps.settleGatedCall as ReturnType<typeof vi.fn>).mock.calls[0] as [
      GatedAction,
      GatedToolCall[],
    ];
    expect(gatedArg.toolCallId).toBe(secondCall.id);
    expect(withheldArg).toEqual([secondCall]);
  });
});
