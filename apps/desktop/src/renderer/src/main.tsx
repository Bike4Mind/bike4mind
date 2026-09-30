import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import CssBaseline from '@mui/joy/CssBaseline';
import { CssVarsProvider } from '@mui/joy/styles';
import { RouterProvider } from '@tanstack/react-router';
import { publishScrollGutterWidth } from './chat/layout';
import { router } from './router';

const container = document.getElementById('root');
if (!container) throw new Error('renderer root element is missing from index.html');

// Before the first paint, so no row is ever laid out against a gutter of the wrong width.
publishScrollGutterWidth();

createRoot(container).render(
  <StrictMode>
    <CssVarsProvider defaultMode="system">
      <CssBaseline />
      <RouterProvider router={router} />
    </CssVarsProvider>
  </StrictMode>
);
