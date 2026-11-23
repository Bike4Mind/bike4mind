import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import CssBaseline from '@mui/joy/CssBaseline';
import { CssVarsProvider } from '@mui/joy/styles';
import { RouterProvider } from '@tanstack/react-router';
import { installErrorReporting } from './devlog/reportErrors';
import { publishScrollGutterWidth } from './chat/layout';
import { AppErrorBoundary } from './errors/AppErrorBoundary';
import { router } from './router';
import { desktopTheme } from './theme';
import { WindowThemeSync } from './WindowThemeSync';
import './scrollbars.css';
import './viewport.css';

const container = document.getElementById('root');
if (!container) throw new Error('renderer root element is missing from index.html');

// Before the first render, so errors after startup are reported. Import-time failures are not.
installErrorReporting();

// Before the first paint, so no row is ever laid out against a gutter of the wrong width.
publishScrollGutterWidth();

createRoot(container).render(
  <StrictMode>
    <CssVarsProvider theme={desktopTheme} defaultMode="system">
      <CssBaseline />
      <AppErrorBoundary>
        <WindowThemeSync />
        <RouterProvider router={router} />
      </AppErrorBoundary>
    </CssVarsProvider>
  </StrictMode>
);
