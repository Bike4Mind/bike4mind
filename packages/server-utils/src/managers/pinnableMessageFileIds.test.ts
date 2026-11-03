import { describe, it, expect } from 'vitest';
import { pinnableMessageFileIds } from './pinnableMessageFileIds';

describe('pinnableMessageFileIds', () => {
  it('only narrows the message files: an id outside the message is ignored, never added', () => {
    expect(pinnableMessageFileIds(['a', 'B'], ['b', 'outside'])).toEqual(['a']);
    expect(pinnableMessageFileIds(undefined, ['outside'])).toEqual([]);
  });
});
