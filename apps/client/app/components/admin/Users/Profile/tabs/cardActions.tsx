import React from 'react';
import { Button, Tooltip } from '@mui/joy';

type CardActionProps = { onClick: () => void; children: React.ReactNode; 'data-testid': string };
type RowActionProps = CardActionProps & { disabledReason?: string | null };

/** A small text button for a row-level action inside a fact. */
export const RowAction: React.FC<RowActionProps> = ({ onClick, children, disabledReason, 'data-testid': testId }) => {
  const button = (
    <Button
      size="sm"
      variant="plain"
      color="neutral"
      onClick={onClick}
      disabled={!!disabledReason}
      sx={{ minHeight: 24, px: 0.75 }}
      data-testid={testId}
    >
      {children}
    </Button>
  );
  // A disabled button gets no pointer events, so the reason hangs off a wrapper.
  return disabledReason ? (
    <Tooltip title={disabledReason}>
      <span data-testid={`${testId}-reason`} title={disabledReason}>
        {button}
      </span>
    </Tooltip>
  ) : (
    button
  );
};

export const HeaderAction: React.FC<CardActionProps> = ({ onClick, children, 'data-testid': testId }) => (
  <Button size="sm" variant="plain" color="neutral" onClick={onClick} sx={{ minHeight: 30 }} data-testid={testId}>
    {children}
  </Button>
);
