import type { ReactNode } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { FabFileSourceType, type IFabFileDocument } from '@bike4mind/common';
import AdmittedSourceDetails, { describeProcessingState } from './AdmittedSourceDetails';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const admitted = (overrides: Partial<IFabFileDocument> = {}): IFabFileDocument =>
  ({
    id: 'f1',
    fileName: 'How tides work.txt',
    sourceType: FabFileSourceType.PROPOSAL_APPROVAL,
    sourceMetadata: {
      sourceUrl: 'https://oceanweekly.example/tides',
      runId: 'run-7',
      query: 'tidal forces',
      approvedByUserId: 'user-3',
      approvedByName: 'Pat Reviewer',
      approvedAt: '2026-09-24T10:00:00.000Z',
    },
    ...overrides,
  }) as IFabFileDocument;

const renderDetails = (file: IFabFileDocument) =>
  render(
    <TestWrapper>
      <AdmittedSourceDetails file={file} />
    </TestWrapper>
  );

describe('AdmittedSourceDetails', () => {
  it('shows the source link, run, approver and processing state of an admitted file', () => {
    renderDetails(admitted({ chunkCount: 12, chunkEmbeddingModelStampedAt: new Date() }));

    const link = screen.getByRole('link', { name: 'https://oceanweekly.example/tides' });
    expect(link.getAttribute('href')).toBe('https://oceanweekly.example/tides');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByTestId('datalake-admitted-source-run').textContent).toContain('"tidal forces" (run run-7)');
    expect(screen.getByTestId('datalake-admitted-source-approver').textContent).toContain('Pat Reviewer on');
    expect(screen.getByTestId('datalake-admitted-source-processing').textContent).toContain('Searchable (12 passages)');
  });

  it('falls back to the approver id when no name was stamped', () => {
    renderDetails(admitted({ sourceMetadata: { approvedByUserId: 'user-3' } }));

    expect(screen.getByTestId('datalake-admitted-source-approver').textContent).toContain('user-3');
  });

  it('never links a source URL that is not http(s)', () => {
    renderDetails(admitted({ sourceMetadata: { sourceUrl: 'javascript:alert(1)' } }));

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('datalake-admitted-source-url').textContent).toContain('javascript:alert(1)');
  });

  it('renders nothing for a file that did not come through proposal approval', () => {
    renderDetails(admitted({ sourceType: FabFileSourceType.SLACK }));

    expect(screen.queryByTestId('datalake-admitted-source')).toBeNull();
  });
});

describe('describeProcessingState', () => {
  it('walks the pipeline stages in order of precedence', () => {
    expect(describeProcessingState({})).toBe('Queued for processing');
    expect(describeProcessingState({ isChunking: true })).toBe('Splitting into passages');
    expect(describeProcessingState({ chunkCount: 4, vectorizedChunkCount: 1 })).toBe('Embedding passages (1 of 4)');
    expect(describeProcessingState({ chunkCount: 1, chunkEmbeddingModelStampedAt: new Date() })).toBe(
      'Searchable (1 passage)'
    );
    expect(describeProcessingState({ chunkCount: 4, error: 'boom' })).toBe('Processing failed');
    expect(describeProcessingState({ noExtractableTextAt: new Date() })).toBe('Stopped - see the notice above');
  });
});
