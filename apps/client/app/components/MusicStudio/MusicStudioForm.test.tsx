import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicMusicModel } from '@bike4mind/common';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { getThemeConfig } from '@client/app/utils/themes';
import { toPublicMusicModel } from '@bike4mind/server-utils/musicGenerations/listUsableMusicModels';
import MusicStudioForm from './MusicStudioForm';

const musicV2 = toPublicMusicModel('music_v2');
const clip = toPublicMusicModel('lyria-3-clip-preview');

const settings = vi.hoisted(() => ({ enforceCredits: true }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? settings.enforceCredits : undefined),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const onSubmit = vi.fn();

const tree = (models: readonly [PublicMusicModel, ...PublicMusicModel[]]) => (
  <CssVarsProvider theme={appTheme}>
    <MusicStudioForm models={models} isSubmitting={false} onSubmit={onSubmit} />
  </CssVarsProvider>
);

const typePrompt = (text: string) =>
  fireEvent.change(screen.getByTestId('music-form-prompt-input'), { target: { value: text } });
const pickModel = (name: string) => {
  fireEvent.click(screen.getByTestId('music-form-model-select'));
  fireEvent.click(screen.getByRole('option', { name }));
};

beforeEach(() => {
  vi.clearAllMocks();
  settings.enforceCredits = true;
  useSelectedAccount.setState({ selectedAccount: null });
});

describe('MusicStudioForm submit', () => {
  it('is disabled until there is a prompt', () => {
    render(tree([musicV2, clip]));
    expect(screen.getByTestId('music-form-submit-btn')).toBeDisabled();
    typePrompt('a slow ballad');
    expect(screen.getByTestId('music-form-submit-btn')).toBeEnabled();
  });

  it('sends the body for the model the user picked, not the default', () => {
    render(tree([musicV2, clip]));
    typePrompt('  a happy tune  ');
    pickModel('Lyria 3 Clip');
    fireEvent.click(screen.getByTestId('music-form-submit-btn'));

    // The clip model is fixed at 30s, so the request carries no duration and no empty lyrics.
    expect(onSubmit).toHaveBeenCalledWith({
      model: 'lyria-3-clip-preview',
      prompt: 'a happy tune',
      instrumental: false,
    });
  });

  it('sends the lyrics and the duration the model accepts', () => {
    render(tree([musicV2, clip]));
    typePrompt('a slow ballad');
    fireEvent.change(screen.getByTestId('music-form-lyrics-input'), { target: { value: ' [Verse]\nhello ' } });
    fireEvent.click(screen.getByTestId('music-form-submit-btn'));

    expect(onSubmit).toHaveBeenCalledWith({
      model: 'music_v2',
      prompt: 'a slow ballad',
      instrumental: false,
      lyrics: '[Verse]\nhello',
      duration_seconds: 60,
    });
  });
});

describe('MusicStudioForm model switch', () => {
  it('says what a fixed-length model changed', () => {
    render(tree([musicV2, clip]));
    pickModel('Lyria 3 Clip');
    expect(screen.getByTestId('music-form-changes')).toHaveTextContent('Lyria 3 Clip always makes 30s songs.');
    expect(screen.queryByTestId('music-form-duration-slider')).not.toBeInTheDocument();
  });
});

describe('music form payer note', () => {
  const select = (name: string, personal: boolean) =>
    useSelectedAccount.setState({ selectedAccount: { id: 'acct-1', name, personal, credits: 100 } });

  it('names the selected organization', () => {
    select('Acme', false);
    render(tree([musicV2, clip]));
    expect(screen.getByTestId('music-form-payer-note')).toHaveTextContent('Paid from Acme credits');
  });

  it('names personal credits', () => {
    select('Me', true);
    render(tree([musicV2, clip]));
    expect(screen.getByTestId('music-form-payer-note')).toHaveTextContent('Paid from your personal credits');
  });

  it('is hidden with no selection', () => {
    render(tree([musicV2, clip]));
    expect(screen.queryByTestId('music-form-payer-note')).not.toBeInTheDocument();
  });

  it('is hidden when credits are not enforced', () => {
    settings.enforceCredits = false;
    select('Acme', false);
    render(tree([musicV2, clip]));
    expect(screen.queryByTestId('music-form-payer-note')).not.toBeInTheDocument();
  });
});
