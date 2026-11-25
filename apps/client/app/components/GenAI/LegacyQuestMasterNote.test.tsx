import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import LegacyQuestMasterNote from './LegacyQuestMasterNote';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('LegacyQuestMasterNote', () => {
  it('renders the legacy plan note with its exact copy', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <LegacyQuestMasterNote />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('legacy-questmaster-note').textContent).toBe(
      'This reply had a QuestMaster plan. QuestMaster plans are no longer shown in chat. ' +
        'Saved plans were copied as markdown files to the "Questmaster archive" folder in your files.'
    );
  });
});
