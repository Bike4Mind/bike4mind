import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import type { PromptMeta } from '@bike4mind/common';

import {
  ANSWER_FEEDBACK_DAILY_DISMISSALS_KEY,
  DAILY_DISMISSAL_BUDGET,
  dismissAnswerFeedbackPrompt,
} from '@client/app/utils/answerFeedbackPrompt';
import { AnswerFeedbackPrompt } from './AnswerFeedbackPrompt';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

/** Verdict 'fail': a recorded tool failure is the cheapest fail arm to construct. */
const failing: PromptMeta = {
  functionCalls: [{ name: 'search_knowledge_base', success: false }],
};

/**
 * Verdict 'fail' via a second arm: the knowledge base was searched and returned nothing. Covered
 * separately from the tool-failure fixture because this is the trigger the issue leads with, and a
 * component that only ever saw one arm would not prove it reads the verdict rather than one check.
 */
const starved: PromptMeta = {
  retrieval: { attempted: true, outcome: 'ok', injected: { chunks: 0, chars: 0 } },
  context: { messageTruncation: { wasTruncated: false, originalMessageCount: 4, truncatedMessageCount: 4 } },
  functionCalls: [{ name: 'search_knowledge_base', success: true }],
};

/**
 * Verdict 'fail' via a third arm: retrieval ran against a corpus that was never indexed, so it
 * compared nothing. Worth its own case because this arm is deterministic where the zero-chunk one
 * is a similarity-noise draw, which makes it the arm most likely to fire in real use - and because
 * the gate reads `verdict.status` rather than enumerating arms, so a new arm must flow through
 * untouched.
 */
const notIndexed: PromptMeta = {
  retrieval: { attempted: true, outcome: 'not_indexed', injected: { chunks: 0, chars: 0 } },
  context: { messageTruncation: { wasTruncated: false, originalMessageCount: 4, truncatedMessageCount: 4 } },
  functionCalls: [{ name: 'search_knowledge_base', success: true }],
};

/** Verdict 'warn': truncated context, which already explains itself via its own banner. */
const warning: PromptMeta = {
  context: { messageTruncation: { wasTruncated: true, originalMessageCount: 40, truncatedMessageCount: 10 } },
  functionCalls: [],
  retrieval: { attempted: true, outcome: 'ok', injected: { chunks: 4, chars: 2000 } },
};

/** Verdict 'ok': nothing the pipeline controls went wrong. */
const healthy: PromptMeta = {
  retrieval: { attempted: true, outcome: 'ok', injected: { chunks: 4, chars: 2000 } },
  context: { messageTruncation: { wasTruncated: false, originalMessageCount: 10, truncatedMessageCount: 10 } },
  functionCalls: [{ name: 'search_knowledge_base', success: true }],
};

const renderPrompt = (props: Partial<React.ComponentProps<typeof AnswerFeedbackPrompt>> = {}) => {
  const onReport = vi.fn();
  const view = render(
    <Wrapper>
      <AnswerFeedbackPrompt promptMeta={failing} questId="quest-1" isReported={false} onReport={onReport} {...props} />
    </Wrapper>
  );
  return { onReport, ...view };
};

const prompt = () => screen.queryByTestId('answer-feedback-prompt');

describe('AnswerFeedbackPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('what it fires on', () => {
    it('asks for feedback on a turn the pipeline says broke', () => {
      renderPrompt();
      expect(prompt()).toBeTruthy();
    });

    it('reuses the diagnosis verdict copy rather than paraphrasing it', () => {
      // Shared wording is what stops this and the on-demand panel describing one turn two ways.
      renderPrompt();
      expect(screen.getByText('Something in the pipeline broke on this turn')).toBeTruthy();
    });

    it('asks on a turn where the knowledge base came back empty', () => {
      renderPrompt({ promptMeta: starved });
      expect(prompt()).toBeTruthy();
    });

    it('asks on a turn whose corpus was never indexed', () => {
      renderPrompt({ promptMeta: notIndexed });
      expect(prompt()).toBeTruthy();
    });

    it('stays silent on a healthy turn', () => {
      renderPrompt({ promptMeta: healthy });
      expect(prompt()).toBeNull();
    });

    it('stays silent on a warn turn, which already renders its own explanation', () => {
      renderPrompt({ promptMeta: warning });
      expect(prompt()).toBeNull();
    });

    it('stays silent when nothing was recorded, rather than asking about our own blind spot', () => {
      renderPrompt({ promptMeta: {} });
      expect(prompt()).toBeNull();
    });

    it('stays silent with no promptMeta at all', () => {
      renderPrompt({ promptMeta: undefined });
      expect(prompt()).toBeNull();
    });
  });

  describe('suppression', () => {
    it('never nags about a turn the user already reported', () => {
      renderPrompt({ isReported: true });
      expect(prompt()).toBeNull();
    });

    it('stays silent on a turn with no server row to anchor a dismissal to', () => {
      renderPrompt({ questId: undefined });
      expect(prompt()).toBeNull();
    });

    it('stays silent on a turn already waved off in a previous session', () => {
      dismissAnswerFeedbackPrompt('quest-1');
      renderPrompt();
      expect(prompt()).toBeNull();
    });

    it("stays silent once the day's dismissal budget is spent, even on a fresh turn", () => {
      for (let i = 0; i < DAILY_DISMISSAL_BUDGET; i++) {
        dismissAnswerFeedbackPrompt(`other-quest-${i}`);
      }
      renderPrompt();
      expect(prompt()).toBeNull();
    });
  });

  describe('acting on it', () => {
    it('opens the report modal and closes itself', () => {
      const { onReport } = renderPrompt();
      fireEvent.click(screen.getByTestId('answer-feedback-prompt-report-btn'));

      expect(onReport).toHaveBeenCalledTimes(1);
      expect(prompt()).toBeNull();
    });

    it('does not spend a dismissal when the user engages', () => {
      // Charging engagement to the budget would make the feature quietest for the users
      // most willing to use it. A second render still showing the prompt is not enough to prove
      // that - it would hold whether the CTA spent 0 or 1 of the daily budget - so assert the
      // stored counter directly.
      renderPrompt();
      fireEvent.click(screen.getByTestId('answer-feedback-prompt-report-btn'));
      expect(localStorage.getItem(ANSWER_FEEDBACK_DAILY_DISMISSALS_KEY)).toBeNull();
      cleanup();

      renderPrompt({ questId: 'quest-2' });
      expect(prompt()).toBeTruthy();
    });

    it('closes on dismiss and stays closed for that turn on a remount', () => {
      renderPrompt();
      fireEvent.click(screen.getByTestId('answer-feedback-prompt-dismiss-btn'));
      expect(prompt()).toBeNull();
      cleanup();

      renderPrompt();
      expect(prompt()).toBeNull();
    });
  });
});
