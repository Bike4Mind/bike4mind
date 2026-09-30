import { describe, it, expect } from 'vitest';
import type { QaRunStatus } from '@bike4mind/common';
import { decideAlarm, type AlarmInput } from './alarm';

const URL = 'https://app.example.com/status/runs/r1';
const t = (title: string) => ({ testKey: `notebook.spec.ts > ${title}`, title });

const input = (o: {
  prev?: QaRunStatus | null;
  prevFailing?: string[];
  cur: QaRunStatus;
  failing?: { testKey: string; title: string }[];
  ran?: number;
  notStarted?: number;
  priorNonPassing?: number;
  knownFlaky?: string[];
  tenant?: string;
}): AlarmInput => ({
  key: { suite: 'Core', env: 'staging', ...(o.tenant ? { tenant: o.tenant } : {}) },
  runUrl: URL,
  previous: o.prev === null ? null : { status: o.prev ?? 'passed', failing: o.prevFailing ?? [] },
  current: { status: o.cur, failing: o.failing ?? [], ran: o.ran ?? 90, notStarted: o.notStarted ?? 0 },
  priorNonPassing: o.priorNonPassing ?? 0,
  knownFlaky: new Set(o.knownFlaky ?? []),
});

describe('decideAlarm: every table row', () => {
  it('passed -> failed posts the failing set', () => {
    expect(decideAlarm(input({ prev: 'passed', cur: 'failed', failing: [t('saves'), t('creates')] }))).toBe(
      `Core . staging failing: 2 tests (saves, creates) <${URL}|view run>`
    );
  });
  it('failed -> failed with a new test posts only the new one', () => {
    expect(
      decideAlarm(
        input({ prev: 'failed', prevFailing: [t('saves').testKey], cur: 'failed', failing: [t('saves'), t('creates')] })
      )
    ).toBe(`Core . staging now also failing: creates <${URL}|view run>`);
  });
  it('failed -> failed with the same set is silent', () => {
    expect(
      decideAlarm(input({ prev: 'failed', prevFailing: [t('saves').testKey], cur: 'failed', failing: [t('saves')] }))
    ).toBeNull();
  });
  it('failed -> failed with a smaller set is silent', () => {
    expect(
      decideAlarm(
        input({
          prev: 'failed',
          prevFailing: [t('saves').testKey, t('creates').testKey],
          cur: 'failed',
          failing: [t('saves')],
        })
      )
    ).toBeNull();
  });
  it('failed -> passed posts recovered after N runs', () => {
    expect(decideAlarm(input({ prev: 'failed', cur: 'passed', priorNonPassing: 3 }))).toBe(
      `Core . staging recovered after 3 runs <${URL}|view run>`
    );
  });
  it('infra-error -> passed posts recovered', () => {
    expect(decideAlarm(input({ prev: 'infra-error', cur: 'passed', priorNonPassing: 1 }))).toBe(
      `Core . staging recovered after 1 run <${URL}|view run>`
    );
  });
  it('passed or failed -> infra-error posts env down with counts', () => {
    const expected = `Core . staging env down: 0 of 90 ran <${URL}|view run>`;
    expect(decideAlarm(input({ prev: 'passed', cur: 'infra-error', ran: 0, notStarted: 90 }))).toBe(expected);
    expect(decideAlarm(input({ prev: 'failed', cur: 'infra-error', ran: 0, notStarted: 90 }))).toBe(expected);
  });
  it('infra-error -> infra-error is silent', () => {
    expect(decideAlarm(input({ prev: 'infra-error', cur: 'infra-error', ran: 0, notStarted: 90 }))).toBeNull();
  });
  it('passed -> passed is silent', () => {
    expect(decideAlarm(input({ prev: 'passed', cur: 'passed' }))).toBeNull();
  });
  it('infra-error -> failed posts failing, like passed -> failed', () => {
    expect(decideAlarm(input({ prev: 'infra-error', cur: 'failed', failing: [t('saves')] }))).toBe(
      `Core . staging failing: 1 test (saves) <${URL}|view run>`
    );
  });
});

describe('decideAlarm: first run', () => {
  it('treats a missing previous run as passed: a failure posts', () => {
    expect(decideAlarm(input({ prev: null, cur: 'failed', failing: [t('saves')] }))).toBe(
      `Core . staging failing: 1 test (saves) <${URL}|view run>`
    );
  });
  it('treats a missing previous run as passed: a pass is silent', () => {
    expect(decideAlarm(input({ prev: null, cur: 'passed' }))).toBeNull();
  });
  it('treats a missing previous run as passed: env down posts', () => {
    expect(decideAlarm(input({ prev: null, cur: 'infra-error', ran: 0, notStarted: 90 }))).toMatch(
      /env down: 0 of 90 ran/
    );
  });
});

describe('decideAlarm: details', () => {
  it('tags known flaky tests', () => {
    expect(decideAlarm(input({ cur: 'failed', failing: [t('saves')], knownFlaky: [t('saves').testKey] }))).toBe(
      `Core . staging failing: 1 test (saves (known flaky)) <${URL}|view run>`
    );
  });
  it('tags known flaky tests in the "now also failing" list', () => {
    expect(
      decideAlarm(
        input({
          prev: 'failed',
          prevFailing: [t('saves').testKey],
          cur: 'failed',
          failing: [t('saves'), t('creates')],
          knownFlaky: [t('creates').testKey],
        })
      )
    ).toBe(`Core . staging now also failing: creates (known flaky) <${URL}|view run>`);
  });
  it('caps the list at 5 names', () => {
    const failing = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(t);
    expect(decideAlarm(input({ cur: 'failed', failing }))).toBe(
      `Core . staging failing: 7 tests (a, b, c, d, e, +2 more) <${URL}|view run>`
    );
  });
  it('names the tenant in the label', () => {
    expect(decideAlarm(input({ cur: 'failed', failing: [t('saves')], tenant: 'tenant-a' }))).toMatch(
      /^Core \. staging \(tenant-a\) failing/
    );
  });
  it('escapes Slack control characters in titles', () => {
    expect(decideAlarm(input({ cur: 'failed', failing: [t('Notebook > a <b> & c')] }))).toContain(
      '(Notebook &gt; a &lt;b&gt; &amp; c)'
    );
  });
});
