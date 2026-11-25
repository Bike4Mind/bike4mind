// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMAGE_GEN_MODEL_ACTION_ID } from '@bike4mind/slack';
import { SLACK_INTERACTIVE_RESERVED_ACTIONS } from '@bike4mind/server-utils/integrations/slack/interactiveReservedActions';

// A URL off import.meta.url, not a __dirname join: files under pages/ compile as routes, and the
// build's file tracer copies a __dirname-relative read into the standalone output as raw source.
const SOURCE = readFileSync(new URL('../interactive.ts', import.meta.url), 'utf8');

/** The dispatcher body, so the scan ignores `case` labels and ids elsewhere in the file. */
function dispatcherBody(): string {
  const start = SOURCE.indexOf('async function handleInteractiveAction(');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

function literals(body: string, pattern: RegExp): string[] {
  return [...body.matchAll(pattern)].map(match => match[1]);
}

const { ids: reservedIds, prefixes: reservedPrefixes } = SLACK_INTERACTIVE_RESERVED_ACTIONS;
const reservedIdList: readonly string[] = reservedIds;
const reservedPrefixList: readonly string[] = reservedPrefixes;

const isReservedId = (id: string) => reservedIdList.includes(id) || reservedPrefixList.some(p => id.startsWith(p));
const isReservedPrefix = (prefix: string) => reservedPrefixList.some(p => prefix.startsWith(p));

describe('interactive endpoint reserved actions', () => {
  const body = dispatcherBody();
  const caseIds = literals(body, /\bcase '([^']+)':/g);
  const equalityIds = literals(body, /\baction_id === '([^']+)'/g);
  const startsWithPrefixes = literals(body, /\baction_id\.startsWith\('([^']+)'\)/g);

  it('finds the literals it is meant to guard', () => {
    expect(caseIds).toContain('confirm_action');
    expect(equalityIds).toContain('app_home_help');
    expect(startsWithPrefixes).toContain('channel_config_edit_');
  });

  it.each([
    ['case labels', caseIds],
    ['action_id comparisons', equalityIds],
  ])('reserves every id used in %s', (_label, ids) => {
    expect(ids.filter(id => !isReservedId(id))).toEqual([]);
  });

  it('reserves every action_id.startsWith literal', () => {
    expect(startsWithPrefixes.filter(prefix => !isReservedPrefix(prefix))).toEqual([]);
  });

  it('reserves the image model prefix, which the endpoint reads from a constant', () => {
    expect(body).toContain('action_id.startsWith(IMAGE_GEN_MODEL_ACTION_ID)');
    expect(reservedPrefixList).toContain(IMAGE_GEN_MODEL_ACTION_ID);
  });

  it('does not reserve ids the endpoint no longer uses', () => {
    const used = new Set([...caseIds, ...equalityIds]);
    const usedPrefixes = new Set([...startsWithPrefixes, IMAGE_GEN_MODEL_ACTION_ID]);

    expect(reservedIdList.filter(id => !used.has(id))).toEqual([]);
    expect(reservedPrefixList.filter(prefix => !usedPrefixes.has(prefix))).toEqual([]);
  });

  it('no longer carries the approval branches the registry now serves', () => {
    expect(SOURCE).not.toContain('__sreDeferred');
    expect(body).not.toMatch(/'sre_[a-z_]+'/);
  });
});
