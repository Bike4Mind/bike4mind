import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ICallableFunctionShared } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  enabled: true,
  shared: undefined as ICallableFunctionShared[] | undefined,
  review: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@client/app/hooks/data/callableFunctions', () => ({
  useCallableFunctionsEnabled: () => h.enabled,
  useSharedCallableFunctions: () => ({ data: h.shared }),
  useReviewSharedCallableFunction: () => ({ mutate: h.review, isPending: false }),
  useUpdateSharedCallableFunctionReview: () => ({ mutate: h.update, isPending: false }),
}));

import SharedFunctionsSection from './SharedFunctionsSection';

const appTheme = extendTheme({ ...getThemeConfig() });

const HASH = 'd'.repeat(64);

const SHARED: ICallableFunctionShared = {
  id: 'fn-1',
  slug: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam.',
  status: 'pending_review',
  sharedVia: 'person',
  pin: { version: 5, seq: 2, pinnedAt: new Date() },
  trustLabel: 'verified',
  ownerName: 'Avery Owner',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['span'],
    properties: { span: { type: 'number', unit: 'm', minimum: 0 } },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    properties: { deflection: { type: 'number', unit: 'mm' } },
  },
  reviewHash: HASH,
  review: null,
  dataPins: ['loads.csv'],
  sources: ['https://data.example.com'],
  updatedAt: new Date(),
};

const REVIEWED: ICallableFunctionShared = {
  ...SHARED,
  status: 'reviewed',
  review: { approval: 'always_allow', enabled: true, reviewedAt: new Date(), current: true },
};

const renderSection = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SharedFunctionsSection />
    </CssVarsProvider>
  );

const chooseApproval = (label: string) => {
  fireEvent.click(screen.getByTestId('shared-function-approval'));
  fireEvent.click(screen.getByRole('option', { name: label }));
};

beforeEach(() => {
  h.enabled = true;
  h.shared = [SHARED];
  h.review.mockReset();
  h.update.mockReset();
});

