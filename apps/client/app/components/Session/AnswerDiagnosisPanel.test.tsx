import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { HEALTHY_VERDICT_BODY, type PromptMeta } from '@bike4mind/common';
import { AnswerDiagnosisPanel } from './AnswerDiagnosisPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderPanel = (promptMeta: PromptMeta) =>
  render(
    <Wrapper>
      <AnswerDiagnosisPanel promptMeta={promptMeta} />
    </Wrapper>
  );

const healthy: PromptMeta = {
  retrieval: {
    attempted: true,
    outcome: 'ok',
    surfaces: ['lake-memory'],
    dataLakeTags: ['handbook'],
    injected: { chunks: 4, chars: 2000 },
  },
  context: { messageTruncation: { wasTruncated: false, originalMessageCount: 10, truncatedMessageCount: 10 } },
  functionCalls: [{ name: 'search_knowledge_base', success: true }],
};

describe('AnswerDiagnosisPanel', () => {
  it('renders every bucket even on a turn with nothing recorded', () => {
    // The completeness is the feature: a problem-only list reads as "we don't know" when empty.
    renderPanel({});

    for (const id of ['retrieval', 'context', 'tools', 'corpus']) {
      expect(screen.getByTestId(`answer-diagnosis-check-${id}`)).toBeTruthy();
    }
  });

  it('hands back the model-reasoning verdict when everything passed', () => {
    renderPanel(healthy);

    expect(screen.getByTestId('answer-diagnosis-verdict-ok').textContent).toContain(HEALTHY_VERDICT_BODY);
    for (const id of ['retrieval', 'context', 'tools', 'corpus']) {
      expect(screen.getByTestId(`answer-diagnosis-check-${id}`).getAttribute('data-status')).toBe('ok');
    }
  });

  it('marks a recorded starve as a failure and offers its remedy', () => {
    renderPanel({
      ...healthy,
      retrieval: { ...healthy.retrieval!, injected: { chunks: 0, chars: 0 } },
    });

    expect(screen.getByTestId('answer-diagnosis-check-retrieval').getAttribute('data-status')).toBe('fail');
    expect(screen.getByTestId('answer-diagnosis-remedy-retrieval')).toBeTruthy();
  });

  it('keeps an unrecorded volume out of the failure bucket', () => {
    renderPanel({ ...healthy, retrieval: { ...healthy.retrieval!, injected: undefined } });

    expect(screen.getByTestId('answer-diagnosis-check-retrieval').getAttribute('data-status')).toBe('unknown');
  });

  it('does not credit forced retrieval with passages lake memory supplied', () => {
    renderPanel({
      ...healthy,
      retrieval: {
        ...healthy.retrieval!,
        surfaces: ['lake-memory', 'forced-retrieval'],
        injected: { chunks: 6, chars: 1029, preRelativeFloorCandidates: 0, postRelativeFloorCandidates: 0 },
      },
    });

    const retrieval = screen.getByTestId('answer-diagnosis-check-retrieval');
    expect(retrieval.getAttribute('data-status')).toBe('ok');
    expect(retrieval.textContent).toContain('6 passages reached the model.');
    expect(retrieval.textContent).toContain('None came from forced retrieval');
    expect(retrieval.textContent).toContain('Other surfaces that ran this turn: lake memory.');
  });

  it('names a mixed-surface total as a sum rather than a forced-retrieval count', () => {
    renderPanel({
      ...healthy,
      retrieval: {
        ...healthy.retrieval!,
        surfaces: ['lake-memory', 'forced-retrieval'],
        injected: { chunks: 6, chars: 1029, preRelativeFloorCandidates: 4, postRelativeFloorCandidates: 3 },
      },
    });

    const text = screen.getByTestId('answer-diagnosis-check-retrieval').textContent;
    expect(text).toContain('That total sums every surface that ran this turn (lake memory and forced retrieval)');
    expect(text).not.toContain('None came from forced retrieval');
  });

  it('flags the corpus itself when the documents in scope carry no index', () => {
    renderPanel({ ...healthy, retrieval: { ...healthy.retrieval!, outcome: 'not_indexed', injected: undefined } });

    expect(screen.getByTestId('answer-diagnosis-check-corpus').getAttribute('data-status')).toBe('fail');
    expect(screen.getByTestId('answer-diagnosis-remedy-corpus')).toBeTruthy();
  });
});
