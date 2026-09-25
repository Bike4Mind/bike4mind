import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import CssBaseline from '@mui/joy/CssBaseline';
import { CssVarsProvider } from '@mui/joy/styles';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';

const container = document.getElementById('root');
if (!container) throw new Error('renderer root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <CssVarsProvider defaultMode="system">
      <CssBaseline />
      <RouterProvider router={router} />
    </CssVarsProvider>
  </StrictMode>
);
