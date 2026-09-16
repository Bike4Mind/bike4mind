// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CorrectionComposer } from './CorrectionComposer';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderComposer = (props: Partial<React.ComponentProps<typeof CorrectionComposer>> = {}) => {
  const onSubmit = props.onSubmit ?? vi.fn();
  const onCancel = props.onCancel ?? vi.fn();
  render(
    <TestWrapper>
      <CorrectionComposer {...props} onSubmit={onSubmit} onCancel={onCancel} />
    </TestWrapper>
  );
  return { onSubmit, onCancel };
};

const typeCorrection = (text: string) =>
  fireEvent.change(screen.getByTestId('message-correction-input'), { target: { value: text } });

describe('CorrectionComposer', () => {
  it('cannot submit an empty correction', () => {
    renderComposer();

    expect(screen.getByTestId('message-correction-submit-btn')).toBeDisabled();
  });

  it('treats a whitespace-only correction as empty', () => {
    const { onSubmit } = renderComposer();
    typeCorrection('   \n  ');

    expect(screen.getByTestId('message-correction-submit-btn')).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId('message-correction-input'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the trimmed correction', () => {
    const { onSubmit } = renderComposer();
    typeCorrection('  the figure is Q3, not Q2  ');
    fireEvent.click(screen.getByTestId('message-correction-submit-btn'));

    expect(onSubmit).toHaveBeenCalledWith('the figure is Q3, not Q2');
  });

  it('sends on Enter', () => {
    const { onSubmit } = renderComposer();
    typeCorrection('wrong quarter');
    fireEvent.keyDown(screen.getByTestId('message-correction-input'), { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith('wrong quarter');
  });

  it('breaks the line on Shift+Enter rather than sending', () => {
    const { onSubmit } = renderComposer();
    typeCorrection('wrong quarter');
    fireEvent.keyDown(screen.getByTestId('message-correction-input'), { key: 'Enter', shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('abandons on Escape', () => {
    const { onCancel, onSubmit } = renderComposer();
    typeCorrection('never mind');
    fireEvent.keyDown(screen.getByTestId('message-correction-input'), { key: 'Escape' });

    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('cancels on the Cancel button', () => {
    const { onCancel } = renderComposer();
    fireEvent.click(screen.getByTestId('message-correction-cancel-btn'));

    expect(onCancel).toHaveBeenCalled();
  });

  // Double-send is the failure that costs the user a duplicate completion, and Enter makes it easy
  // to trigger twice before the first send resolves.
  it('does not resend while a submit is in flight', () => {
    const { onSubmit } = renderComposer({ isSubmitting: true });
    typeCorrection('wrong quarter');
    fireEvent.keyDown(screen.getByTestId('message-correction-input'), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
