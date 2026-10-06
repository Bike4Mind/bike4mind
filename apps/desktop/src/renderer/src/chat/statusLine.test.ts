import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatReplyRound, ChatToolCall, ChatToolStatus } from '@shared/chat';
import type { PendingCode } from './codeStream';
import {
  activityDetail,
  contextPercent,
  contextTokens,
  describeActivity,
  hasActivityDetail,
  describeSplit,
  describeUsage,
  formatCost,
  formatElapsed,
  formatTokens,
  inputSide,
  latestReply,
  occupancyArc,
  occupancyColor,
  statusFields,
  STALL_AFTER_MS,
  writingProse,
  totalTokens,
  usageLabel,
  withStall,
  type ComposerUsage,
} from './statusLine';

function call(name: string, status: ChatToolStatus, progress?: string): ChatToolCall {
  return { id: name, name, input: {}, status, ...(progress ? { progress } : {}) };
}

function code(body: string, language = 'tsx'): PendingCode {
  return { kind: 'code', language, body };
}

describe('formatElapsed', () => {
  it('counts seconds, then minutes, then hours', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(187_000)).toBe('3m 7s');
    expect(formatElapsed(3_840_000)).toBe('1h 4m');
  });
});

describe('formatTokens', () => {
  it('stays exact below a thousand and gets compact above it', () => {
    expect(formatTokens(820)).toBe('820');
    expect(formatTokens(1100)).toBe('1.1k');
    expect(formatTokens(12_300)).toBe('12k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });
});

describe('totalTokens', () => {
  it('sums what the server reported', () => {
    expect(totalTokens({ inputTokens: 900, outputTokens: 200 })).toBe(1100);
    expect(totalTokens({ inputTokens: 900 })).toBe(900);
  });

  it('is null when the server reported nothing, which is not zero', () => {
    expect(totalTokens(undefined)).toBeNull();
    expect(totalTokens({})).toBeNull();
    expect(totalTokens({ inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});

describe('totalTokens with caching', () => {
  it('counts new input, cache writes and output but not cache reads', () => {
    expect(
      totalTokens({ inputTokens: 100, cacheReadInputTokens: 5000, cacheCreationInputTokens: 400, outputTokens: 50 })
    ).toBe(550);
  });

  it('is null for a request that was only cache reads', () => {
    expect(totalTokens({ cacheReadInputTokens: 900 })).toBeNull();
  });
});

describe('formatCost', () => {
  it('prefers the server dollar figure and falls back to credits', () => {
    expect(formatCost({ usdCost: 3.2 })).toBe('$3.20');
    expect(formatCost({ usdCost: 0.004 })).toBe('$0.0040');
    expect(formatCost({ creditsUsed: 1234.4 })).toBe('1,234 credits');
    expect(formatCost({ usdCost: 1, creditsUsed: 9 })).toBe('$1.00');
  });

  it('is null when the server sent no cost', () => {
    expect(formatCost(undefined)).toBeNull();
    expect(formatCost({ inputTokens: 5 })).toBeNull();
  });
});

describe('describeSplit', () => {
  it('lists the four parts compactly and skips what was not reported', () => {
    expect(
      describeSplit({
        inputTokens: 12_000,
        cacheReadInputTokens: 1_100_000,
        cacheCreationInputTokens: 40_000,
        outputTokens: 3200,
      })
    ).toBe('12k new input, 1.1M cached, 40k cache write, 3.2k output');
    expect(describeSplit({ inputTokens: 300, outputTokens: 20 })).toBe('300 new input, 20 output');
    expect(describeSplit(undefined)).toBeNull();
    expect(describeSplit({})).toBeNull();
  });
});

describe('statusFields with usage', () => {
  it('shows the total without cache reads, and the cost, when there is one', () => {
    const usage = { inputTokens: 100, cacheReadInputTokens: 5000, outputTokens: 50, usdCost: 0.5 };
    expect(statusFields({ startedAt: 0, tokens: totalTokens(usage), usage }, 12_000, 'Thinking...')).toEqual([
      '12s',
      '150 tokens',
      '$0.50',
      'Thinking...',
    ]);
  });

  it('still lists the cached reads in the tooltip split', () => {
    expect(describeSplit({ inputTokens: 100, cacheReadInputTokens: 5000, outputTokens: 50 })).toContain('5.0k cached');
  });

  it('omits the cost when the server sent none', () => {
    const usage = { inputTokens: 100, outputTokens: 50 };
    expect(statusFields({ startedAt: 0, tokens: 150, usage }, 0, 'x')).toEqual(['0s', '150 tokens', 'x']);
  });
});

describe('describeActivity', () => {
  it('names code being written instead of calling it responding', () => {
    expect(describeActivity([], true, { kind: 'artifact', title: 'Dashboard', body: '<artifact' }).label).toBe(
      'Creating an artifact: Dashboard...'
    );
    expect(describeActivity([], true, code('const a = 1;')).label).toBe('Writing code...');
  });

  it('carries the hidden body, which is the one thing the thread does not draw', () => {
    const activity = describeActivity([], true, code('```tsx\nconst a = 1;'));
    expect(activity.kind).toBe('code');
    expect(activityDetail(activity)?.body).toBe('```tsx\nconst a = 1;');
  });

  it('still lets a running tool or an approval outrank code being written', () => {
    expect(describeActivity([call('file_read', 'running')], true, code('x')).kind).toBe('tool');
    expect(describeActivity([call('file_write', 'awaiting-approval')], true, code('x')).label).toBe(
      'Waiting for your answer...'
    );
  });

  it('puts a blocked approval ahead of everything else', () => {
    expect(describeActivity([call('bash_execute', 'awaiting-approval'), call('file_read', 'running')], false)).toEqual({
      kind: 'approval',
      label: 'Waiting for your answer...',
    });
  });

  it('names the one tool being waited on', () => {
    expect(describeActivity([call('file_read', 'running')], false).label).toBe('Reading files...');
  });

  it('prefers the progress line a running tool reports to the generic phrase', () => {
    expect(describeActivity([call('generate_image', 'running', 'rendering, 40%')], false).label).toBe('rendering, 40%');
  });

  it('keeps a progress line to one line, however much the tool printed', () => {
    const shouting = `step 1\n${'and then '.repeat(60)}`;
    const label = describeActivity([call('generate_image', 'running', shouting)], false).label;
    expect(label).toHaveLength(90);
    expect(label).not.toContain('\n');
  });

  it('counts the tools running at once rather than saying tools', () => {
    expect(describeActivity([call('file_read', 'running'), call('grep_search', 'running')], false).label).toBe(
      'Running 2 tools...'
    );
  });

  it('names a model that is thinking rather than reporting it as still responding', () => {
    // The five-to-ten-minute "Responding..." over a reply that stopped growing: the model wrote
    // a sentence and has been reasoning ever since, and only this event says so.
    expect(describeActivity([], true, null, 'weighing the options')).toEqual({
      kind: 'thinking',
      label: 'Thinking...',
      reasoning: 'weighing the options',
    });
  });

  it('lets a tool and code being written outrank reasoning, which only beats the two vague words', () => {
    expect(describeActivity([call('file_read', 'running')], true, null, 'hmm').kind).toBe('tool');
    expect(describeActivity([], true, code('const a = 1;'), 'hmm').kind).toBe('code');
  });

  it('distinguishes a reply being written from one not started', () => {
    expect(describeActivity([call('file_read', 'done')], true)).toEqual({ kind: 'text', label: 'Responding...' });
    expect(describeActivity([], false)).toEqual({ kind: 'thinking', label: 'Thinking...' });
  });
});

describe('writingProse', () => {
  const round = (text: string, toolCallIds: string[] = []): ChatReplyRound => ({ text, toolCallIds });
  const reply = (rounds: ChatReplyRound[]): ChatMessage => ({
    id: 'm1',
    role: 'assistant',
    content: rounds.map(each => each.text).join('\n\n'),
    createdAt: '2026-10-06T00:00:00.000Z',
    rounds,
  });

  it('is true while the open round is taking prose', () => {
    expect(writingProse(reply([round('Here is what I found')]))).toBe(true);
  });

  it('is false in the gap after a round ran tools, which is the model thinking again', () => {
    expect(writingProse(reply([round('I will look.', ['c1'])]))).toBe(false);
  });

  it('is true again once the next round has said something', () => {
    expect(writingProse(reply([round('I will look.', ['c1']), round('Found it.')]))).toBe(true);
  });

  it('reads a reply stored before rounds were recorded off its content', () => {
    expect(writingProse({ id: 'm2', role: 'assistant', content: 'hello', createdAt: 'x' })).toBe(true);
    expect(writingProse({ id: 'm3', role: 'assistant', content: '', createdAt: 'x' })).toBe(false);
    expect(writingProse(undefined)).toBe(false);
  });
});

describe('what the line will and will not disclose', () => {
  it('offers nothing behind what the thread is already drawing', () => {
    const waiting: ChatToolCall = {
      id: 'c1',
      name: 'bash_execute',
      input: { command: 'rm -rf build' },
      status: 'awaiting-approval',
      approvalDetail: 'rm -rf build',
    };
    // The approval card, the tool rows and the reply's own prose are all on screen already; a
    // second copy of any of them under the status line is the same words twice.
    for (const activity of [
      describeActivity([waiting], false),
      describeActivity([call('file_read', 'running')], false),
      describeActivity([call('file_read', 'running'), call('grep_search', 'running')], false),
      describeActivity([], true),
      describeActivity([], false),
    ]) {
      expect(hasActivityDetail(activity)).toBe(false);
      expect(activityDetail(activity)).toBeNull();
    }
  });

  it('offers the hidden body of code being written, and nothing when none has arrived', () => {
    expect(hasActivityDetail(describeActivity([], true, code('const a = 1;')))).toBe(true);
    expect(hasActivityDetail(describeActivity([], true, code('')))).toBe(false);
  });

  it('offers the reasoning, which is the other thing the thread never draws', () => {
    const thinking = describeActivity([], true, null, 'first I should check the schema');
    expect(hasActivityDetail(thinking)).toBe(true);
    expect(activityDetail(thinking)).toEqual({ body: 'first I should check the schema' });
    expect(hasActivityDetail(describeActivity([], false))).toBe(false);
  });

  it('tails the reasoning rather than mounting a ten-minute think', () => {
    const think = Array.from({ length: 300 }, (_, index) => `thought ${index}`).join('\n');
    const shown = activityDetail(describeActivity([], false, null, think))?.body ?? '';
    expect(shown.split('\n')).toHaveLength(12);
    expect(shown.endsWith('thought 299')).toBe(true);
  });
});

describe('withStall', () => {
  const turn = { startedAt: 1_000_000, tokens: null, lastEventAt: 1_002_000 };
  const thinking = describeActivity([], false);

  it('leaves an activity alone while events are still arriving', () => {
    expect(withStall(thinking, turn, turn.lastEventAt + STALL_AFTER_MS - 1)).toBe(thinking);
  });

  it('names the silence and times it once nothing has arrived', () => {
    const stalled = withStall(thinking, turn, turn.lastEventAt + 125_000);
    expect(stalled.label).toBe('Waiting for the model... 2m 5s');
  });

  it('measures from the start of the turn until the first event lands', () => {
    const fresh = { startedAt: 1_000_000, tokens: null };
    expect(withStall(thinking, fresh, fresh.startedAt + 60_000).label).toBe('Waiting for the model... 1m 0s');
  });

  // Measured, not assumed: see STALL_AFTER_MS. A turn that is merely thinking sends nothing for
  // tens of seconds on this server, and a line that called that stalled would be crying wolf on
  // every Claude turn.
  it('leaves a turn that has been quiet for half a minute alone', () => {
    expect(withStall(thinking, turn, turn.lastEventAt + 30_000)).toBe(thinking);
  });

  // Waiting is a dead end, not a disclosure: there is no live stream behind it, and the line
  // does not explain itself to the user instead.
  it('opens nothing at all, whatever the turn was doing when it went quiet', () => {
    const writing = describeActivity([], true, code('export function Dashboard() {'));
    const quietMidCode = withStall(writing, turn, turn.lastEventAt + 60_000);
    expect(hasActivityDetail(quietMidCode)).toBe(false);
    expect(activityDetail(quietMidCode)).toBeNull();
  });

  it('does not call a model that is sending reasoning stalled - those are its sign of life', () => {
    const thinking = describeActivity([], true, null, 'still working through it');
    const live = { startedAt: 1_000_000, tokens: null, lastEventAt: 1_600_000, reasoning: 'still working through it' };
    expect(withStall(thinking, live, live.lastEventAt + 5_000)).toBe(thinking);
  });

  it('never calls a running tool or a waiting approval stalled - the silence is theirs', () => {
    const running = describeActivity([call('bash_execute', 'running')], false);
    const waiting = describeActivity([call('bash_execute', 'awaiting-approval')], false);
    expect(withStall(running, turn, turn.lastEventAt + 600_000)).toBe(running);
    expect(withStall(waiting, turn, turn.lastEventAt + 600_000)).toBe(waiting);
  });
});

describe('activityDetail bounds', () => {
  it('tails a streamed body rather than mounting all of it', () => {
    const body = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');
    const shown = activityDetail(describeActivity([], true, code(body)))?.body ?? '';
    expect(shown.split('\n')).toHaveLength(12);
    expect(shown.endsWith('line 199')).toBe(true);
  });

  it('caps a body with no line breaks in it by characters', () => {
    const shown = activityDetail(describeActivity([], true, code('x'.repeat(1900))))?.body ?? '';
    expect(shown).toHaveLength(1200);
  });
});

describe('statusFields', () => {
  const startedAt = 1_000_000;

  it('leaves the token field out until a real count has arrived', () => {
    expect(statusFields({ startedAt, tokens: null }, startedAt + 5000, 'Thinking...')).toEqual(['5s', 'Thinking...']);
  });

  it('shows elapsed, tokens and activity once it has', () => {
    expect(statusFields({ startedAt, tokens: 1100 }, startedAt + 187_000, 'Running tools...')).toEqual([
      '3m 7s',
      '1.1k tokens',
      'Running tools...',
    ]);
  });
});

/**
 * A four-round tool loop, shaped the way a real one is: each request re-sends the conversation
 * so far, so the cached input grows every round while the WINDOW holds only the latest one.
 *
 * The rounds' inputs sum to well past a 200k window - which is what a status line that added
 * them up would report, and the reason this fixture has four of them rather than one.
 */
function toolLoop(): ChatMessage {
  const round = (cacheRead: number, input: number): ChatReplyRound => ({
    text: '',
    toolCallIds: [],
    usage: { inputTokens: input, cacheReadInputTokens: cacheRead, outputTokens: 400 },
  });
  return {
    id: 'reply',
    role: 'assistant',
    content: 'done',
    createdAt: '2026-01-01T00:00:00.000Z',
    toolCalls: [{ id: 'a', name: 'file_read', input: {}, status: 'done' }],
    rounds: [round(120_000, 2_000), round(150_000, 1_200), round(180_000, 900), round(190_000, 800)],
    usage: { inputTokens: 4900, cacheReadInputTokens: 640_000, outputTokens: 1600 },
  };
}

function reply(over: Partial<ChatMessage>): ChatMessage {
  return { id: 'reply', role: 'assistant', content: '', createdAt: '2026-01-01T00:00:00.000Z', ...over };
}

describe('inputSide', () => {
  it('counts cache reads, because a cached token fills the window like any other', () => {
    expect(inputSide({ inputTokens: 2000, cacheReadInputTokens: 120_000, cacheCreationInputTokens: 4000 })).toBe(
      126_000
    );
  });

  it('is a different quantity from the cost proxy, which drops exactly those reads', () => {
    const usage = { inputTokens: 2000, cacheReadInputTokens: 120_000, outputTokens: 500 };
    expect(inputSide(usage)).toBe(122_000);
    expect(totalTokens(usage)).toBe(2500);
  });

  it('says nothing rather than zero when the server reported no input at all', () => {
    expect(inputSide({ outputTokens: 500 })).toBeNull();
    expect(inputSide(undefined)).toBeNull();
  });
});

describe('contextTokens', () => {
  it('takes the last round only, so a long tool loop does not inflate past the window', () => {
    const message = toolLoop();
    expect(contextTokens(message)).toBe(190_800);
    expect(contextPercent(contextTokens(message), 200_000)).toBe(95);
    expect(contextPercent(contextTokens(message), 200_000)).toBeLessThanOrEqual(100);
  });

  it('is emphatically not the turn bill, which is what summing the rounds would give', () => {
    const message = toolLoop();
    const summed = message.rounds!.reduce((sum, round) => sum + (inputSide(round.usage) ?? 0), 0);
    expect(contextPercent(summed, 200_000)).toBeGreaterThan(100);
    expect(contextTokens(message)).toBeLessThan(summed);
  });

  it('falls back through rounds the server reported nothing for', () => {
    const message = reply({
      toolCalls: [{ id: 'a', name: 'file_read', input: {}, status: 'done' }],
      rounds: [
        { text: '', toolCallIds: [], usage: { inputTokens: 900, cacheReadInputTokens: 40_000 } },
        { text: '', toolCallIds: [] },
      ],
    });
    expect(contextTokens(message)).toBe(40_900);
  });

  it('reads a plain one-request reply off the message itself', () => {
    expect(contextTokens(reply({ usage: { inputTokens: 1200, cacheReadInputTokens: 8000 } }))).toBe(9200);
  });

  // A message stored before rounds were recorded: `usage` is the summed bill of several
  // requests, and reporting it as occupancy is the exact overstatement this guards.
  it('gives up on a legacy multi-round reply rather than reporting its summed bill', () => {
    const message = reply({
      toolCalls: [{ id: 'a', name: 'file_read', input: {}, status: 'done' }],
      usage: { inputTokens: 4900, cacheReadInputTokens: 650_000 },
    });
    expect(contextTokens(message)).toBeNull();
  });

  it('describes replies, not prompts', () => {
    expect(contextTokens({ ...reply({}), role: 'user', usage: { inputTokens: 10 } })).toBeNull();
    expect(contextTokens(null)).toBeNull();
  });
});

describe('latestReply', () => {
  it('reports the last reply, skipping anything typed since', () => {
    const older = reply({ id: 'first', usage: { inputTokens: 100 } });
    const newer = reply({ id: 'second', usage: { inputTokens: 900 } });
    const typed: ChatMessage = { id: 'typed', role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:01.000Z' };
    expect(latestReply([older, newer, typed])?.id).toBe('second');
  });

  it('has nothing to report in a conversation with no reply yet', () => {
    expect(latestReply([])).toBeNull();
  });

  /**
   * The figure has to answer the question `/clear` and `/compact` were used to change. The
   * request behind a reply from before the boundary measured a window that no longer exists,
   * and reporting it would tell the user their compaction did nothing at all.
   */
  it('reports nothing measured once a boundary has been inserted', () => {
    const boundary: ChatMessage = {
      id: 'b1',
      role: 'user',
      content: '',
      createdAt: '2026-01-01T00:00:02.000Z',
      system: true,
      boundary: { kind: 'compact' },
    };
    const before = reply({ id: 'before', usage: { inputTokens: 180_000 } });
    expect(latestReply([before, boundary])).toBeNull();
    expect(contextTokens(latestReply([before, boundary]))).toBeNull();
    // Unknown rather than estimated, which is this file's rule everywhere: the next request is
    // what states the new occupancy, and a client-side guess drawn as a fact would be worse.
    expect(usageLabel({ contextTokens: null, contextWindow: 200_000, credits: 31_667 })).toBe('Context --');
  });

  it('reports the first reply measured after the boundary, not the ones before it', () => {
    const boundary: ChatMessage = {
      id: 'b1',
      role: 'user',
      content: 'summary',
      createdAt: '2026-01-01T00:00:02.000Z',
      system: true,
      boundary: { kind: 'compact' },
    };
    const before = reply({ id: 'before', usage: { inputTokens: 180_000 } });
    const after = reply({ id: 'after', usage: { inputTokens: 9000 } });
    expect(latestReply([before, boundary, after])?.id).toBe('after');
    expect(contextTokens(latestReply([before, boundary, after]))).toBe(9000);
  });

  /**
   * The reply being streamed has measured nothing: its rounds and its own usage both arrive
   * with the terminal event. Reported as the latest reply it would blank the indicator for the
   * whole turn, which is precisely when the user is watching it.
   */
  it('passes over the reply in flight so the last measured request is still the answer', () => {
    const settled = reply({ id: 'settled', usage: { inputTokens: 44_000 } });
    const typed: ChatMessage = { id: 'typed', role: 'user', content: 'go on', createdAt: '2026-01-01T00:00:01.000Z' };
    const open = reply({ id: 'open' });
    expect(latestReply([settled, typed, open], true)?.id).toBe('settled');
    expect(contextTokens(latestReply([settled, typed, open], true))).toBe(44_000);
  });

  it('reports the turn it just finished as soon as the turn is no longer open', () => {
    const settled = reply({ id: 'settled', usage: { inputTokens: 44_000 } });
    const landed = reply({ id: 'landed', usage: { inputTokens: 51_000 } });
    expect(latestReply([settled, landed], false)?.id).toBe('landed');
  });

  // The boundary still wins over the holding: a turn running after `/compact` measures the new
  // window, and reaching back past the boundary for a figure would be the old one.
  it('holds nothing from before a boundary, turn open or not', () => {
    const boundary: ChatMessage = {
      id: 'b1',
      role: 'user',
      content: '',
      createdAt: '2026-01-01T00:00:02.000Z',
      system: true,
      boundary: { kind: 'compact' },
    };
    const before = reply({ id: 'before', usage: { inputTokens: 180_000 } });
    expect(latestReply([before, boundary, reply({ id: 'open' })], true)).toBeNull();
  });

  // Only while the turn is open. A stored reply that measured nothing still reads as unknown,
  // rather than quietly reporting an older turn's smaller window as this one's.
  it('does not reach past an unmeasured reply once the turn has settled', () => {
    const measured = reply({ id: 'measured', usage: { inputTokens: 44_000 } });
    const legacy = reply({ id: 'legacy', toolCalls: [{ id: 'a', name: 'file_read', input: {}, status: 'done' }] });
    expect(latestReply([measured, legacy], false)?.id).toBe('legacy');
    expect(contextTokens(latestReply([measured, legacy], false))).toBeNull();
  });
});

describe('occupancyArc', () => {
  it('draws the occupancy it is given, up to a full ring', () => {
    expect(occupancyArc(22)).toBe(22);
    expect(occupancyArc(100)).toBe(100);
    expect(occupancyArc(140)).toBe(100);
  });

  /**
   * The ring is the whole indicator, so an arc too short to see is the same picture as the
   * empty ring that means nothing was measured. The floor is the ring's version of "<1%".
   */
  it('floors a real but tiny occupancy to an arc that can be seen', () => {
    expect(occupancyArc(0)).toBe(4);
    expect(occupancyArc(1)).toBe(4);
    expect(occupancyArc(5)).toBe(5);
  });
});

describe('occupancyColor', () => {
  it('names the band rather than a colour, so both themes get their own value', () => {
    expect(occupancyColor(0)).toBe('primary');
    expect(occupancyColor(74)).toBe('primary');
    expect(occupancyColor(75)).toBe('warning');
    expect(occupancyColor(89)).toBe('warning');
    expect(occupancyColor(90)).toBe('danger');
    expect(occupancyColor(100)).toBe('danger');
  });

  // An unstated window is not a full one, and borrowing the full-window colour for it would
  // be the same something-shown-as-a-fact this file refuses everywhere else.
  it('is neutral for an occupancy nobody stated', () => {
    expect(occupancyColor(null)).toBe('neutral');
  });
});

describe('contextPercent', () => {
  it('is null when either half of the fraction is missing, never a percentage of a guess', () => {
    expect(contextPercent(null, 200_000)).toBeNull();
    expect(contextPercent(44_000, null)).toBeNull();
    expect(contextPercent(44_000, 0)).toBeNull();
  });
});

describe('usageLabel', () => {
  const known: ComposerUsage = { contextTokens: 44_000, contextWindow: 200_000, credits: 31_667 };

  it('carries the window figure alone; the balance is a hover away', () => {
    expect(usageLabel(known)).toBe('Context 22%');
    expect(usageLabel(known)).not.toContain('credits');
  });

  it('keeps its shape when the window figure is missing, so the row does not jump', () => {
    expect(usageLabel({ ...known, contextTokens: null })).toBe('Context --');
    expect(usageLabel({ ...known, contextWindow: null })).toBe('Context --');
  });

  // The hover target has to survive a balance this client could not read, and a window figure
  // it has not measured - otherwise the one field that still knows something is unreachable.
  it('still shows a field while either figure is known', () => {
    expect(usageLabel({ ...known, credits: null })).toBe('Context 22%');
    expect(usageLabel({ contextTokens: null, contextWindow: null, credits: 0 })).toBe('Context --');
  });

  it('says nothing when it knows nothing, leaving the caller its own fallback', () => {
    expect(usageLabel({ contextTokens: null, contextWindow: null, credits: null })).toBeNull();
  });
});

describe('describeUsage', () => {
  it('spells both figures out and names them apart from what the turn cost', () => {
    const detail = describeUsage({
      contextTokens: 44_000,
      contextWindow: 200_000,
      credits: 31_667,
      lastTurn: { inputTokens: 2000, cacheReadInputTokens: 120_000, outputTokens: 500, usdCost: 0.42 },
    });
    expect(detail).toContain('Context 44k / 200k (22%)');
    expect(detail).toContain('Credits 31,667 personal balance');
    expect(detail).toContain('Last turn 2.0k new input, 120k cached, 500 output - $0.42');
  });

  it('reports the tokens without inventing a window when the model states none', () => {
    const detail = describeUsage({ contextTokens: 44_000, contextWindow: null, credits: 12 });
    expect(detail).toContain('Context 44k used - this model reports no window size');
    expect(detail).not.toContain('%');
  });

  it('says why the balance is missing rather than showing a zero', () => {
    const detail = describeUsage({
      contextTokens: null,
      contextWindow: 200_000,
      credits: null,
      creditsError: 'Could not read your balance from this server.',
    });
    expect(detail).toContain('Context - nothing measured in this conversation yet');
    expect(detail).toContain('Credits - Could not read your balance from this server.');
    expect(detail).not.toContain('Credits 0');
  });
});

describe('a real turn against a very large window', () => {
  // The figures a gpt-5 turn actually produced against its 1.05M window: two rounds, the second
  // re-reading the first from cache. The naive sum of both rounds' inputs is nearly twice the
  // real occupancy after only two rounds, which is how fast that mistake compounds.
  const rounds: ChatReplyRound[] = [
    { text: '', toolCallIds: [], usage: { inputTokens: 3935, outputTokens: 99 } },
    { text: '', toolCallIds: [], usage: { inputTokens: 258, cacheReadInputTokens: 3932, outputTokens: 53 } },
  ];
  const message = reply({
    toolCalls: [{ id: 'a', name: 'file_search', input: {}, status: 'done' }],
    rounds,
    usage: { inputTokens: 4193, cacheReadInputTokens: 3932, outputTokens: 152, creditsUsed: 54 },
  });

  it('reads occupancy off the last round, not off the turn bill', () => {
    expect(contextTokens(message)).toBe(4190);
    expect(inputSide(message.usage)).toBe(8125);
  });

  // Under half a percent of a 1.05M window. "0%" would render a measured context exactly like
  // no context at all, which is the one thing every other field here refuses to do.
  it('says <1% rather than 0% for an occupancy that is real but tiny', () => {
    const usage: ComposerUsage = { contextTokens: 4190, contextWindow: 1_050_000, credits: 1991 };
    expect(usageLabel(usage)).toBe('Context <1%');
    expect(describeUsage(usage)).toContain('Context 4.2k / 1.1M (<1%)');
  });

  it('still says 0% when there is genuinely nothing in the window', () => {
    expect(usageLabel({ contextTokens: 0, contextWindow: 1_050_000, credits: 1991 })).toBe('Context 0%');
  });

  // A turn costs tens of credits against a balance in the thousands. Compacting the balance
  // would leave the field reading "2.0k" for twenty turns running.
  // Exact rather than compacted, because the balance only appears on hover now and a reader
  // who went looking for it wants the figure, not a rounded "2.0k" that a turn cannot move.
  it('moves the balance on hover after a single turn', () => {
    const at = (credits: number) => describeUsage({ contextTokens: 4190, contextWindow: 1_050_000, credits });
    expect(at(2045)).toContain('Credits 2,045 personal balance');
    expect(at(1991)).toContain('Credits 1,991 personal balance');
  });
});
