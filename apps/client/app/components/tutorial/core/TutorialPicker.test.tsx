import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { TutorialProgressEntry, TutorialRunModule } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { TutorialPicker, type TutorialPickerProps } from './TutorialPicker';

const appTheme = extendTheme({ ...getThemeConfig() });

const tutorial = (id: string, track?: TutorialRunModule['track']): TutorialRunModule => ({
  id,
  title: `Title ${id}`,
  pitch: `Pitch ${id}`,
  version: 1,
  revision: 0,
  enabled: true,
  steps: [{ id: `${id}-a`, type: 'point', body: 'a' }],
  ...(track && { track }),
});

const saved = (status: TutorialProgressEntry['status'], stepId: string): TutorialProgressEntry => ({
  status,
  stepId,
  sessionId: 's1',
  moduleVersion: 1,
});

function renderPicker(props: Partial<TutorialPickerProps> = {}) {
  const handlers = { onStart: vi.fn(), onResume: vi.fn(), onClose: vi.fn() };
  render(
    <CssVarsProvider theme={appTheme}>
      <TutorialPicker
        open
        modules={[tutorial('new', 'basics'), tutorial('going', 'basics'), tutorial('done', 'different')]}
        progress={{ going: saved('left', 'going-a'), done: saved('finished', 'done-a') }}
        {...handlers}
        {...props}
      />
    </CssVarsProvider>
  );
  return handlers;
}

describe('TutorialPicker', () => {
  it('groups the tutorials by track and shows where the user stands in each', () => {
    renderPicker();
    const basics = screen.getByTestId('tutorial-picker-group-basics');
    expect(within(basics).getByText('The basics')).toBeInTheDocument();
    expect(within(basics).getByTestId('tutorial-picker-row-new')).toBeInTheDocument();
    expect(within(basics).getByTestId('tutorial-picker-row-going')).toBeInTheDocument();
    expect(within(screen.getByTestId('tutorial-picker-group-different')).getByText('Title done')).toBeInTheDocument();
    expect(screen.getByTestId('tutorial-picker-status-new')).toHaveTextContent('Not started');
    expect(screen.getByTestId('tutorial-picker-status-going')).toHaveTextContent('In progress');
    expect(screen.getByTestId('tutorial-picker-status-done')).toHaveTextContent('Finished');
  });

  it('starts a new tutorial, resumes or restarts one in progress, and replays a finished one', () => {
    const { onStart, onResume } = renderPicker();
    fireEvent.click(screen.getByTestId('tutorial-picker-start-new'));
    expect(onStart).toHaveBeenLastCalledWith('new');
    fireEvent.click(screen.getByTestId('tutorial-picker-resume-going'));
    expect(onResume).toHaveBeenCalledWith('going');
    fireEvent.click(screen.getByTestId('tutorial-picker-restart-going'));
    expect(onStart).toHaveBeenLastCalledWith('going');
    expect(screen.getByTestId('tutorial-picker-start-done')).toHaveTextContent('Replay');
    fireEvent.click(screen.getByTestId('tutorial-picker-start-done'));
    expect(onStart).toHaveBeenLastCalledWith('done');
  });

  it('says so when there is nothing to take', () => {
    renderPicker({ modules: [], progress: {} });
    expect(screen.getByTestId('tutorial-picker-empty')).toBeInTheDocument();
  });
});
