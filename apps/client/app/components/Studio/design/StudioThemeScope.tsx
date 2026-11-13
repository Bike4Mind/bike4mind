import type { ReactNode } from 'react';
import { useTheme } from '@mui/joy/styles';
import { styled } from '@mui/system';
import { studioColor, studioCssVariables, studioFont } from './studioTokens';

const ScopeRoot = styled('div')({
  '&[data-studio-mode="dark"]': { ...studioCssVariables('dark'), colorScheme: 'dark' },
  '&[data-studio-mode="light"]': { ...studioCssVariables('light'), colorScheme: 'light' },
  backgroundColor: studioColor('canvas'),
  color: studioColor('text'),
  fontFamily: studioFont('ui'),
});

type StudioThemeScopeProps = {
  children: ReactNode;
  testId?: string;
  className?: string;
};

/**
 * Declares the `--studio-*` tokens for everything inside it, in the app's resolved color mode.
 * Studio primitives read only these variables, so they render correctly only under this scope,
 * and the tokens never reach the rest of the app.
 */
const StudioThemeScope = ({ children, testId = 'studio-theme-scope', className }: StudioThemeScopeProps) => {
  const mode = useTheme().palette.mode;
  return (
    <ScopeRoot data-studio-mode={mode} data-testid={testId} className={className}>
      {children}
    </ScopeRoot>
  );
};

export default StudioThemeScope;
