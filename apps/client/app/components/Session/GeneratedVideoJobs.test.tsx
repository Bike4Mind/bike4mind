// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { GeneratedVideoJobs } from './GeneratedVideoJobs';

vi.mock('../VideoStudio/VideoJobCard', () => ({
  default: ({ jobId }: { jobId: string }) => <div data-testid="video-job-card-stub">{jobId}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderJobs = (jobIds: readonly string[] | undefined) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <GeneratedVideoJobs jobIds={jobIds} />
    </CssVarsProvider>
  );

describe('GeneratedVideoJobs', () => {
  it('renders one card per job id, in order', () => {
    renderJobs(['a', 'b', 'c']);
    expect(screen.getAllByTestId('video-job-card-stub').map(node => node.textContent)).toEqual(['a', 'b', 'c']);
  });

  it.each([undefined, []])('renders nothing for %j', jobIds => {
    renderJobs(jobIds);
    expect(screen.queryByTestId('generated-video-jobs-list')).toBeNull();
  });
});
