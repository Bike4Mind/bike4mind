import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SupportingFiles } from './parts';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('SupportingFiles', () => {
  it("shows each file's path and full content, flagging scripts", () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <SupportingFiles
          files={[
            { path: 'references/api.md', content: '# API notes' },
            { path: 'scripts/run.sh', content: 'echo hi' },
          ]}
        />
      </CssVarsProvider>
    );
    const [reference, script] = screen.getAllByTestId('market-supporting-file');
    expect(reference).toHaveTextContent('references/api.md');
    expect(reference).toHaveTextContent('# API notes');
    expect(reference).not.toHaveTextContent("runs on the user's machine");
    expect(script).toHaveTextContent("scripts/run.shruns on the user's machine");
    expect(script).toHaveTextContent('echo hi');
  });

  it('renders nothing for a version without files', () => {
    render(<SupportingFiles files={undefined} />);
    expect(screen.queryByTestId('market-supporting-files')).not.toBeInTheDocument();
  });
});
