// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EDITABLE_FIELDS_PATH, renderCoreEditableFields } from './tutorial-editable-fields';

describe('tutorials:fields', () => {
  it('renders exactly the committed editable-fields file', () => {
    expect(renderCoreEditableFields()).toBe(readFileSync(EDITABLE_FIELDS_PATH, 'utf8'));
  });
});
