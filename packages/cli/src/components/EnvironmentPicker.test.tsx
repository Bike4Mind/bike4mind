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
  describe('with a baked default', () => {
    const defaultUrl = 'https://app.example.com';

    it('lists the default first, then local dev, then custom', () => {
      const { lastFrame } = render(<EnvironmentPicker onSelect={() => {}} defaultUrl={defaultUrl} />);
      const frame = lastFrame() ?? '';
      const hosted = frame.indexOf('Hosted (app.example.com)');
      const dev = frame.indexOf('Local dev server');
      const custom = frame.indexOf('Custom / self-hosted URL');
      expect(hosted).toBeGreaterThan(-1);
      expect(dev).toBeGreaterThan(hosted);
      expect(custom).toBeGreaterThan(dev);
    });

    it('preselects the default with a single marker', () => {
      const { lastFrame } = render(<EnvironmentPicker onSelect={() => {}} defaultUrl={defaultUrl} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('\u{276F} Hosted (app.example.com)');
      expect(frame).not.toContain('\u{276F} \u{276F}');
    });

    it('selects the build default on Enter', () => {
      const onSelect = vi.fn();
      const { stdin } = render(<EnvironmentPicker onSelect={onSelect} defaultUrl={defaultUrl} />);
      stdin.write('\r');
      expect(onSelect).toHaveBeenCalledWith({ target: 'prod' });
    });
  });

  describe('without a baked default', () => {
    it('offers only local dev and custom', () => {
      const { lastFrame } = render(<EnvironmentPicker onSelect={() => {}} defaultUrl="" />);
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('Hosted');
      expect(frame.indexOf('Local dev server')).toBeLessThan(frame.indexOf('Custom / self-hosted URL'));
    });

    it('selects local dev on Enter', () => {
      const onSelect = vi.fn();
      const { stdin } = render(<EnvironmentPicker onSelect={onSelect} defaultUrl="" />);
      stdin.write('\r');
      expect(onSelect).toHaveBeenCalledWith({ target: 'dev' });
    });
  });
});
