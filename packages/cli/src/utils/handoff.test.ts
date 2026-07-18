import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  buildHandoffPrompt,
  parseHandoffResponse,
  formatHandoffOutput,
  buildHandoffSystemMessage,
  injectHandoffMessage,
  injectWorkflowStateMessage,
  isInjectedHandoff,
  isInjectedWorkflowState,
  isInjectedContinuity,
  HANDOFF_MARKER,
  WORKFLOW_STATE_MARKER,
  SHORT_SESSION_THRESHOLD,
  buildLocalHandoff,
  renderLocalHandoffMarkdown,
  writeLocalHandoffFile,
  isLlmUnavailableError,
  LOCAL_HANDOFF_MESSAGE_TAIL,
} from './handoff.js';
import type { Message, Session, SessionHandoff, WorkflowState } from '../storage/types.js';
import type { TodoItem } from '../tools/writeTodosTool.js';

function createHandoff(overrides: Partial<SessionHandoff> = {}): SessionHandoff {
  return {
    summary: 'Did stuff',
    keyFindings: [],
    nextSteps: [],
    pendingDecisions: [],
    blockers: [],
    generatedAt: '2026-05-04T00:00:00.000Z',
    ...overrides,
  };
}

function createMessage(role: Message['role'], content: string, index: number): Message {
  return {
    id: `msg-${index}`,
    role,
    content,
    timestamp: new Date(Date.now() - (10 - index) * 60000).toISOString(),
  };
}

function createSession(messages: Message[], workflow?: WorkflowState): Session {
  return {
    id: 'test-session-id',
    name: 'Test Session',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: 'claude-sonnet',
    messages,
    metadata: {
      totalTokens: 1000,
      totalCost: 0.01,
      toolCallCount: 5,
      ...(workflow ? { workflow } : {}),
    },
  };
}

