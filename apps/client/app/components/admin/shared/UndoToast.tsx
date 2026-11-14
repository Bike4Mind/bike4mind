import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Button, Snackbar, Stack, Typography } from '@mui/joy';
import { getErrorMessage } from '@client/app/utils/error';
import { adminFocusScope } from './adminStyles';

export const UNDO_TOAST_DURATION_MS = 30_000;

export type UndoToastOptions = {
  message: string;
  /** The reverse write. It must record its own audit entry; the toast adds no undo semantics. Omit when the
   * write cannot be reversed: the toast then shows no Undo button. */
  onUndo?: () => void | Promise<void>;
  /** Opens the audit entry for the write being offered for undo. */
  onViewAudit?: () => void;
  /** The audit entry's URL, opened in a new tab so leaving for it cannot drop this toast's Undo. Used over onViewAudit. */
  auditHref?: string;
};

const AUDIT_BUTTON_SX = { color: 'inherit', flexShrink: 0, whiteSpace: 'nowrap' } as const;

/** Shows the toast, replacing any other, and returns its id. */
type ShowUndoToast = (options: UndoToastOptions) => number;
/** Whether the toast with this id is still the one on screen. */
type IsUndoToastCurrent = (id: number | null) => boolean;

const UndoToastContext = createContext<{ show: ShowUndoToast; isCurrent: IsUndoToastCurrent } | null>(null);
// Apart from the stable show/isCurrent, so a toast coming and going re-renders only the readers of this.
const UndoOfferedContext = createContext(false);

/** Bottom-center recovery toast for admin writes. One at a time: showing a new one replaces the last. */
export const UndoToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toast, setToast] = useState<(UndoToastOptions & { id: number }) | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const nextId = useRef(0);
  // Read synchronously by isCurrent and by an undo that settles after a newer toast took its place.
  const currentId = useRef<number | null>(null);

  const show = useCallback<ShowUndoToast>(options => {
    nextId.current += 1;
    currentId.current = nextId.current;
    setToast({ ...options, id: nextId.current });
    setUndoing(false);
    setUndoError(null);
    return nextId.current;
  }, []);
  const isCurrent = useCallback<IsUndoToastCurrent>(id => id !== null && currentId.current === id, []);
  const api = useMemo(() => ({ show, isCurrent }), [show, isCurrent]);

  const dismiss = () => {
    if (undoing) return;
    currentId.current = null;
    setToast(null);
  };

  const handleUndo = async () => {
    if (!toast?.onUndo) return;
    const { id } = toast;
    setUndoing(true);
    setUndoError(null);
    try {
      await toast.onUndo();
      if (currentId.current === id) {
        currentId.current = null;
        setToast(null);
      }
    } catch (error) {
      // A newer toast may have replaced this one mid-undo; its failure must not land on that toast.
      if (currentId.current === id) setUndoError(getErrorMessage(error));
    } finally {
      if (currentId.current === id) setUndoing(false);
    }
  };

  return (
    <UndoToastContext.Provider value={api}>
      <UndoOfferedContext.Provider value={!!toast?.onUndo}>{children}</UndoOfferedContext.Provider>
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
          sx={{ ...adminFocusScope, flexWrap: 'wrap', rowGap: 1 }}
        >
          <Stack gap={0.5} sx={{ flex: '1 1 12rem', minWidth: 0 }}>
            <Typography level="body-sm" textColor="inherit" data-testid="undo-toast-message">
              {toast.message}
            </Typography>
            {undoError && (
              <Typography level="body-xs" textColor="inherit" role="alert" data-testid="undo-toast-error">
                {undoError}
              </Typography>
            )}
          </Stack>
          <Stack direction="row" gap={1} sx={{ ml: 'auto', flexShrink: 0 }}>
            {toast.auditHref ? (
              <Button
                component="a"
                href={toast.auditHref}
                target="_blank"
                rel="noopener noreferrer"
                size="sm"
                variant="plain"
                color="neutral"
                sx={AUDIT_BUTTON_SX}
                data-testid="undo-toast-audit-btn"
              >
                View audit entry
              </Button>
            ) : (
              toast.onViewAudit && (
                <Button
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={toast.onViewAudit}
                  sx={AUDIT_BUTTON_SX}
                  data-testid="undo-toast-audit-btn"
                >
                  View audit entry
                </Button>
              )
            )}
            {toast.onUndo && (
              <Button
                size="sm"
                variant="soft"
                color="neutral"
                loading={undoing}
                sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                onClick={() => void handleUndo()}
                data-testid="undo-toast-undo-btn"
              >
                Undo
              </Button>
            )}
          </Stack>
        </Snackbar>
      )}
    </UndoToastContext.Provider>
  );
};

/** Returns `showUndoToast`. Must be used under `UndoToastProvider` (mounted by `AdminPage`). */
export const useUndoToast = (): ShowUndoToast => {
  const api = useContext(UndoToastContext);
  if (!api) throw new Error('useUndoToast must be used within an UndoToastProvider');
  return api.show;
};

/** Returns `isUndoToastCurrent`, for a caller whose undo may settle after a newer toast replaced its own. */
export const useUndoToastIsCurrent = (): IsUndoToastCurrent => {
  const api = useContext(UndoToastContext);
  if (!api) throw new Error('useUndoToastIsCurrent must be used within an UndoToastProvider');
  return api.isCurrent;
};

/** Whether the toast on screen offers Undo: leaving the page now would drop it and the writes it can still revert. */
export const useUndoToastOffersUndo = (): boolean => useContext(UndoOfferedContext);
