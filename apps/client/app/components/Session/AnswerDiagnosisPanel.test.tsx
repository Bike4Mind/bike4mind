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

  it('flags the corpus itself when the documents in scope carry no index', () => {
    renderPanel({ ...healthy, retrieval: { ...healthy.retrieval!, outcome: 'not_indexed', injected: undefined } });

    expect(screen.getByTestId('answer-diagnosis-check-corpus').getAttribute('data-status')).toBe('fail');
    expect(screen.getByTestId('answer-diagnosis-remedy-corpus')).toBeTruthy();
  });
});
