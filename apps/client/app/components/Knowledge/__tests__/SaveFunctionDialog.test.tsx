import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { FunctionContract } from '@bike4mind/common';

const h = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), delete: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post, get: h.get, delete: h.delete } }));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (select: (s: { accessToken: string | null }) => unknown) => select({ accessToken: 'token' }),
}));

import SaveFunctionDialog from '../SaveFunctionDialog';

const appTheme = extendTheme({ ...getThemeConfig() });

const CONTRACT = {
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam under a uniform load.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['load', 'span', 'elastic_modulus', 'second_moment'],
    properties: {
      load: { type: 'number', unit: 'N/m', exclusiveMinimum: 0 },
      span: { type: 'number', unit: 'm', exclusiveMinimum: 0 },
      elastic_modulus: { type: 'number', unit: 'Pa', exclusiveMinimum: 0 },
      second_moment: { type: 'number', unit: 'm^4', exclusiveMinimum: 0 },
    },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: { deflection: { type: 'number', unit: 'm' } },
  },
} as unknown as FunctionContract;

const HASH = 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const savedView = {
  id: 'fn-1',
  slug: 'beam_midspan_deflection',
  description: CONTRACT.description,
  status: 'draft',
  state: 'draft',
  enabled: true,
  pin: { artifactId: 'artifact-1', version: 3, contentHash: HASH, pinnedAt: '2026-11-22T10:00:00.000Z' },
  latestVersion: 3,
  updateAvailable: false,
  createdAt: '2026-11-22T10:00:00.000Z',
  updatedAt: '2026-11-22T10:00:00.000Z',
};

const axiosError = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { ...(data as object), request_id: 'req-1' } },
  });

const renderDialog = (onClose = vi.fn()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={appTheme}>
        <SaveFunctionDialog open onClose={onClose} artifactId="artifact-1" version={3} contract={CONTRACT} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return { onClose };
};

const submit = () => fireEvent.click(screen.getByTestId('save-function-dialog-submit-btn'));

const summaryRows = () =>
  Object.fromEntries(
    within(screen.getByTestId('save-function-dialog-summary'))
      .getAllByRole('row')
      .map(row => [row.querySelector('th')?.textContent, row.querySelector('td')?.textContent])
  );

const slugTaken = (sourceDeleted: boolean) =>
  axiosError(409, {
    error: 'You already have a tool named beam_midspan_deflection.',
    code: 'slug_taken',
    slug: 'beam_midspan_deflection',
    functionId: 'fn-old',
    sourceDeleted,
  });

