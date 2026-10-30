import React from 'react';
import { Button } from '@mui/joy';

type CardActionProps = { onClick: () => void; children: React.ReactNode; 'data-testid': string };

/** A small text button for a row-level action inside a fact. */
export const RowAction: React.FC<CardActionProps> = ({ onClick, children, 'data-testid': testId }) => (
  <Button
    size="sm"
    variant="plain"
    color="neutral"
    onClick={onClick}
    sx={{ minHeight: 24, px: 0.75 }}
    data-testid={testId}
  >
    {children}
  </Button>
);

export const HeaderAction: React.FC<CardActionProps> = ({ onClick, children, 'data-testid': testId }) => (
  <Button size="sm" variant="plain" color="neutral" onClick={onClick} sx={{ minHeight: 30 }} data-testid={testId}>
    {children}
  </Button>
);
