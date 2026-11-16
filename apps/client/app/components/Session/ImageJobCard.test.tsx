// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ChatImageJob } from '@client/app/hooks/data/imageJobs';

const h = vi.hoisted(() => ({
  query: {} as { data?: ChatImageJob; isPending: boolean },
  file: { data: undefined as { fileUrl?: string } | undefined },
  fileId: null as string | null,
}));

vi.mock('@client/app/hooks/data/imageJobs', () => ({ useImageJob: () => h.query }));
vi.mock('@client/app/hooks/data/fabFileQueries', () => ({
  useGetFabFile: (id: string | null) => {
    h.fileId = id;
    return h.file;
  },
}));

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
const show = (data: ChatImageJob | undefined, isPending = false) => {
  h.query = { data, isPending };
  render(
    <CssVarsProvider theme={appTheme}>
      <ImageJobCard jobId="img-1" />
    </CssVarsProvider>
  );
};

beforeEach(() => {
  h.file = { data: undefined };
  h.fileId = null;
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

  it('keeps showing progress when succeeded but the output has not arrived', () => {
    show(job({ state: 'succeeded' }));
    expect(screen.getByTestId('image-job-card-progress').textContent).toContain('Finishing');
  });

  it('renders the signed url with the prompt as alt text', () => {
    show(job({ state: 'succeeded', output: output() }));
    const image = screen.getByTestId('image-job-card-image');
    expect(image.getAttribute('src')).toBe('https://signed.example/img.png');
    expect(image.getAttribute('alt')).toBe('a red fox');
    expect(h.fileId).toBeNull();
  });

  it('falls back to the file record when the url is missing', () => {
    h.file = { data: { fileUrl: 'https://files.example/fox.png' } };
    show(job({ state: 'succeeded', output: output({ url: null }) }));
    expect(h.fileId).toBe('file-1');
    expect(screen.getByTestId('image-job-card-image').getAttribute('src')).toBe('https://files.example/fox.png');
  });

  it('shows a spinner while the file fallback resolves', () => {
    show(job({ state: 'succeeded', output: output({ url: null }) }));
    expect(screen.getByTestId('image-job-card-image-loading')).toBeTruthy();
  });

  it('notes an image that is no longer available', () => {
    show(job({ state: 'succeeded', output: output({ availability: 'unavailable', url: null }) }));
    expect(screen.getByTestId('image-job-card-unavailable-note')).toBeTruthy();
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
