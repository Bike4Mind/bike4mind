import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { EnvironmentPicker } from './EnvironmentPicker';

// URL validation lives in utils/apiUrl.ts (parseApiUrl) and is unit-tested
// there. These tests cover the picker's rendering + option-selection wiring.
// The custom-URL navigation path (arrow-down -> Enter -> type -> submit) is
// left to typecheck: driving ink-select-input navigation deterministically in
// ink-testing-library requires render-cycle waits that make the test flaky.
describe('EnvironmentPicker', () => {
  it('offers local dev and custom, and omits hosted for an unbranded build', () => {
    const { lastFrame } = render(<EnvironmentPicker onSelect={() => {}} />);
    const frame = lastFrame();
    expect(frame).toContain('Local dev server');
    expect(frame).toContain('Custom / self-hosted URL');
    expect(frame).not.toContain('Hosted service');
  });

  it('offers the hosted service when a baked default is present', () => {
    const { lastFrame } = render(<EnvironmentPicker bakedDefaultUrl="https://app.bike4mind.com" onSelect={() => {}} />);
    const frame = lastFrame();
    expect(frame).toContain('Hosted service (https://app.bike4mind.com)');
  });

  it('selects the highlighted option on Enter', () => {
    const onSelect = vi.fn();
    // Unbranded build: first (highlighted) option is the local dev server.
    const { stdin } = render(<EnvironmentPicker onSelect={onSelect} />);
    stdin.write('\r');
    expect(onSelect).toHaveBeenCalledWith({ target: 'dev' });
  });
});
