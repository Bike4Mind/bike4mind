import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { CapabilityField } from './capabilityFields';
import CapabilityForm from './CapabilityForm';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderForm = (fields: CapabilityField[], overrides: Partial<Parameters<typeof CapabilityForm>[0]> = {}) => {
  const props = {
    testIdPrefix: 'demo-form',
    models: [
      { value: 'a', label: 'Model A' },
      { value: 'b', label: 'Model B' },
    ],
    modelId: 'a',
    onModelChange: vi.fn(),
    changes: [],
    fields,
    estimateCredits: 120,
    submitLabel: 'Generate',
    canSubmit: true,
    isSubmitting: false,
    onSubmit: vi.fn(),
    ...overrides,
  };
  render(
    <CssVarsProvider theme={appTheme}>
      <CapabilityForm {...props} />
    </CssVarsProvider>
  );
  return props;
};

describe('CapabilityForm', () => {
  it('toggles chips: picks a value, clears the selected one, and skips a disabled one', () => {
    const onChange = vi.fn();
    renderForm([
      {
        kind: 'chips',
        id: 'look',
        label: 'Look',
        value: 'a',
        options: [
          { value: 'a', label: 'A', swatch: { from: '#000000', to: '#ffffff' } },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C', disabled: true },
        ],
        onChange,
      },
    ]);

    expect(screen.getByTestId('demo-form-look-chips')).toBeInTheDocument();
    expect(screen.getByTestId('demo-form-look-a-chip')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('demo-form-look-b-chip')).toHaveAccessibleName('B');
    fireEvent.click(screen.getByTestId('demo-form-look-b-chip'));
    expect(onChange).toHaveBeenLastCalledWith('b');
    fireEvent.click(screen.getByTestId('demo-form-look-a-chip'));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId('demo-form-look-c-chip')).toBeDisabled();
  });

  it('renders each field kind under the prefix and reports changes through its own handler', () => {
    const onText = vi.fn();
    const onSegment = vi.fn();
    const onSwitch = vi.fn();
    const onPick = vi.fn();
    renderForm([
      { kind: 'text', id: 'prompt', label: 'Prompt', value: ' hi ', maxLength: 10, onChange: onText },
      {
        kind: 'segmented',
        id: 'mode',
        label: 'Mode',
        value: 'x',
        options: [
          { value: 'x', label: 'X' },
          { value: 'y', label: 'Y' },
        ],
        onChange: onSegment,
      },
      { kind: 'switch', id: 'vocals', label: 'Vocals', checked: false, onChange: onSwitch },
      { kind: 'note', id: 'length', label: 'Every song is 30s.' },
      { kind: 'image', id: 'image', label: 'Image', fileName: 'cat.png', onPick },
      {
        kind: 'group',
        id: 'output',
        fields: [
          { kind: 'range', id: 'duration', label: 'Duration', value: 4, min: 1, max: 8, step: 1, onChange: vi.fn() },
          {
            kind: 'select',
            id: 'aspect',
            label: 'Aspect',
            value: '1:1',
            options: [{ value: '1:1', label: '1:1' }],
            onChange: vi.fn(),
          },
        ],
      },
    ]);

    fireEvent.change(screen.getByTestId('demo-form-prompt-input'), { target: { value: 'song' } });
    expect(onText).toHaveBeenCalledWith('song');
    expect(screen.getByText('2/10')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('demo-form-mode-y-btn'));
    expect(onSegment).toHaveBeenCalledWith('y');
    expect(screen.getByTestId('demo-form-mode-x-btn')).toHaveAttribute('aria-pressed', 'true');

    expect(screen.getByRole('switch', { name: 'Vocals' })).toBe(screen.getByTestId('demo-form-vocals-switch'));
    fireEvent.click(screen.getByTestId('demo-form-vocals-switch'));
    expect(onSwitch).toHaveBeenCalledWith(true);

    expect(screen.getByTestId('demo-form-length-note')).toHaveTextContent('Every song is 30s.');

    expect(screen.getByTestId('demo-form-image-name')).toHaveTextContent('cat.png');
    fireEvent.click(screen.getByTestId('demo-form-image-pick-btn'));
    expect(onPick).toHaveBeenCalled();

    expect(screen.getByTestId('demo-form-duration-slider')).toHaveValue('4');
    expect(screen.getByTestId('demo-form-aspect-select')).toHaveTextContent('1:1');
  });

  it('does not report a click that deselects the active segment', () => {
    const onChange = vi.fn();
    renderForm([
      { kind: 'segmented', id: 'mode', label: 'Mode', value: 'x', options: [{ value: 'x', label: 'X' }], onChange },
    ]);
    fireEvent.click(screen.getByTestId('demo-form-mode-x-btn'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables a dependent field', () => {
    renderForm([
      { kind: 'text', id: 'lyrics', label: 'Lyrics', value: '', maxLength: 100, disabled: true, onChange: vi.fn() },
    ]);
    expect(screen.getByTestId('demo-form-lyrics-input')).toBeDisabled();
  });

  it('shows the changes, the estimate and submits', () => {
    const props = renderForm([], { changes: ['Duration changed from 12s to 8s.'] });
    expect(screen.getByTestId('demo-form-changes')).toHaveTextContent('Duration changed from 12s to 8s.');
    expect(screen.getByTestId('demo-form-estimate')).toHaveTextContent('Estimated cost: 120 credits');
    fireEvent.click(screen.getByTestId('demo-form-submit-btn'));
    expect(props.onSubmit).toHaveBeenCalled();
  });

  it('says when no estimate is available and blocks a submit it cannot send', () => {
    renderForm([], { estimateCredits: null, canSubmit: false });
    expect(screen.getByTestId('demo-form-estimate')).toHaveTextContent('Cost estimate unavailable');
    expect(screen.getByTestId('demo-form-submit-btn')).toBeDisabled();
  });

  it('inserts a snippet at the cursor on its own line', () => {
    const onLyrics = vi.fn();
    renderForm([
      {
        kind: 'text',
        id: 'lyrics',
        label: 'Lyrics',
        value: 'la la',
        maxLength: 100,
        snippets: ['[Verse]', '[Chorus]'],
        onChange: onLyrics,
      },
    ]);
    const textarea = screen.getByTestId<HTMLTextAreaElement>('demo-form-lyrics-input');
    textarea.setSelectionRange(5, 5);
    fireEvent.click(screen.getByTestId('demo-form-lyrics-chorus-snippet-btn'));
    expect(onLyrics).toHaveBeenCalledWith('la la\n[Chorus]\n');
  });

  it('inserts a snippet at a caret in the middle of the text', () => {
    const onLyrics = vi.fn();
    renderForm([
      {
        kind: 'text',
        id: 'lyrics',
        label: 'Lyrics',
        value: 'aa\nbb',
        maxLength: 100,
        snippets: ['[Verse]'],
        onChange: onLyrics,
      },
    ]);
    const textarea = screen.getByTestId<HTMLTextAreaElement>('demo-form-lyrics-input');
    textarea.setSelectionRange(2, 2);
    fireEvent.click(screen.getByTestId('demo-form-lyrics-verse-snippet-btn'));
    expect(onLyrics).toHaveBeenCalledWith('aa\n[Verse]\nbb');
  });

  it('disables the snippets with their field, and skips one that would pass the limit', () => {
    const onLyrics = vi.fn();
    renderForm([
      {
        kind: 'text',
        id: 'a',
        label: 'A',
        value: '',
        maxLength: 100,
        snippets: ['[Verse]'],
        disabled: true,
        onChange: vi.fn(),
      },
      { kind: 'text', id: 'b', label: 'B', value: 'abc', maxLength: 6, snippets: ['[Verse]'], onChange: onLyrics },
    ]);
    expect(screen.getByTestId('demo-form-a-verse-snippet-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('demo-form-b-verse-snippet-btn'));
    expect(onLyrics).not.toHaveBeenCalled();
  });

  it('draws aspect ratios as tiles and reports a pick', () => {
    const onAspect = vi.fn();
    renderForm([
      {
        kind: 'aspect',
        id: 'aspect',
        label: 'Aspect ratio',
        value: '1:1',
        options: [
          { value: '1:1', label: '1:1' },
          { value: '16:9', label: '16:9' },
        ],
        onChange: onAspect,
      },
    ]);
    fireEvent.click(screen.getByTestId('demo-form-aspect-16:9-btn'));
    expect(onAspect).toHaveBeenCalledWith('16:9');
  });

  it('lists reference files with a remove button and offers Add until the slots are full', () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    const field = {
      kind: 'references' as const,
      id: 'refs',
      label: 'Reference images',
      files: [{ fileId: 'f1', fileName: 'a.png' }],
      max: 2,
      onAdd,
      onRemove,
    };
    renderForm([field]);
    expect(screen.getByTestId('demo-form-refs-file-f1')).toHaveTextContent('a.png');
    fireEvent.click(screen.getByTestId('demo-form-refs-remove-f1-btn'));
    expect(onRemove).toHaveBeenCalledWith('f1');
    fireEvent.click(screen.getByTestId('demo-form-refs-add-btn'));
    expect(onAdd).toHaveBeenCalled();
  });

  it('marks a kept value the model does not take, offers its fix, and holds submit', () => {
    const apply = vi.fn();
    renderForm([
      {
        kind: 'segmented',
        id: 'res',
        label: 'Resolution',
        value: '4k',
        options: [
          { value: '720p', label: '720p' },
          { value: '4k', label: '4k', invalid: true },
        ],
        onChange: vi.fn(),
        invalidReason: 'Model B supports 720p; you asked for 4k',
        fix: { label: 'Use 720p', apply },
      },
    ]);
    expect(screen.getByTestId('demo-form-res-4k-btn')).toHaveAttribute('data-invalid', 'true');
    expect(screen.getByTestId('demo-form-res-invalid')).toHaveTextContent('you asked for 4k');
    expect(screen.getByTestId('demo-form-submit-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('demo-form-res-fix-btn'));
    expect(apply).toHaveBeenCalled();
  });

  it('picks the model from cards, greying a mismatch but keeping it pickable, and an unavailable one not', () => {
    const card = {
      provider: 'Acme',
      strength: 'Good at things.',
      creditsPerOutput: 12,
      outputNoun: 'image',
      modes: ['Generate'],
      unavailableReason: null,
      mismatchReason: null,
    };
    const props = renderForm([], {
      models: undefined,
      modelCards: [
        { ...card, id: 'a', name: 'Model A' },
        { ...card, id: 'b', name: 'Model B', mismatchReason: 'Model B takes no aspect ratio' },
        { ...card, id: 'c', name: 'Model C', unavailableReason: 'Temporarily unavailable in Studio.' },
      ],
    });
    expect(screen.queryByTestId('demo-form-model-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('demo-form-model-card-a')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('demo-form-model-card-a-cost')).toHaveTextContent('credits per image');
    expect(screen.getByTestId('demo-form-model-card-b-reason')).toHaveTextContent('takes no aspect ratio');
    expect(screen.getByTestId('demo-form-model-card-c-radio')).toBeDisabled();
    fireEvent.click(screen.getByTestId('demo-form-model-card-b-radio'));
    expect(props.onModelChange).toHaveBeenCalledWith('b');
  });
});
