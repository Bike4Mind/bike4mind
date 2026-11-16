// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ChatImageJob } from '@client/app/hooks/data/imageJobs';

const h = vi.hoisted(() => ({
  query: {} as { data?: ChatImageJob; isPending: boolean; refetch: () => Promise<unknown> },
}));

vi.mock('@client/app/hooks/data/imageJobs', () => ({ useImageJob: () => h.query }));

import ImageJobCard from './ImageJobCard';

const output = (overrides: Partial<NonNullable<ChatImageJob['output']>> = {}): ChatImageJob['output'] => ({
  availability: 'ready',
  url: 'https://signed.example/img.png',
  expires_at: null,
  content_type: 'image/png',
  file_id: 'file-1',
  ...overrides,
});

const job = (overrides: Partial<ChatImageJob> = {}): ChatImageJob => ({
  id: 'img-1',
  object: 'image_generation',
  state: 'pending',
  model: 'gpt-image-1.5',
  mode: 'generate',
  prompt: 'a red fox',
  group_id: null,
  source: 'chat',
  error: null,
  output: null,
  credits: { reserved: null, settled: null },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const appTheme = extendTheme({ ...getThemeConfig() });
const refetch = vi.fn(async () => undefined);
const ui = (data: ChatImageJob | undefined, isPending = false) => {
  h.query = { data, isPending, refetch };
  return (
    <CssVarsProvider theme={appTheme}>
      <ImageJobCard jobId="img-1" />
    </CssVarsProvider>
  );
};
const show = (data: ChatImageJob | undefined, isPending = false) => render(ui(data, isPending));

beforeEach(() => {
  refetch.mockClear();
});

describe('ImageJobCard', () => {
  it('shows the loading card while the first read is pending', () => {
    show(undefined, true);
    expect(screen.getByTestId('image-job-card-loading')).toBeTruthy();
  });

  it('shows a missing note when the job could not be loaded', () => {
    show(undefined);
    expect(screen.getByTestId('image-job-card-missing')).toBeTruthy();
  });

  it.each([
    ['pending', 'Queued'],
    ['running', 'Generating'],
    ['storing', 'Saving'],
  ] as const)('shows progress and the %s chip', (state, label) => {
    show(job({ state }));
    expect(screen.getByTestId('image-job-card-progress')).toBeTruthy();
    expect(screen.getByTestId('image-job-card-state').textContent).toBe(label);
    expect(screen.queryByTestId('image-job-card-image')).toBeNull();
  });

  it('keeps showing progress, and a Finishing chip, when succeeded but the output has not arrived', () => {
    show(job({ state: 'succeeded' }));
    expect(screen.getByTestId('image-job-card-progress').textContent).toContain('Finishing');
    expect(screen.getByTestId('image-job-card-state').textContent).toBe('Finishing');
  });

  it('shows a Checking chip, not Ready, while the output is pending its scan', () => {
    show(job({ state: 'succeeded', output: output({ availability: 'pending_scan', url: null }) }));
    expect(screen.getByTestId('image-job-card-progress').textContent).toContain('Checking');
    expect(screen.getByTestId('image-job-card-state').textContent).toBe('Checking');
  });

  it('renders the signed url with the prompt as alt text and a Ready chip', () => {
    show(job({ state: 'succeeded', output: output() }));
    const image = screen.getByTestId('image-job-card-image');
    expect(image.getAttribute('src')).toBe('https://signed.example/img.png');
    expect(image.getAttribute('alt')).toBe('a red fox');
    expect(screen.getByTestId('image-job-card-state').textContent).toBe('Ready');
    expect(screen.queryByTestId('image-job-card-download-btn')).toBeNull();
  });

  it('keeps the shown url across a re-sign and takes the new one only after a load error', () => {
    const { rerender } = show(job({ state: 'succeeded', output: output() }));
    rerender(ui(job({ state: 'succeeded', output: output({ url: 'https://signed.example/img.png?v=2' }) })));
    const image = screen.getByTestId('image-job-card-image');
    expect(image.getAttribute('src')).toBe('https://signed.example/img.png');

    fireEvent.error(image);
    expect(screen.getByTestId('image-job-card-image').getAttribute('src')).toBe('https://signed.example/img.png?v=2');
  });

  it('notes an image that is no longer available', () => {
    show(job({ state: 'succeeded', output: output({ availability: 'unavailable', url: null }) }));
    expect(screen.getByTestId('image-job-card-unavailable-note')).toBeTruthy();
    expect(screen.getByTestId('image-job-card-state').textContent).toBe('Unavailable');
  });

  it('shows the public error for a failed job', () => {
    show(job({ state: 'failed', error: { code: 'provider_error', message: 'The provider is busy.' } }));
    expect(screen.getByTestId('image-job-card-error').textContent).toBe('The provider is busy.');
    expect(screen.getByTestId('image-job-card-state').textContent).toBe('Failed');
  });

  it.each([
    ['blocked', 'declined'],
    ['cancelled', 'cancelled'],
  ] as const)('falls back to fixed copy for a %s job without an error', (state, fragment) => {
    show(job({ state }));
    expect(screen.getByTestId('image-job-card-error').textContent).toContain(fragment);
  });
});
