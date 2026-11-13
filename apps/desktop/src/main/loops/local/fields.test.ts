import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkedFields } from './fields';
import { testLoop } from './testLoop';

const checkout = () => {
  const directory = mkdtempSync(join(tmpdir(), 'b4m-fields-'));
  mkdirSync(join(directory, '.git'));
  return directory;
};

describe('checkedFields', () => {
  it('refuses a folder the owner did not choose in the picker, even a git checkout', () => {
    expect(() => checkedFields({ directory: checkout() }, undefined, new Set())).toThrow(
      'Choose the folder with Choose folder.'
    );
  });

  it('takes a picked git checkout', () => {
    const directory = checkout();
    expect(checkedFields({ directory }, undefined, new Set([directory]))).toEqual({ directory });
  });

  it('still refuses a picked folder that is not a git checkout', () => {
    const directory = mkdtempSync(join(tmpdir(), 'b4m-fields-'));
    expect(() => checkedFields({ directory }, undefined, new Set([directory]))).toThrow('Pick a local git checkout.');
  });

  it('lets an edit resend the folder the loop already has', () => {
    const directory = checkout();
    const current = testLoop({ directory });
    expect(checkedFields({ directory, name: 'Renamed' }, current, new Set())).toMatchObject({ name: 'Renamed' });
  });
});
