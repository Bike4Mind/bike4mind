import type { QaRunStatus } from '@bike4mind/common';

/** Spec "Slack alarm" table. Pure: evaluateAlarm.ts gathers the inputs and posts. */
export interface AlarmInput {
  key: { suite: string; env: string; tenant?: string };
  /** Link to /status/runs/<id>. */
  runUrl: string;
  /** Latest earlier CI run on main for the same state key; null for the first. */
  previous: { status: QaRunStatus; failing: string[] } | null;
  current: { status: QaRunStatus; failing: { testKey: string; title: string }[]; ran: number; notStarted: number };
  /** Consecutive non-passing runs immediately before this one. */
  priorNonPassing: number;
  knownFlaky: ReadonlySet<string>;
}

export const ALARM_LIST_MAX = 5;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Slack mrkdwn control characters: a title or slug must not open a link or an entity. */
const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Must match stateLabel in app/components/QaStatus/format.ts. */
const label = (k: AlarmInput['key']) => escapeSlack(`${k.suite} . ${k.env}${k.tenant ? ` (${k.tenant})` : ''}`);

function names(tests: AlarmInput['current']['failing'], knownFlaky: ReadonlySet<string>): string {
  const shown = tests
    .slice(0, ALARM_LIST_MAX)
    .map(t => escapeSlack(knownFlaky.has(t.testKey) ? `${t.title} (known flaky)` : t.title));
  if (tests.length > ALARM_LIST_MAX) shown.push(`+${tests.length - ALARM_LIST_MAX} more`);
  return shown.join(', ');
}

/** Slack text for a state change, or null when the run changes nothing. A missing previous run counts as passed. */
export function decideAlarm(input: AlarmInput): string | null {
  const prev = input.previous?.status ?? 'passed';
  const { current } = input;
  let body: string | null = null;

  if (current.status === 'infra-error') {
    if (prev !== 'infra-error') body = `env down: ${current.ran} of ${current.ran + current.notStarted} ran`;
  } else if (current.status === 'passed') {
    if (prev !== 'passed') body = `recovered after ${plural(input.priorNonPassing, 'run')}`;
  } else if (prev === 'passed' || prev === 'infra-error') {
    // infra-error -> failed: the env came back and tests now fail, which is news like passed -> failed.
    body = `failing: ${plural(current.failing.length, 'test')} (${names(current.failing, input.knownFlaky)})`;
  } else {
    const before = new Set(input.previous?.failing ?? []);
    const added = current.failing.filter(t => !before.has(t.testKey));
    if (added.length > 0) body = `now also failing: ${names(added, input.knownFlaky)}`;
  }

  return body ? `${label(input.key)} ${body} <${input.runUrl}|view run>` : null;
}