describe('SharedFunctionsSection', () => {
  it('lists an unreviewed function as pending review and not callable', () => {
    renderSection();
    expect(screen.getAllByTestId('shared-function-row')).toHaveLength(1);
    expect(screen.getByTestId('shared-function-status').textContent).toBe('Pending review');
    expect(screen.getByTestId('shared-function-summary').textContent).toBe(
      'Shared with you by Avery Owner, promotion 2. It cannot be called until you review it.'
    );
    expect(screen.queryByTestId('shared-function-review-card')).toBeNull();
  });

  it('says what the platform label means', () => {
    h.shared = [{ ...SHARED, trustLabel: 'platform' }];
    renderSection();
    fireEvent.click(screen.getByTestId('shared-function-open-btn'));
    expect(screen.getByTestId('shared-function-label').textContent).toBe('Platform: curated and checked by Bike4Mind.');
  });

  it('opens a review card with the schemas, label, owner, and data list', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('shared-function-open-btn'));
    const card = screen.getByTestId('shared-function-review-card');
    expect(within(screen.getByTestId('shared-function-inputs')).getByText('span')).toBeTruthy();
    expect(screen.getByTestId('shared-function-inputs').textContent).toContain('at least 0');
    expect(within(screen.getByTestId('shared-function-outputs')).getByText('deflection')).toBeTruthy();
    expect(screen.getByTestId('shared-function-label').textContent).toMatch(/^Verified/);
    expect(screen.getByTestId('shared-function-owner').textContent).toBe('Avery Owner');
    expect(screen.getAllByTestId('shared-function-data-item').map(item => item.textContent)).toEqual([
      'Data file: loads.csv',
      'Source: https://data.example.com',
    ]);
    expect(card.textContent).toContain('A review covers the name, description, and schemas, not the code.');
    expect(screen.queryByTestId('shared-function-enabled')).toBeNull();
  });

  it('reviews the hash it shows, under the approval mode chosen', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('shared-function-open-btn'));
    chooseApproval('Always ask');
    expect(h.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('shared-function-review-btn'));
    expect(h.review).toHaveBeenCalledWith(
      { id: 'fn-1', reviewHash: HASH, approval: 'always_ask' },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it('says why a review is asked for again after the interface changed', () => {
    h.shared = [{ ...REVIEWED, status: 'pending_review', review: { ...REVIEWED.review!, current: false } }];
    renderSection();
    expect(screen.getByTestId('shared-function-status').textContent).toBe('Pending review');
    expect(screen.getByTestId('shared-function-summary').textContent).toContain(
      'Its name, description, or schemas changed since your review'
    );
    expect(screen.queryByTestId('shared-function-changes')).toBeNull();
  });

  it('lists each change to the interface since the review, field by field', () => {
    h.shared = [
      {
        ...REVIEWED,
        status: 'pending_review',
        review: { ...REVIEWED.review!, current: false },
        changes: [
          { path: 'description', side: null, field: '', kind: 'description_changed' },
          { path: 'inputs.factor', side: 'inputs', field: 'factor', kind: 'added' },
          {
            path: 'outputs.deflection.unit',
            side: 'outputs',
            field: 'deflection',
            kind: 'unit_changed',
            before: 'm',
            after: 'mm',
          },
        ],
      },
    ];
    renderSection();
    const items = within(screen.getByTestId('shared-function-changes'))
      .getAllByTestId('shared-function-change')
      .map(item => item.textContent);
    expect(items).toEqual([
      'the function changed its description',
      'input factor was added',
      'output deflection changed unit from m to mm',
    ]);
  });

  it('shows the conflict message when the interface changed during the review', () => {
    h.review.mockImplementation((_vars: unknown, options: { onError: (error: unknown) => void }) =>
      options.onError({ isAxiosError: true, response: { data: { code: 'review_conflict' } } })
    );
    renderSection();
    fireEvent.click(screen.getByTestId('shared-function-open-btn'));
    fireEvent.click(screen.getByTestId('shared-function-review-btn'));
    expect(screen.getByTestId('shared-function-error').textContent).toBe(
      'The tool changed while you were reviewing it. Review it again.'
    );
  });

  it('shows a generic message when saving a review fails for another reason', () => {
    h.review.mockImplementation((_vars: unknown, options: { onError: (error: unknown) => void }) =>
      options.onError({ isAxiosError: true, response: { status: 500, data: {} } })
    );
    renderSection();
    fireEvent.click(screen.getByTestId('shared-function-open-btn'));
    fireEvent.click(screen.getByTestId('shared-function-review-btn'));
    expect(screen.getByTestId('shared-function-error').textContent).toBe('Could not save the review. Try again.');
  });

  it('shows an error when a settings change fails to save', () => {
    h.shared = [REVIEWED];
    h.update.mockImplementation((_vars: unknown, options: { onError: (error: unknown) => void }) =>
      options.onError(new Error('boom'))
    );
    renderSection();
    fireEvent.click(screen.getByTestId('shared-function-open-btn'));
    fireEvent.click(screen.getByTestId('shared-function-enabled'));
    expect(screen.getByTestId('shared-function-error').textContent).toBe('Could not save the change. Try again.');
  });

  it('changes the approval mode and turns a reviewed function off', () => {
    h.shared = [REVIEWED];
    renderSection();
    expect(screen.getByTestId('shared-function-status').textContent).toBe('Reviewed');
    fireEvent.click(screen.getByTestId('shared-function-open-btn'));
    expect(screen.queryByTestId('shared-function-review-btn')).toBeNull();

    chooseApproval('Always ask');
    expect(h.update).toHaveBeenLastCalledWith({ id: 'fn-1', approval: 'always_ask' }, expect.anything());

    const toggle = screen.getByTestId('shared-function-enabled') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(h.update).toHaveBeenLastCalledWith({ id: 'fn-1', enabled: false }, expect.anything());
  });

  it('turns a function the recipient turned off back on', () => {
    h.shared = [{ ...REVIEWED, status: 'disabled', review: { ...REVIEWED.review!, enabled: false } }];
    renderSection();
    expect(screen.getByTestId('shared-function-status').textContent).toBe('Turned off');
    fireEvent.click(screen.getByTestId('shared-function-open-btn'));
    const toggle = screen.getByTestId('shared-function-enabled') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(h.update).toHaveBeenLastCalledWith({ id: 'fn-1', enabled: true }, expect.anything());
  });

  it('shows nothing with the setting off or nothing shared', () => {
    h.enabled = false;
    const { unmount } = renderSection();
    expect(screen.queryByTestId('shared-functions-section')).toBeNull();
    unmount();
    h.enabled = true;
    h.shared = [];
    renderSection();
    expect(screen.queryByTestId('shared-functions-section')).toBeNull();
  });
});
