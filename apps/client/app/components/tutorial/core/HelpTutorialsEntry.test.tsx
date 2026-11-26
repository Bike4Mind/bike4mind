import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const closeHelpPanel = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/useHelpPanel', () => ({ closeHelpPanel }));
vi.mock('@client/app/hooks/data/tutorials', () => ({ useTutorialsEnabled: () => true }));

import { HelpTutorialsEntry } from './HelpTutorialsEntry';
import { useTutorialPicker } from './tutorialPickerStore';

afterEach(() => {
  vi.clearAllMocks();
  useTutorialPicker.setState({ open: false, hostMounted: false });
});

describe('HelpTutorialsEntry', () => {
  it('closes the Help panel and opens the picker', () => {
    useTutorialPicker.setState({ hostMounted: true });
    render(<HelpTutorialsEntry />);
    fireEvent.click(screen.getByTestId('help-open-tutorials'));
    expect(closeHelpPanel).toHaveBeenCalledTimes(1);
    expect(useTutorialPicker.getState().open).toBe(true);
  });

  it('renders nothing where no host runs the picker', () => {
    render(<HelpTutorialsEntry />);
    expect(screen.queryByTestId('help-open-tutorials')).toBeNull();
  });
});
