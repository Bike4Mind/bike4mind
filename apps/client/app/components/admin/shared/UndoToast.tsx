import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Button, Snackbar, Stack, Typography } from '@mui/joy';
import { getErrorMessage } from '@client/app/utils/error';
import { adminFocusScope } from './adminStyles';

export const UNDO_TOAST_DURATION_MS = 30_000;

export type UndoToastOptions = {
  message: string;
  /** The reverse write. It must record its own audit entry; the toast adds no undo semantics. */
  onUndo: () => void | Promise<void>;
  /** Opens the audit entry for the write being offered for undo. */
  onViewAudit?: () => void;
};

type ShowUndoToast = (options: UndoToastOptions) => void;

const UndoToastContext = createContext<ShowUndoToast | null>(null);

/** Bottom-center recovery toast for admin writes. One at a time: showing a new one replaces the last. */
export const UndoToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toast, setToast] = useState<(UndoToastOptions & { id: number }) | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const nextId = useRef(0);

  const show = useCallback<ShowUndoToast>(options => {
    nextId.current += 1;
    setToast({ ...options, id: nextId.current });
    setUndoing(false);
    setUndoError(null);
  }, []);

  const dismiss = () => {
    if (undoing) return;
    setToast(null);
  };

  const handleUndo = async () => {
    if (!toast) return;
    setUndoing(true);
    setUndoError(null);
    try {
      await toast.onUndo();
      setToast(current => (current?.id === toast.id ? null : current));
    } catch (error) {
      setUndoError(getErrorMessage(error));
    } finally {
      setUndoing(false);
    }
  };

  return (
    <UndoToastContext.Provider value={show}>
      {children}
      {toast && (
        <Snackbar
          key={toast.id}
          open
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          autoHideDuration={undoing ? null : UNDO_TOAST_DURATION_MS}
          onClose={(_event, reason) => {
            if (reason !== 'clickaway') dismiss();
          }}
          variant="solid"
          color="neutral"
          role="status"
          data-testid="undo-toast"
          sx={adminFocusScope}
        >
          <Stack gap={0.5} sx={{ minWidth: 0 }}>
            <Typography level="body-sm" textColor="inherit" data-testid="undo-toast-message">
              {toast.message}
            </Typography>
            {undoError && (
              <Typography level="body-xs" textColor="inherit" role="alert" data-testid="undo-toast-error">
                {undoError}
              </Typography>
            )}
          </Stack>
          <Stack direction="row" gap={1} sx={{ ml: 'auto' }}>
            {toast.onViewAudit && (
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                onClick={toast.onViewAudit}
                sx={{ color: 'inherit' }}
                data-testid="undo-toast-audit-btn"
              >
                View audit entry
              </Button>
            )}
            <Button
              size="sm"
              variant="soft"
              color="neutral"
              loading={undoing}
              onClick={() => void handleUndo()}
              data-testid="undo-toast-undo-btn"
            >
              Undo
            </Button>
          </Stack>
        </Snackbar>
      )}
    </UndoToastContext.Provider>
  );
};

/** Returns `showUndoToast`. Must be used under `UndoToastProvider` (mounted by `AdminPage`). */
export const useUndoToast = (): ShowUndoToast => {
  const show = useContext(UndoToastContext);
  if (!show) throw new Error('useUndoToast must be used within an UndoToastProvider');
  return show;
};