describe('handoff', () => {
  describe('buildHandoffPrompt', () => {
    it(`returns empty string for sessions shorter than ${SHORT_SESSION_THRESHOLD} messages`, () => {
      const messages = Array.from({ length: SHORT_SESSION_THRESHOLD - 1 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i)
      );

      const prompt = buildHandoffPrompt(createSession(messages));

      expect(prompt).toBe('');
    });

    it('returns a non-empty prompt at the threshold', () => {
      const messages = Array.from({ length: SHORT_SESSION_THRESHOLD }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i)
      );

      const prompt = buildHandoffPrompt(createSession(messages));

      expect(prompt).not.toBe('');
      expect(prompt).toContain('CONVERSATION:');
    });

    it('asks for the SessionHandoff JSON shape', () => {
      const messages = Array.from({ length: 6 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i)
      );

      const prompt = buildHandoffPrompt(createSession(messages));

      expect(prompt).toContain('"summary"');
      expect(prompt).toContain('"keyFindings"');
      expect(prompt).toContain('"nextSteps"');
      expect(prompt).toContain('"pendingDecisions"');
      expect(prompt).toContain('"blockers"');
    });

    it('includes logged decisions and open blockers from workflow state', () => {
      const messages = Array.from({ length: 6 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i)
      );

      const workflow: WorkflowState = {
        decisions: [
          {
            id: 'd1',
            timestamp: new Date().toISOString(),
            summary: 'Use Postgres over MySQL',
            rationale: 'Better JSONB support',
          },
        ],
        blockers: [
          { id: 'b1', createdAt: new Date().toISOString(), description: 'Missing API key', status: 'open' },
          { id: 'b2', createdAt: new Date().toISOString(), description: 'Resolved blocker', status: 'resolved' },
        ],
      };

      const prompt = buildHandoffPrompt(createSession(messages, workflow));

      expect(prompt).toContain('Use Postgres over MySQL');
      expect(prompt).toContain('Better JSONB support');
      expect(prompt).toContain('Missing API key');
      expect(prompt).not.toContain('Resolved blocker');
    });

    it('omits workflow sections when state is empty', () => {
      const messages = Array.from({ length: 6 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i)
      );

      const prompt = buildHandoffPrompt(createSession(messages, { decisions: [], blockers: [] }));

      expect(prompt).not.toContain('LOGGED DECISIONS');
      expect(prompt).not.toContain('OPEN BLOCKERS');
    });

    it('truncates very long messages', () => {
      const longContent = 'x'.repeat(3000);
      const messages: Message[] = [
        createMessage('user', longContent, 0),
        createMessage('assistant', 'Short', 1),
        createMessage('user', 'Mid', 2),
        createMessage('assistant', 'End', 3),
      ];

      const prompt = buildHandoffPrompt(createSession(messages));

      expect(prompt).toContain('...[truncated]');
      expect(prompt.length).toBeLessThan(longContent.length + 5000);
    });
  });

  describe('parseHandoffResponse', () => {
    it('parses a clean JSON object', () => {
      const response = JSON.stringify({
        summary: 'Implemented user auth',
        keyFindings: ['Token refresh was missing'],
        nextSteps: ['Add tests'],
        pendingDecisions: [],
        blockers: [],
      });

      const result = parseHandoffResponse(response);

      expect(result).not.toBeNull();
      expect(result?.summary).toBe('Implemented user auth');
      expect(result?.keyFindings).toEqual(['Token refresh was missing']);
      expect(result?.nextSteps).toEqual(['Add tests']);
      expect(result?.pendingDecisions).toEqual([]);
      expect(result?.blockers).toEqual([]);
      expect(result?.generatedAt).toBeTruthy();
    });

    it('strips fenced code blocks', () => {
      const response =
        '```json\n{"summary":"Did stuff","keyFindings":[],"nextSteps":[],"pendingDecisions":[],"blockers":[]}\n```';

      const result = parseHandoffResponse(response);

      expect(result).not.toBeNull();
      expect(result?.summary).toBe('Did stuff');
    });

    it('extracts JSON object from surrounding prose', () => {
      const response = `Here is the handoff:\n{"summary":"Hello","keyFindings":["a"],"nextSteps":[],"pendingDecisions":[],"blockers":[]}\nThanks!`;

      const result = parseHandoffResponse(response);

      expect(result).not.toBeNull();
      expect(result?.summary).toBe('Hello');
      expect(result?.keyFindings).toEqual(['a']);
    });

    it('handles braces inside string values', () => {
      const response = `{"summary":"Saw {weird} braces in input","keyFindings":[],"nextSteps":[],"pendingDecisions":[],"blockers":[]}`;

      const result = parseHandoffResponse(response);

      expect(result?.summary).toBe('Saw {weird} braces in input');
    });

    it('returns null for malformed JSON', () => {
      expect(parseHandoffResponse('not json')).toBeNull();
      expect(parseHandoffResponse('{ broken')).toBeNull();
      expect(parseHandoffResponse('')).toBeNull();
    });

    it('returns null when summary is missing or empty', () => {
      expect(parseHandoffResponse('{"summary":""}')).toBeNull();
      expect(parseHandoffResponse('{"keyFindings":[]}')).toBeNull();
    });

    it('coerces non-string array entries to empty', () => {
      const response = JSON.stringify({
        summary: 'ok',
        keyFindings: ['valid', 42, null, '  ', 'also valid'],
        nextSteps: 'not an array',
        pendingDecisions: [],
        blockers: [],
      });

      const result = parseHandoffResponse(response);

      expect(result?.keyFindings).toEqual(['valid', 'also valid']);
      expect(result?.nextSteps).toEqual([]);
    });
  });

  describe('formatHandoffOutput', () => {
    it('includes summary and all non-empty sections', () => {
      const handoff: SessionHandoff = {
        summary: 'Worked on auth',
        keyFindings: ['Found bug in middleware.ts'],
        nextSteps: ['Add regression test'],
        pendingDecisions: [],
        blockers: ['CI is red'],
        generatedAt: '2026-05-04T00:00:00.000Z',
      };

      const output = formatHandoffOutput(handoff);

      expect(output).toContain('Worked on auth');
      expect(output).toContain('Key findings:');
      expect(output).toContain('Found bug in middleware.ts');
      expect(output).toContain('Next steps:');
      expect(output).toContain('Blockers:');
      expect(output).not.toContain('Pending decisions:');
      expect(output).toContain('Generated: 2026-05-04T00:00:00.000Z');
    });
  });

  describe('buildHandoffSystemMessage', () => {
    it('wraps the formatted output with the handoff marker', () => {
      const message = buildHandoffSystemMessage(createHandoff({ summary: 'Did things' }));

      expect(message.startsWith(HANDOFF_MARKER)).toBe(true);
      expect(message).toContain('Did things');
    });

    it('omits the Generated timestamp so the prompt stays cache-stable', () => {
      const message = buildHandoffSystemMessage(createHandoff({ generatedAt: '2026-05-04T00:00:00.000Z' }));

      expect(message).not.toContain('Generated:');
      expect(message).not.toContain('2026-05-04');
    });
  });

  describe('isInjectedHandoff', () => {
    it('identifies user messages with the handoff marker', () => {
      expect(
        isInjectedHandoff({
          id: '1',
          role: 'user',
          content: buildHandoffSystemMessage(createHandoff()),
          timestamp: 'now',
        })
      ).toBe(true);
    });

    it('rejects non-user messages and unrelated user messages', () => {
      expect(isInjectedHandoff({ id: '1', role: 'assistant', content: HANDOFF_MARKER, timestamp: 'now' })).toBe(false);
      expect(
        isInjectedHandoff({
          id: '1',
          role: 'system',
          content: buildHandoffSystemMessage(createHandoff()),
          timestamp: 'now',
        })
      ).toBe(false);
      expect(
        isInjectedHandoff({
          id: '1',
          role: 'user',
          content: '[Previous conversation summary]\n\nblah',
          timestamp: 'now',
        })
      ).toBe(false);
    });
  });

  describe('injectHandoffMessage', () => {
    it('prepends a handoff message when none exists', () => {
      const messages: Message[] = [createMessage('user', 'hi', 0)];
      const handoff = createHandoff({ summary: 'fresh' });

      const result = injectHandoffMessage(messages, handoff);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[0].content).toContain('fresh');
      expect(result[1]).toBe(messages[0]);
    });

    it('replaces an existing injected handoff instead of stacking', () => {
      const previous: Message = {
        id: 'prev',
        role: 'user',
        content: buildHandoffSystemMessage(createHandoff({ summary: 'old' })),
        timestamp: 'old',
      };
      const messages: Message[] = [previous, createMessage('user', 'hi', 0)];
      const handoff = createHandoff({ summary: 'new' });

      const result = injectHandoffMessage(messages, handoff);

      expect(result).toHaveLength(2);
      expect(result[0].id).not.toBe('prev');
      expect(result[0].content).toContain('new');
      expect(result[0].content).not.toContain('old');
      expect(result[1]).toBe(messages[1]);
    });

    it('preserves unrelated leading system messages (e.g. compaction summary)', () => {
      const compactionSummary: Message = {
        id: 'sum',
        role: 'system',
        content: '[Previous conversation summary]\n\nstuff happened',
        timestamp: 'old',
      };
      const messages: Message[] = [compactionSummary, createMessage('user', 'hi', 0)];

      const result = injectHandoffMessage(messages, createHandoff());

      expect(result).toHaveLength(3);
      expect(result[0].content.startsWith(HANDOFF_MARKER)).toBe(true);
      expect(result[1]).toBe(compactionSummary);
    });

    it('returns a new array without mutating the input', () => {
      const messages: Message[] = [createMessage('user', 'hi', 0)];
      const original = [...messages];

      const result = injectHandoffMessage(messages, createHandoff());

      expect(result).not.toBe(messages);
      expect(messages).toEqual(original);
    });

    it('survives repeated injections without growing (save/resume cycle)', () => {
      let messages: Message[] = [createMessage('user', 'hi', 0), createMessage('assistant', 'yo', 1)];

      messages = injectHandoffMessage(messages, createHandoff({ summary: 'first' }));
      messages = injectHandoffMessage(messages, createHandoff({ summary: 'second' }));
      messages = injectHandoffMessage(messages, createHandoff({ summary: 'third' }));

      expect(messages).toHaveLength(3);
      expect(messages[0].content).toContain('third');
      expect(messages[0].content).not.toContain('first');
      expect(messages[0].content).not.toContain('second');
    });

    it('replaces a prior handoff even when a compaction summary precedes it', () => {
      const compactionSummary: Message = {
        id: 'sum',
        role: 'system',
        content: '[Previous conversation summary]\n\nstuff happened',
        timestamp: 'old',
      };
      const oldHandoff: Message = {
        id: 'old-handoff',
        role: 'user',
        content: buildHandoffSystemMessage(createHandoff({ summary: 'OLD' })),
        timestamp: 'older',
      };
      // Simulates: resume injects handoff at index 0, then compaction prepends
      // a summary. On the next resume, the prior handoff sits at index 1, not 0.
      const messages: Message[] = [compactionSummary, oldHandoff, createMessage('user', 'hi', 0)];

      const result = injectHandoffMessage(messages, createHandoff({ summary: 'NEW' }));

      // Old handoff is gone, new handoff is at the top, compaction summary preserved.
      expect(result).toHaveLength(3);
      expect(result[0].content).toContain('NEW');
      expect(result[0].content).not.toContain('OLD');
      expect(result.some(m => m.id === 'old-handoff')).toBe(false);
      expect(result.some(m => m.id === 'sum')).toBe(true);
    });

    it('strips a prior injected workflow-state message so the two never co-exist', () => {
      const priorState: Message = {
        id: 'state',
        role: 'user',
        content: `${WORKFLOW_STATE_MARKER}\n\nRecent decisions:\n- something`,
        timestamp: 'old',
      };
      const messages: Message[] = [priorState, createMessage('user', 'hi', 0)];

      const result = injectHandoffMessage(messages, createHandoff({ summary: 'NEW' }));

      expect(result).toHaveLength(2);
      expect(result[0].content).toContain('NEW');
      expect(result.some(m => m.id === 'state')).toBe(false);
    });
  });

  describe('isInjectedWorkflowState / isInjectedContinuity', () => {
    const stateMsg = (content: string, role: Message['role'] = 'user'): Message => ({
      id: '1',
      role,
      content,
      timestamp: 'now',
    });

    it('recognizes a workflow-state message only when marked and role=user', () => {
      expect(isInjectedWorkflowState(stateMsg(`${WORKFLOW_STATE_MARKER}\n\nx`))).toBe(true);
      expect(isInjectedWorkflowState(stateMsg(`${WORKFLOW_STATE_MARKER}`, 'assistant'))).toBe(false);
      expect(isInjectedWorkflowState(stateMsg('plain message'))).toBe(false);
    });

    it('isInjectedContinuity covers both handoff and workflow-state markers', () => {
      expect(isInjectedContinuity(stateMsg(`${HANDOFF_MARKER}\n\nx`))).toBe(true);
      expect(isInjectedContinuity(stateMsg(`${WORKFLOW_STATE_MARKER}\n\nx`))).toBe(true);
      expect(isInjectedContinuity(stateMsg('plain'))).toBe(false);
    });
  });

  describe('injectWorkflowStateMessage', () => {
    const workflow = (overrides: Partial<WorkflowState> = {}): WorkflowState => ({
      decisions: [{ id: 'd1', timestamp: 'now', summary: 'chose SSE', rationale: 'simplest' }],
      blockers: [{ id: 'b1', createdAt: 'now', description: 'need API key', status: 'open' }],
      ...overrides,
    });

    it('prepends a marked workflow-state user message rendering open decisions and blockers', () => {
      const messages: Message[] = [createMessage('user', 'hi', 0)];

      const result = injectWorkflowStateMessage(messages, workflow());

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[0].content.startsWith(WORKFLOW_STATE_MARKER)).toBe(true);
      expect(result[0].content).toContain('chose SSE');
      expect(result[0].content).toContain('need API key');
      expect(result[1]).toBe(messages[0]);
    });

    it('injects nothing when there is no open state (returns the list unchanged in content)', () => {
      const messages: Message[] = [createMessage('user', 'hi', 0)];

      expect(injectWorkflowStateMessage(messages, { decisions: [], blockers: [] })).toEqual(messages);
      expect(injectWorkflowStateMessage(messages, undefined)).toEqual(messages);
    });

    it('does not render resolved blockers', () => {
      const result = injectWorkflowStateMessage([createMessage('user', 'hi', 0)], {
        decisions: [],
        blockers: [{ id: 'b1', createdAt: 'now', description: 'was blocked', status: 'resolved' }],
      });

      // Only a resolved blocker and no decisions => nothing to surface.
      expect(result).toHaveLength(1);
    });

    it('replaces a prior workflow-state injection instead of stacking', () => {
      const prior: Message = {
        id: 'prev-state',
        role: 'user',
        content: `${WORKFLOW_STATE_MARKER}\n\nRecent decisions:\n- old`,
        timestamp: 'old',
      };
      const messages: Message[] = [prior, createMessage('user', 'hi', 0)];

      const result = injectWorkflowStateMessage(messages, workflow());

      expect(result).toHaveLength(2);
      expect(result[0].id).not.toBe('prev-state');
      expect(result[0].content).toContain('chose SSE');
      expect(result.some(m => m.id === 'prev-state')).toBe(false);
    });

    it('strips a prior injected handoff so the two never co-exist', () => {
      const priorHandoff: Message = {
        id: 'handoff',
        role: 'user',
        content: buildHandoffSystemMessage(createHandoff({ summary: 'OLD HANDOFF' })),
        timestamp: 'old',
      };
      const messages: Message[] = [priorHandoff, createMessage('user', 'hi', 0)];

      const result = injectWorkflowStateMessage(messages, workflow());

      expect(result).toHaveLength(2);
      expect(result[0].content.startsWith(WORKFLOW_STATE_MARKER)).toBe(true);
      expect(result.some(m => m.id === 'handoff')).toBe(false);
    });

    it('does not mutate the input array', () => {
      const messages: Message[] = [createMessage('user', 'hi', 0)];
      const original = [...messages];

      injectWorkflowStateMessage(messages, workflow());

      expect(messages).toEqual(original);
    });
  });

  describe('buildHandoffPrompt message cap', () => {
    it('caps the conversation excerpt to the most recent messages', () => {
      const total = 120;
      const messages = Array.from({ length: total }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `MSG_${i}`, i)
      );

      const prompt = buildHandoffPrompt(createSession(messages));

      // Most recent messages are kept; earliest are dropped.
      expect(prompt).toContain(`MSG_${total - 1}`);
      expect(prompt).toContain(`MSG_${total - 50}`);
      expect(prompt).not.toContain('MSG_0\n');
      expect(prompt).not.toContain('MSG_5\n');
    });
  });

  describe('buildLocalHandoff', () => {
    it('produces decisions and open blockers verbatim, ignoring resolved blockers', () => {
      const workflow: WorkflowState = {
        decisions: [
          {
            id: 'd1',
            timestamp: '2026-01-01T00:00:00.000Z',
            summary: 'Use Postgres',
            rationale: 'JSONB support',
          },
        ],
        blockers: [
          { id: 'b1', createdAt: 'now', description: 'Missing API key', status: 'open' },
          { id: 'b2', createdAt: 'now', description: 'Already fixed', status: 'resolved' },
        ],
      };
      const session = createSession([createMessage('user', 'hi', 0)], workflow);

      const handoff = buildLocalHandoff(session);

      expect(handoff.summary).toContain('Local handoff');
      expect(handoff.summary).toContain('Test Session');
      expect(handoff.keyFindings).toEqual(['Use Postgres (rationale: JSONB support)']);
      expect(handoff.nextSteps).toEqual(['Resolve blocker: Missing API key']);
      expect(handoff.pendingDecisions).toEqual([]);
      expect(handoff.blockers).toEqual(['Missing API key']);
      expect(handoff.generatedAt).toBeTruthy();
    });

    it('handles sessions with no workflow state', () => {
      const session = createSession([createMessage('user', 'hi', 0)]);

      const handoff = buildLocalHandoff(session);

      expect(handoff.summary).toContain('Local handoff');
      expect(handoff.keyFindings).toEqual([]);
      expect(handoff.nextSteps).toEqual([]);
      expect(handoff.pendingDecisions).toEqual([]);
      expect(handoff.blockers).toEqual([]);
    });

    it('uses workflowOverride when the session snapshot is stale', () => {
      // Session.metadata.workflow has the stale snapshot; the override has
      // the fresh ref-store contents. Override must win so the handoff stays
      // in sync with the workflow object the caller writes immediately after.
      const staleWorkflow: WorkflowState = {
        decisions: [{ id: 'old', timestamp: 'old', summary: 'Stale', rationale: 'stale' }],
        blockers: [{ id: 'old-b', createdAt: 'old', description: 'Stale blocker', status: 'open' }],
      };
      const session = createSession([createMessage('user', 'hi', 0)], staleWorkflow);

      const handoff = buildLocalHandoff(session, {
        decisions: [{ id: 'new', timestamp: 'new', summary: 'Fresh', rationale: 'fresh' }],
        blockers: [
          { id: 'new-b', createdAt: 'new', description: 'Fresh blocker', status: 'open' },
          { id: 'new-b2', createdAt: 'new', description: 'Already done', status: 'resolved' },
        ],
      });

      expect(handoff.keyFindings).toEqual(['Fresh (rationale: fresh)']);
      expect(handoff.pendingDecisions).toEqual([]);
      expect(handoff.blockers).toEqual(['Fresh blocker']);
      expect(handoff.keyFindings).not.toContain('Stale (rationale: stale)');
      expect(handoff.blockers).not.toContain('Stale blocker');
    });

    it('enriches from decisions, open todos, and open blockers, dropping done/cancelled', () => {
      const workflow: WorkflowState = {
        decisions: [
          { id: 'd1', timestamp: '2026-01-01T00:00:00.000Z', summary: 'Use Postgres', rationale: 'JSONB support' },
          { id: 'd2', timestamp: '2026-01-02T00:00:00.000Z', summary: 'Adopt Vitest', rationale: 'Faster' },
        ],
        blockers: [
          { id: 'b1', createdAt: 'now', description: 'Missing API key', status: 'open' },
          { id: 'b2', createdAt: 'now', description: 'Already fixed', status: 'resolved' },
        ],
      };
      const session = createSession([createMessage('user', 'hi', 0)], workflow);
      const todos: TodoItem[] = [
        { description: 'Write migration', status: 'in_progress' },
        { description: 'Add tests', status: 'pending' },
        { description: 'Ship it', status: 'completed' },
        { description: 'Old idea', status: 'cancelled' },
      ];

      const handoff = buildLocalHandoff(session, {
        decisions: workflow.decisions,
        blockers: workflow.blockers,
        todos,
      });

      expect(handoff.keyFindings).toEqual([
        'Use Postgres (rationale: JSONB support)',
        'Adopt Vitest (rationale: Faster)',
      ]);
      expect(handoff.nextSteps).toEqual(['Write migration', 'Add tests', 'Resolve blocker: Missing API key']);
      expect(handoff.pendingDecisions).toEqual([]);
      expect(handoff.blockers).toEqual(['Missing API key']);

      expect(handoff.summary).toContain('Test Session');
      expect(handoff.summary).toContain('model claude-sonnet');
      expect(handoff.summary).toContain('2 decisions');
      expect(handoff.summary).toContain('1 open blockers');
      expect(handoff.summary).toContain('2 open todos');
      expect(handoff.summary).toContain('Current task: Write migration');
      expect(handoff.summary).toContain('Latest decision: Adopt Vitest');
    });
  });

  describe('renderLocalHandoffMarkdown', () => {
    it('includes session metadata, decisions, and open blockers', () => {
      const workflow: WorkflowState = {
        decisions: [
          {
            id: 'd1',
            timestamp: '2026-01-01T00:00:00.000Z',
            summary: 'Use Postgres',
            rationale: 'JSONB',
            alternatives: ['MySQL'],
          },
        ],
        blockers: [{ id: 'b1', createdAt: '2026-01-01T00:00:00.000Z', description: 'Missing key', status: 'open' }],
      };
      const session = createSession(
        [createMessage('user', 'hello', 0), createMessage('assistant', 'hi back', 1)],
        workflow
      );

      const md = renderLocalHandoffMarkdown(session, '/tmp/session.json');

      expect(md).toContain('# Session handoff: Test Session');
      expect(md).toContain('## Session metadata');
      expect(md).toContain('test-session-id');
      expect(md).toContain('/tmp/session.json');
      expect(md).toContain('Use Postgres');
      expect(md).toContain('Rationale:** JSONB');
      expect(md).toContain('Alternatives considered:** MySQL');
      expect(md).toContain('Missing key');
      expect(md).toContain('hello');
      expect(md).toContain('hi back');
      // totalCost surfaced in session metadata so reviewers can see budget burn.
      expect(md).toContain('Total cost:** $0.0100');
    });

    it('renders a Synthesized handoff section when one is on the session', () => {
      const handoff: SessionHandoff = {
        summary: 'Implemented user auth.',
        keyFindings: ['Token refresh was missing'],
        nextSteps: ['Add regression test'],
        pendingDecisions: ['Whether to require MFA'],
        blockers: [],
        generatedAt: '2026-05-04T00:00:00.000Z',
      };
      const session: Session = {
        ...createSession([createMessage('user', 'hi', 0)]),
        metadata: {
          totalTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
          workflow: { decisions: [], blockers: [], handoff },
        },
      };

      const md = renderLocalHandoffMarkdown(session);

      expect(md).toContain('## Synthesized handoff');
      expect(md).toContain('Implemented user auth.');
      expect(md).toContain('Key findings:');
      expect(md).toContain('Token refresh was missing');
      expect(md).toContain('Next steps:');
      expect(md).toContain('Pending decisions:');
      expect(md).toContain('Whether to require MFA');
      // Empty section should be omitted.
      expect(md).not.toMatch(/\*\*Blockers:\*\*\n\n-/);
      expect(md).toContain('Generated at 2026-05-04T00:00:00.000Z');
    });

    it('omits the Synthesized handoff section when no handoff is stored', () => {
      const session = createSession([createMessage('user', 'hi', 0)]);

      const md = renderLocalHandoffMarkdown(session);

      expect(md).not.toContain('## Synthesized handoff');
    });

    it('caps the conversation tail to the most recent messages', () => {
      const total = LOCAL_HANDOFF_MESSAGE_TAIL + 10;
      const messages = Array.from({ length: total }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `MSG_${i}`, i)
      );
      const session = createSession(messages);

      const md = renderLocalHandoffMarkdown(session);

      expect(md).toContain(`MSG_${total - 1}`);
      expect(md).toContain(`MSG_${total - LOCAL_HANDOFF_MESSAGE_TAIL}`);
      expect(md).not.toContain(`MSG_0\n`);
    });

    it('filters out prior injected handoff messages from the tail', () => {
      const messages: Message[] = [
        {
          id: 'prev',
          role: 'user',
          content: buildHandoffSystemMessage(createHandoff({ summary: 'OLD HANDOFF SUMMARY' })),
          timestamp: 'old',
        },
        createMessage('user', 'real message', 1),
      ];
      const session = createSession(messages);

      const md = renderLocalHandoffMarkdown(session);

      expect(md).not.toContain('OLD HANDOFF SUMMARY');
      expect(md).toContain('real message');
    });
  });

  describe('writeLocalHandoffFile', () => {
    it('creates the directory and writes a Markdown file', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'b4m-handoff-'));
      try {
        const session = createSession([createMessage('user', 'hello', 0), createMessage('assistant', 'hi', 1)]);

        const filePath = await writeLocalHandoffFile(session, {
          dir,
          sessionJsonPath: '/tmp/x.json',
          now: new Date('2026-06-09T12:00:00.000Z'),
        });

        expect(filePath.startsWith(dir)).toBe(true);
        expect(filePath.endsWith('.md')).toBe(true);
        expect(path.basename(filePath)).toContain(session.id);

        const content = await fs.readFile(filePath, 'utf-8');
        expect(content).toContain('# Session handoff');
        expect(content).toContain('/tmp/x.json');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('isLlmUnavailableError', () => {
    it('detects rate-limit errors', () => {
      expect(isLlmUnavailableError(new Error('Rate limit exceeded. Try again in 60s.'))).toBe(true);
    });

    it('detects auth-failure errors', () => {
      expect(isLlmUnavailableError(new Error('Authentication expired, please re-login'))).toBe(true);
      expect(isLlmUnavailableError(new Error('Authentication failed'))).toBe(true);
    });

    it('detects network errors', () => {
      expect(isLlmUnavailableError(new Error('Cannot connect to Bike4Mind server.'))).toBe(true);
      expect(isLlmUnavailableError(new Error('connect ECONNREFUSED 127.0.0.1:3001'))).toBe(true);
      expect(isLlmUnavailableError(new Error('Request timed out: ETIMEDOUT'))).toBe(true);
    });

    it('detects upstream 5xx errors in the ServerLlmBackend wrapper form', () => {
      // This is the actual format thrown by packages/cli/src/llm/ServerLlmBackend.ts
      // when the server returns a 5xx response.
      expect(isLlmUnavailableError(new Error('Request failed with status 502: Bad Gateway'))).toBe(true);
      expect(isLlmUnavailableError(new Error('Request failed with status 503: Service Unavailable'))).toBe(true);
      expect(isLlmUnavailableError(new Error('Request failed with status 504: Gateway Timeout'))).toBe(true);
      // Bare "5NN ..." form is also caught for callers that throw raw status strings.
      expect(isLlmUnavailableError(new Error('502 Bad Gateway'))).toBe(true);
    });

    it('does not classify 4xx errors as unavailable', () => {
      // 4xx is a client-side problem the user can act on; don't silently swallow
      // it with a local fallback.
      expect(isLlmUnavailableError(new Error('Request failed with status 400: Bad Request'))).toBe(false);
      expect(isLlmUnavailableError(new Error('Request failed with status 404: Not Found'))).toBe(false);
    });

    it('does not flag parse errors or other unrelated failures', () => {
      expect(isLlmUnavailableError(new Error('Unexpected token in JSON'))).toBe(false);
      expect(isLlmUnavailableError(new Error('400 Bad Request'))).toBe(false);
      expect(isLlmUnavailableError('string error')).toBe(false);
      expect(isLlmUnavailableError(null)).toBe(false);
    });
  });

  describe('buildHandoffPrompt with prior injected handoff', () => {
    it('filters out the injected handoff from the conversation excerpt', () => {
      const messages: Message[] = [
        {
          id: 'prev',
          role: 'user',
          content: buildHandoffSystemMessage(createHandoff({ summary: 'OLD HANDOFF SUMMARY' })),
          timestamp: 'old',
        },
        createMessage('user', 'real message 1', 1),
        createMessage('assistant', 'real response 1', 2),
        createMessage('user', 'real message 2', 3),
        createMessage('assistant', 'real response 2', 4),
      ];
      const session: Session = {
        id: 'sid',
        name: 'n',
        createdAt: 'c',
        updatedAt: 'u',
        model: 'm',
        messages,
        metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0 },
      };

      const prompt = buildHandoffPrompt(session);

      expect(prompt).not.toContain('OLD HANDOFF SUMMARY');
      expect(prompt).toContain('real message 1');
    });
  });
});
