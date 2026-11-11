// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editableFieldsFor, literalFieldsOf, renderEditableFields } from '../editableFields';

describe('literalFieldsOf', () => {
  it('keeps plain literals and drops templates, references and spread objects', () => {
    const source = `
      const N = 3;
      export const STEPS = [
        { id: 'a', title: 'Plain', body: \`No substitution\`, prompt: \`Make it \${N}\` },
        { id: 'b', title: TITLE, body: 'x' + 'y', doneBody: 'Done.' },
        { ...base, id: 'c', title: 'Overridable by the spread' },
      ];`;
    expect(literalFieldsOf(source)).toEqual({ a: ['title', 'body'], b: ['doneBody'] });
  });
});

describe('editableFieldsFor', () => {
  it('reads each module steps file and keeps only the listed steps with literal fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'fields-'));
    writeFileSync(join(root, 'steps.ts'), `export const S = [{ id: 'a', title: 'T' }, { id: 'b', title: X }];`);
    const modules = [{ id: 'm', stepIds: ['a', 'b'], stepsFile: 'steps.ts' }];
    expect(editableFieldsFor(root, modules)).toEqual({ m: { a: ['title'] } });
    expect(renderEditableFields(root, modules)).toBe(`${JSON.stringify({ m: { a: ['title'] } }, null, 2)}\n`);
  });
});
