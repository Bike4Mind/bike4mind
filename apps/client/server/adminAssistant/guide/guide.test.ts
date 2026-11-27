import { describe, expect, it } from 'vitest';
import { getViewById, resolveSettingDefinition, VIEW_REGISTRY } from '@bike4mind/common';
import { ADMIN_GUIDE } from '.';

const MAX_SUMMARY_CHARS = 400;
const MAX_STEP_CHARS = 300;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

const textOf = (entry: (typeof ADMIN_GUIDE)[number]) => [entry.title, entry.summary, ...entry.howTo, ...entry.keywords];

describe('ADMIN_GUIDE', () => {
  it('gives every entry a unique kebab-case id', () => {
    const ids = ADMIN_GUIDE.map(entry => entry.id);
    expect(ids.filter(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))).toEqual([]);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('points only at admin views that exist', () => {
    const unknown = ADMIN_GUIDE.flatMap(entry =>
      entry.views.filter(id => getViewById(id)?.requiresAdmin !== true).map(id => `${entry.id} -> ${id}`)
    );
    expect(unknown).toEqual([]);
  });

  it('names only registered settings', () => {
    const unknown = ADMIN_GUIDE.flatMap(entry =>
      entry.settings.filter(key => !resolveSettingDefinition(key)).map(key => `${entry.id} -> ${key}`)
    );
    expect(unknown).toEqual([]);
  });

  // The drift guard: a new admin tab fails here until the guide explains it. (global.admin is the console itself.)
  it('covers every admin tab view', () => {
    const covered = new Set(ADMIN_GUIDE.flatMap(entry => entry.views));
    const missing = VIEW_REGISTRY.filter(
      view => view.requiresAdmin === true && view.id !== 'global.admin' && !covered.has(view.id)
    ).map(view => view.id);
    expect(missing, `Admin views with no guide entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps every entry short, located and in plain ASCII', () => {
    const problems = ADMIN_GUIDE.flatMap(entry => [
      ...(entry.views.length === 0 ? [`${entry.id}: no views`] : []),
      ...(entry.howTo.length === 0 ? [`${entry.id}: no howTo`] : []),
      ...(entry.summary.length > MAX_SUMMARY_CHARS ? [`${entry.id}: summary too long`] : []),
      ...entry.howTo.filter(step => step.length > MAX_STEP_CHARS).map(() => `${entry.id}: howTo step too long`),
      ...textOf(entry)
        .filter(text => !PRINTABLE_ASCII.test(text))
        .map(text => `${entry.id}: non-ASCII in "${text}"`),
    ]);
    expect(problems).toEqual([]);
  });
});
