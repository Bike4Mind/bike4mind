import { describe, expect, it } from 'vitest';
import {
  SYNC_SUCCESS_ENDPOINTS,
  classifyAgentExecutionOutcome,
  classifyQuestOutcome,
  classifyRequestOutcome,
  emptyOutcomeCounts,
  failureRate,
  statusClassOf,
} from './outcomes';

describe('statusClassOf', () => {
  it.each([
    [0, 'other'],
    [199, 'other'],
    [200, '2xx'],
    [201, '2xx'],
    [202, 'accepted'],
    [204, '2xx'],
    [299, '2xx'],
    [300, 'other'],
    [301, 'other'],
    [429, 'other'],
    [500, '5xx'],
    [503, '5xx'],
    [600, 'other'],
  ] as const)('%i is %s', (code, expected) => {
    expect(statusClassOf(code)).toBe(expected);
  });
});

describe('classifyRequestOutcome', () => {
  it('trusts the completion observation over the status code', () => {
    expect(
      classifyRequestOutcome({ endpoint: '/api/ai/v1/completions', statusClass: '2xx', completionOutcome: 'failed' })
    ).toBe('failed');
    expect(
      classifyRequestOutcome({
        endpoint: '/api/ai/v1/completions',
        statusClass: '2xx',
        completionOutcome: 'interrupted',
      })
    ).toBe('interrupted');
    expect(
      classifyRequestOutcome({ endpoint: '/api/ai/v1/completions', statusClass: '2xx', completionOutcome: 'completed' })
    ).toBe('completed');
  });

  it('counts a 5xx as a failure whatever the route', () => {
    expect(classifyRequestOutcome({ endpoint: '/api/chat', statusClass: '5xx' })).toBe('failed');
    expect(
      classifyRequestOutcome({ endpoint: '/api/ai/v1/completions', statusClass: '5xx', completionOutcome: 'rejected' })
    ).toBe('failed');
  });

  it('never counts a queued chat 2xx as a success', () => {
    expect(classifyRequestOutcome({ endpoint: '/api/chat', statusClass: '2xx' })).toBeNull();
  });

  it('counts a 2xx on an allowlisted synchronous route as a success', () => {
    for (const endpoint of SYNC_SUCCESS_ENDPOINTS) {
      expect(classifyRequestOutcome({ endpoint, statusClass: '2xx' })).toBe('completed');
    }
  });

  it('counts a 2xx on each synchronous generation route as completed and a 5xx as failed', () => {
    for (const endpoint of ['/api/ai/music', '/api/ai/tts', '/api/ai/sound-effects']) {
      expect(SYNC_SUCCESS_ENDPOINTS).toContain(endpoint);
      expect(classifyRequestOutcome({ endpoint, statusClass: '2xx' })).toBe('completed');
      expect(classifyRequestOutcome({ endpoint, statusClass: '5xx' })).toBe('failed');
    }
  });

  it.each(['/api/ai/tts', '/api/ai/sound-effects'])(
    'counts inline results but leaves accepted jobs pending for %s',
    endpoint => {
      expect(classifyRequestOutcome({ endpoint, statusClass: statusClassOf(200) })).toBe('completed');
      expect(classifyRequestOutcome({ endpoint, statusClass: statusClassOf(202) })).toBeNull();
      expect(classifyRequestOutcome({ endpoint, statusClass: statusClassOf(502) })).toBe('failed');
    }
  );

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'preserves an explicit %s completion observation on an accepted response',
    completionOutcome => {
      expect(
        classifyRequestOutcome({
          endpoint: '/api/ai/v1/completions',
          statusClass: statusClassOf(202),
          completionOutcome,
        })
      ).toBe(completionOutcome);
    }
  );

  it('leaves rejected, cap-stopped, in-flight and client-error requests uncounted', () => {
    const endpoint = '/api/ai/v1/completions';
    expect(classifyRequestOutcome({ endpoint, statusClass: 'other', completionOutcome: 'rejected' })).toBeNull();
    expect(
      classifyRequestOutcome({ endpoint, statusClass: 'other', completionOutcome: 'daily_cap_rejected' })
    ).toBeNull();
    expect(classifyRequestOutcome({ endpoint, statusClass: 'other', completionOutcome: 'unknown' })).toBeNull();
    expect(classifyRequestOutcome({ endpoint: '/api/tools/weather', statusClass: 'other' })).toBeNull();
  });

  it('keeps /api/chat off the allowlist', () => {
    expect(SYNC_SUCCESS_ENDPOINTS).not.toContain('/api/chat');
  });
});

describe('classifyQuestOutcome', () => {
  it('counts a done, clean turn as completed', () => {
    expect(classifyQuestOutcome({ status: 'done', type: 'message' })).toBe('completed');
  });

  it('counts a classified error as failed even when the status is done', () => {
    expect(classifyQuestOutcome({ status: 'done', type: 'error' })).toBe('failed');
    expect(classifyQuestOutcome({ status: 'stopped', type: 'error' })).toBe('failed');
    expect(classifyQuestOutcome({ status: 'done', type: 'message', errorCode: 'insufficient_credits' })).toBe('failed');
  });

  it('counts a recovered dead run as failed', () => {
    expect(classifyQuestOutcome({ status: 'done', type: 'message', finishReason: 'timeout' })).toBe('failed');
    expect(classifyQuestOutcome({ status: 'done', type: 'message', finishReason: 'abandoned' })).toBe('failed');
  });

  it('leaves running and user-stopped turns uncounted', () => {
    expect(classifyQuestOutcome({ status: 'running', type: 'message' })).toBeNull();
    expect(classifyQuestOutcome({ status: 'stopped', type: 'message' })).toBeNull();
    expect(classifyQuestOutcome({})).toBeNull();
  });
});

describe('classifyAgentExecutionOutcome', () => {
  it('maps terminal statuses only', () => {
    expect(classifyAgentExecutionOutcome('completed')).toBe('completed');
    expect(classifyAgentExecutionOutcome('failed')).toBe('failed');
    for (const status of ['pending', 'running', 'continuing', 'paused', 'awaiting_permission', 'aborted', undefined]) {
      expect(classifyAgentExecutionOutcome(status)).toBeNull();
    }
  });
});

describe('failureRate', () => {
  it('is null with no terminal outcomes', () => {
    expect(failureRate(emptyOutcomeCounts())).toBeNull();
  });

  it('counts failed and interrupted over all terminal outcomes', () => {
    expect(failureRate({ completed: 6, failed: 3, interrupted: 1 })).toBeCloseTo(0.4);
  });
});