describe('SaveFunctionDialog', () => {
  beforeEach(() => {
    h.post.mockReset();
    h.get.mockReset();
    h.delete.mockReset();
  });

  it('introduces the tool and lists its name, description, pinned version, inputs, and outputs', () => {
    renderDialog();

    const dialog = screen.getByTestId('save-function-dialog');
    expect(within(dialog).getByText('Make this a tool')).toBeTruthy();
    expect(dialog.textContent).toContain(
      'This saves beam_midspan_deflection as a tool pinned to version 3 of this artifact. Later edits do not change the tool until you update it.'
    );
    expect(summaryRows()).toEqual({
      Name: 'beam_midspan_deflection',
      Description: 'Midspan deflection of a simply supported beam under a uniform load.',
      'Pinned version': '3',
      Inputs: '4 inputs',
      Outputs: '1 output',
    });
    expect(dialog.textContent).toContain(
      'Only you can call it, and your browser runs it here. Server tests, promotion, and every call to a promoted tool from the API, chat, or an agent run it on the server.'
    );
    expect(dialog.textContent).not.toContain('Nothing runs on the server');
    expect(screen.getByTestId('save-function-dialog-submit-btn').textContent).toBe('Save as a draft tool');
  });

  it('sends only the artifact id, the version shown, and the contract', async () => {
    h.post.mockResolvedValue({ data: savedView });
    renderDialog();

    submit();

    await screen.findByTestId('save-function-dialog-saved');
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith('/api/callable-functions', {
      artifactId: 'artifact-1',
      expectedVersion: 3,
      contract: CONTRACT,
    });
  });

  it('saving: shows the submit button loading and disables Cancel and the close button', async () => {
    let answer: (value: unknown) => void = () => {};
    h.post.mockReturnValue(new Promise(resolve => (answer = resolve)));
    const { onClose } = renderDialog();

    submit();

    const cancel = screen.getByTestId('save-function-dialog-cancel-btn') as HTMLButtonElement;
    await waitFor(() => expect(cancel.disabled).toBe(true));
    const submitButton = screen.getByTestId('save-function-dialog-submit-btn') as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    expect(submitButton.getAttribute('class')).toContain('loading');
    const close = within(screen.getByTestId('save-function-dialog'))
      .getAllByRole('button')
      .find(button => button !== cancel && button !== submitButton) as HTMLButtonElement;
    expect(close.disabled).toBe(true);

    fireEvent.keyDown(screen.getByTestId('save-function-dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    answer({ data: savedView });
    await screen.findByTestId('save-function-dialog-saved');
  });

  it('a second click while saving sends no second request', async () => {
    h.post.mockReturnValue(new Promise(() => {}));
    renderDialog();

    submit();
    submit();

    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
  });

  it('saved as a draft: shows the code fingerprint from the response and Done closes', async () => {
    h.post.mockResolvedValue({ data: savedView });
    const { onClose } = renderDialog();

    submit();

    const saved = await screen.findByTestId('save-function-dialog-saved');
    expect(saved.textContent).toContain('Saved as a draft tool.');
    expect(saved.textContent).toContain(`Code fingerprint: ${HASH.slice(0, 12)}`);
    expect(screen.queryByTestId('save-function-dialog-submit-btn')).toBeNull();
    expect(screen.queryByTestId('save-function-dialog-cancel-btn')).toBeNull();

    fireEvent.click(screen.getByTestId('save-function-dialog-done-btn'));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('Cancel closes without saving', () => {
    const { onClose } = renderDialog();

    fireEvent.click(screen.getByTestId('save-function-dialog-cancel-btn'));

    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.post).not.toHaveBeenCalled();
  });

  it('paints the summary row labels without the table head background, in a box that scrolls sideways', () => {
    renderDialog();

    const table = screen.getByTestId('save-function-dialog-summary');
    const label = within(table).getByText('Name');
    expect(getComputedStyle(label).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(table).tableLayout).toBe('auto');
    expect(getComputedStyle(table.parentElement as HTMLElement).overflowX).toBe('auto');
  });

  it('a name held by a tool whose artifact is live (slug_taken): says how to change it and offers no Replace', async () => {
    h.post.mockRejectedValue(slugTaken(false));
    renderDialog();

    submit();

    const error = await screen.findByTestId('save-function-dialog-error');
    expect(error.textContent).toBe(
      'You already have a tool named beam_midspan_deflection. Change the name in FUNCTION, save the artifact, and try again.'
    );
    expect(within(error).getByTestId('save-function-dialog-error-alert')).toBeTruthy();
    expect(within(error).queryByTestId('save-function-dialog-replace-alert')).toBeNull();
    expect(screen.getByTestId('save-function-dialog-submit-btn')).toBeTruthy();
    expect(screen.queryByTestId('save-function-dialog-replace-btn')).toBeNull();
  });

  it('a name held by a tool whose artifact was deleted: Replace it deletes that tool, then saves this one', async () => {
    h.post.mockRejectedValueOnce(slugTaken(true)).mockResolvedValueOnce({ data: savedView });
    h.delete.mockResolvedValue({ data: undefined });
    renderDialog();

    submit();

    const error = await screen.findByTestId('save-function-dialog-error');
    expect(error.textContent).toBe(
      'You already have a tool named beam_midspan_deflection, saved from an artifact that has since been deleted. Replace it with this one?'
    );
    const alert = within(error).getByTestId('save-function-dialog-replace-alert');
    expect(getComputedStyle(alert).backgroundColor).toContain('--joy-palette-warning-softBg');
    expect(within(error).queryByTestId('save-function-dialog-error-alert')).toBeNull();
    expect(screen.queryByTestId('save-function-dialog-submit-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('save-function-dialog-replace-btn'));

    await screen.findByTestId('save-function-dialog-saved');
    expect(h.delete).toHaveBeenCalledExactlyOnceWith('/api/callable-functions/fn-old');
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.delete.mock.invocationCallOrder[0]).toBeLessThan(h.post.mock.invocationCallOrder[1]);
  });

  it('Replace it holds the saving state from the delete through the save', async () => {
    let deleted: (value: unknown) => void = () => {};
    h.post.mockRejectedValueOnce(slugTaken(true)).mockReturnValueOnce(new Promise(() => {}));
    h.delete.mockReturnValue(new Promise(resolve => (deleted = resolve)));
    renderDialog();
    submit();
    fireEvent.click(await screen.findByTestId('save-function-dialog-replace-btn'));

    const cancel = screen.getByTestId('save-function-dialog-cancel-btn') as HTMLButtonElement;
    await waitFor(() => expect(cancel.disabled).toBe(true));
    deleted({ data: undefined });
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
    expect(cancel.disabled).toBe(true);
    expect((screen.getByTestId('save-function-dialog-submit-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a failed delete under Replace it shows the reason and saves nothing', async () => {
    h.post.mockRejectedValue(slugTaken(true));
    h.delete.mockRejectedValue(axiosError(500, { error: 'Something went wrong.' }));
    renderDialog();
    submit();
    fireEvent.click(await screen.findByTestId('save-function-dialog-replace-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('save-function-dialog-error').textContent).toBe(
        'Could not delete the old tool. Something went wrong.'
      )
    );
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('save-function-dialog-replace-btn')).toBeTruthy();
  });

  it('Replace it after another tab deleted the old tool (404): saves this one', async () => {
    h.post.mockRejectedValueOnce(slugTaken(true)).mockResolvedValueOnce({ data: savedView });
    h.delete.mockRejectedValue(axiosError(404, { error: 'Tool not found' }));
    renderDialog();
    submit();
    fireEvent.click(await screen.findByTestId('save-function-dialog-replace-btn'));

    await screen.findByTestId('save-function-dialog-saved');
    expect(screen.queryByTestId('save-function-dialog-error')).toBeNull();
    expect(h.delete).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it('Replace it after another tab took the name again (404, then slug_taken): says the name is taken', async () => {
    h.post.mockRejectedValueOnce(slugTaken(true)).mockRejectedValueOnce(slugTaken(false));
    h.delete.mockRejectedValue(axiosError(404, { error: 'Tool not found' }));
    renderDialog();
    submit();
    fireEvent.click(await screen.findByTestId('save-function-dialog-replace-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('save-function-dialog-error').textContent).toBe(
        'You already have a tool named beam_midspan_deflection. Change the name in FUNCTION, save the artifact, and try again.'
      )
    );
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('save-function-dialog-replace-btn')).toBeNull();
    expect(screen.getByTestId('save-function-dialog-submit-btn')).toBeTruthy();
  });

  it('a failed save after Replace it deleted the old tool says so, and saving again works', async () => {
    h.post
      .mockRejectedValueOnce(slugTaken(true))
      .mockRejectedValueOnce(
        axiosError(409, { error: 'The artifact changed since you opened it. Reload it and try again.' })
      )
      .mockResolvedValueOnce({ data: savedView });
    h.delete.mockResolvedValue({ data: undefined });
    renderDialog();
    submit();
    fireEvent.click(await screen.findByTestId('save-function-dialog-replace-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('save-function-dialog-error').textContent).toBe(
        'The old tool was deleted, but this one was not saved. The artifact changed since you opened it. Reload it and try again. Select Save as a draft tool to try again.'
      )
    );
    expect(screen.queryByTestId('save-function-dialog-replace-btn')).toBeNull();
    submit();

    await screen.findByTestId('save-function-dialog-saved');
    expect(h.delete).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledTimes(3);
  });

  it('a contract with problems (invalid_contract): lists each problem under the heading', async () => {
    h.post.mockRejectedValue(
      axiosError(400, {
        error: 'The function contract has problems.',
        code: 'invalid_contract',
        problems: [
          {
            path: 'inputs.properties.span.unit',
            message: 'a number field needs a unit (use "1" for a value without one)',
          },
          { path: 'outputs.properties', message: 'must have at least 1 property' },
        ],
      })
    );
    renderDialog();

    submit();

    const error = await screen.findByTestId('save-function-dialog-error');
    const problems = within(error).getByTestId('python-function-problems');
    expect(problems.textContent).toContain('The function contract has problems:');
    expect(
      within(problems)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual([
      'inputs.properties.span.unit: a number field needs a unit (use "1" for a value without one)',
      'outputs.properties: must have at least 1 property',
    ]);
  });

  it.each([
    ['version_changed', 409, 'The artifact changed since you opened it. Reload it and try again.'],
    ['invalid_name', 400, 'A function name cannot contain two underscores in a row or end with an underscore.'],
    ['function_limit', 409, 'You can have at most 100 saved tools.'],
    ['source_too_large', 400, 'The code is larger than 256 KB.'],
    ['no_entry_point', 400, 'The saved code has no FUNCTION contract and run function.'],
    ['hash_mismatch', 409, 'The saved code could not be verified.'],
    ['not_python', 400, 'Only a Python artifact can be saved as a tool.'],
  ])('a %s refusal shows the server message', async (code, status, message) => {
    h.post.mockRejectedValue(axiosError(status, { error: message, code }));
    renderDialog();

    submit();

    expect((await screen.findByTestId('save-function-dialog-error')).textContent).toBe(message);
  });

  it.each([
    ['the artifact is missing or not yours (404)', 404, { error: 'Artifact not found' }, 'Artifact not found'],
    ['the setting is off (403)', 403, { error: 'Callable functions are disabled' }, 'Callable functions are disabled'],
    [
      'a refused body (invalid_body)',
      400,
      { error: 'Invalid request body', code: 'invalid_body', issues: [{ path: 'contract', message: 'Required' }] },
      'Required',
    ],
  ])('%s shows the server message', async (_name, status, data, message) => {
    h.post.mockRejectedValue(axiosError(status, data));
    renderDialog();

    submit();

    expect((await screen.findByTestId('save-function-dialog-error')).textContent).toBe(message);
  });

  it('an error without an answer falls back to Could not save the tool.', async () => {
    h.post.mockRejectedValue(new Error('Network Error'));
    renderDialog();

    submit();

    expect((await screen.findByTestId('save-function-dialog-error')).textContent).toBe('Could not save the tool.');
  });
});
