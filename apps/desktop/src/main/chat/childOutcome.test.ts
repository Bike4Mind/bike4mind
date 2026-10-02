import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatSession } from '@shared/chat';
import { childOutcomeDisplay, classifyChildOutcome } from './childOutcome';

const CHILD_ID = 'e8d8981c-5829-4e70-a20a-8e82370ac565';

function child(last?: Partial<ChatMessage>): ChatSession {
  const messages: ChatMessage[] = [
    { id: 'm0', role: 'user', content: 'go and do it', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  if (last) {
    messages.push({
      id: 'm1',
      role: 'assistant',
      content: 'the XP engine is wired up',
      createdAt: '2026-01-01T00:01:00.000Z',
      ...last,
    });
  }
  return {
    id: CHILD_ID,
    title: 'T4: XP engine',
    model: 'claude',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    mode: 'chat',
    reasoningEffort: 'default',
    approvalMode: 'ask',
    messageCount: messages.length,
    messages,
  } as ChatSession;
}

describe('classifyChildOutcome', () => {
  it('reads the LAST assistant turn, not the first', () => {
    const session = child({ stopReason: 'aborted' });
    session.messages.splice(1, 0, {
      id: 'm0b',
      role: 'assistant',
      content: 'starting',
      createdAt: '2026-01-01T00:00:30.000Z',
    });
    expect(classifyChildOutcome(session)).toBe('aborted');
  });

  it('prefers an error over whatever stop reason came with it', () => {
    expect(classifyChildOutcome(child({ error: 'the provider refused', stopReason: 'max_tokens' }))).toBe('failed');
  });
});

describe('childOutcomeDisplay', () => {
  it('says only that it finished when it finished', () => {
    expect(childOutcomeDisplay(child({ stopReason: 'end_turn' }))).toBe('The session "T4: XP engine" has finished.');
  });

  it('distinguishes a session that never replied', () => {
    expect(childOutcomeDisplay(child())).toBe('The session "T4: XP engine" has finished. It did not reply.');
  });

  it('distinguishes a session that failed, and says what went wrong', () => {
    expect(childOutcomeDisplay(child({ error: 'the provider refused' }))).toBe(
      'The session "T4: XP engine" stopped with an error: the provider refused'
    );
  });

  it('distinguishes each way of stopping short', () => {
    const said = [
      childOutcomeDisplay(child({ stopReason: 'tool_turn_limit' })),
      childOutcomeDisplay(child({ stopReason: 'context_limit' })),
      childOutcomeDisplay(child({ stopReason: 'max_tokens' })),
      childOutcomeDisplay(child({ stopReason: 'aborted' })),
    ];
    expect(said).toEqual([
      'The session "T4: XP engine" stopped early after too many steps, so its work may be incomplete.',
      'The session "T4: XP engine" stopped early because it ran out of room, so its work may be incomplete.',
      'The session "T4: XP engine" has finished, but its last reply was cut short.',
      'The session "T4: XP engine" was stopped before it finished.',
    ]);
  });

  // The regression this whole field exists for: what the user reads must carry no id and name
  // no tool, however the run ended.
  it('never shows a session id, a tool name, or a raw stop reason', () => {
    const endings: Partial<ChatMessage>[] = [
      {},
      { stopReason: 'end_turn' },
      { stopReason: 'tool_turn_limit' },
      { stopReason: 'turn_time_limit' },
      { stopReason: 'tool_stall_limit' },
      { stopReason: 'context_limit' },
      { stopReason: 'max_tokens' },
      { stopReason: 'aborted' },
      { error: 'the provider refused' },
    ];

    for (const ending of endings) {
      const text = childOutcomeDisplay(child(Object.keys(ending).length === 0 ? undefined : ending));
      expect(text).not.toContain(CHILD_ID);
      expect(text).not.toMatch(/session_read|session_send|session_spawn|_read\b/);
      expect(text).not.toMatch(/tool_turn_limit|turn_time_limit|tool_stall_limit|context_limit|max_tokens|aborted/);
      expect(text).toContain('T4: XP engine');
    }
  });
});
