import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ReviewGatePrompt } from './ReviewGatePrompt';

describe('ReviewGatePrompt', () => {
  it('escapes control and bidi characters in model-authored text', () => {
    const { lastFrame } = render(
      <ReviewGatePrompt
        description={'drop table\rkeep table'}
        recommendation={'approve‮evil'}
        options={['a\u009b2Kb']}
        onResponse={() => {}}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('drop table\\x0dkeep table');
    expect(frame).toContain('approve\\u202eevil');
    expect(frame).toContain('a\\x9b2Kb');
    expect(frame).not.toContain('\r');
    expect(frame).not.toContain('‮');
  });
});
