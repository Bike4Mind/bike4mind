// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { GenerationJobRef } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { GeneratedJobs } from './GeneratedJobs';

vi.mock('../VideoStudio/VideoJobCard', () => ({
  default: ({ jobId }: { jobId: string }) => <div data-testid="video-job-card-stub">{jobId}</div>,
}));
vi.mock('./MusicJobCard', () => ({
  default: ({ jobId }: { jobId: string }) => <div data-testid="music-job-card-stub">{jobId}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderJobs = (jobs: readonly GenerationJobRef[] | undefined) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <GeneratedJobs jobs={jobs} />
    </CssVarsProvider>
  );

describe('GeneratedJobs', () => {
  it('renders one card per job, in order, picking the card by kind', () => {
    renderJobs([
      { id: 'a', kind: 'video' },
      { id: 'b', kind: 'music' },
      { id: 'c', kind: 'video' },
    ]);
    const list = screen.getByTestId('generated-jobs-list');
    expect(Array.from(list.children).map(node => `${node.getAttribute('data-testid')}:${node.textContent}`)).toEqual([
      'video-job-card-stub:a',
      'music-job-card-stub:b',
      'video-job-card-stub:c',
    ]);
  });

  it.each([undefined, []])('renders nothing for %j', jobs => {
    renderJobs(jobs);
    expect(screen.queryByTestId('generated-jobs-list')).toBeNull();
  });
});
