import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { EnvironmentPicker, validateApiUrlInput } from './EnvironmentPicker';

describe('validateApiUrlInput', () => {
  it('accepts an http(s) URL and strips trailing slashes', () => {
    expect(validateApiUrlInput('https://app.example.com/')).toEqual({ url: 'https://app.example.com' });
    expect(validateApiUrlInput('  http://localhost:3000  ')).toEqual({ url: 'http://localhost:3000' });
  });

  it('rejects an empty input', () => {
    expect(validateApiUrlInput('   ')).toEqual({ error: 'Please enter a URL.' });
  });

  it('rejects a malformed URL', () => {
    const result = validateApiUrlInput('not a url');
    expect(result).toHaveProperty('error');
  });

  it('rejects a non-http(s) protocol', () => {
    const result = validateApiUrlInput('ftp://example.com');
    expect(result).toHaveProperty('error');
    expect('error' in result && result.error).toMatch(/http/);
  });
});

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
