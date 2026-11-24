import { useEffect, useRef, useState } from 'react';
import { Box, Button, FormControl, FormLabel, Input, Option, Select, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import {
  FeedbackStatus,
  FEEDBACK_RESOLUTIONS,
  FEEDBACK_RESOLUTION_LABELS,
  type FeedbackResolution,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import { ActionDialog, BulkActionBar } from '../shared';
import { adminBulkBarZIndex } from '../shared/adminStyles';
import type { AdminSelection } from '../shared/BulkActionBar';
import type { FeedbackListFilterParams } from './types';
import { FEEDBACK_STATUS_LABELS, FEEDBACK_STATUS_ORDER } from './constants';
import { FEEDBACK_BULK_MAX_REPORTS, type FeedbackBulkChange, type FeedbackBulkResponse } from './feedbackBulk';

// px. Sized for the AI Chat pill (FloatingChatPill) at its default spot, 20 px from the bottom-right corner and
// 40 px tall; it is draggable, so a moved pill is not accounted for.
const CHAT_PILL_BAND = 60;
const BULK_BAR_STICKY_BOTTOM = 8;
const ROW_SCROLL_GAP = 16;

/** Bottom scroll margin (px) that keeps a row focused by j/k clear of the sticky bulk bar and the chat pill. */
export function feedbackRowScrollClearance(bulkBarHeight: number) {
  const barBand = bulkBarHeight > 0 ? bulkBarHeight + BULK_BAR_STICKY_BOTTOM : 0;
  return Math.max(barBand, CHAT_PILL_BAND) + ROW_SCROLL_GAP;
}

// Chrome pins a sticky box inside its scroll container's padding, so a stuck bar sits that
// padding above the scrollport edge that a row's scroll-margin is measured from.
function scrollerPaddingBottom(node: HTMLElement) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/auto|scroll/.test(style.overflowY)) return parseFloat(style.paddingBottom) || 0;
  }
  return 0;
}

export default function FeedbackBulkActions({
  selection,
  filters,
  total,
  disabled,
  onSelectionChange,
  onApplied,
  onHeightChange,
}: {
  selection: AdminSelection;
  filters: FeedbackListFilterParams;
  total: number;
  disabled: boolean;
  onSelectionChange: (selection: AdminSelection) => void;
  onApplied: () => Promise<void>;
  /** Reports the sticky bar's height plus its scroll container's bottom padding in px, 0 while nothing is selected. */
  onHeightChange?: (height: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const hasSelection = selection.mode === 'allMatching' ? total > 0 : selection.ids.length > 0;
  useEffect(() => {
    const node = barRef.current;
    if (!node || !onHeightChange) return;
    const observer = new ResizeObserver(([entry]) =>
      onHeightChange(entry.contentRect.height + scrollerPaddingBottom(node))
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      onHeightChange(0);
    };
  }, [hasSelection, onHeightChange]);
  const [action, setAction] = useState<'status' | 'delete' | null>(null);
  const [status, setStatus] = useState(FeedbackStatus.Closed);
  const [resolution, setResolution] = useState<FeedbackResolution | null>(null);
  const [duplicateId, setDuplicateId] = useState('');
  const [preview, setPreview] = useState<FeedbackBulkResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change: FeedbackBulkChange =
    action === 'delete'
      ? { action: 'delete' }
      : {
          action: 'status',
          status,
          ...(status === FeedbackStatus.Closed && resolution ? { resolution } : {}),
          ...(status === FeedbackStatus.Closed && resolution === 'duplicate'
            ? { resolutionDuplicateId: duplicateId.trim() }
            : {}),
        };
  const requestSelection = selection.mode === 'explicit' ? selection : { ...selection, filters };
  const resetPreview = () => {
    setPreview(null);
    setError(null);
  };
  const close = () => {
    setAction(null);
    resetPreview();
  };
  const invalid =
    status === FeedbackStatus.Closed &&
    action === 'status' &&
    (!resolution || (resolution === 'duplicate' && !/^[a-f\d]{24}$/i.test(duplicateId.trim())));
  const run = async (reason?: string) => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post<FeedbackBulkResponse>('/api/feedback/bulk', {
        selection: requestSelection,
        change,
        preview: reason === undefined,
        ...(reason !== undefined ? { reason, expectedCount: preview?.count, fingerprint: preview?.fingerprint } : {}),
      });
      if (reason === undefined) setPreview(data);
      else {
        toast.success(`${data.count} reports ${action === 'delete' ? 'deleted' : 'updated'}`);
        close();
        onSelectionChange({ mode: 'explicit', ids: [] });
        await onApplied();
      }
    } catch (caught) {
      setError(getErrorMessage(caught));
      setPreview(null);
      if (reason !== undefined) throw caught;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {hasSelection && (
        // Left-aligned and kept short of the right edge so the AI Chat pill, at its default spot, does not
        // cover its buttons.
        <Box
          ref={barRef}
          data-testid="feedback-bulk-bar-wrapper"
          sx={{
            position: 'sticky',
            bottom: BULK_BAR_STICKY_BOTTOM,
            zIndex: adminBulkBarZIndex,
            alignSelf: 'flex-start',
            maxWidth: 'calc(100% - 9rem)',
          }}
        >
          <BulkActionBar
            selection={selection}
            totalMatching={total}
            onSelectAllMatching={() => onSelectionChange({ mode: 'allMatching' })}
            onClear={() => onSelectionChange({ mode: 'explicit', ids: [] })}
          >
            <Button disabled={disabled} onClick={() => setAction('status')} data-testid="feedback-bulk-status-btn">
              Set status
            </Button>
            <Button
              disabled={disabled}
              variant="outlined"
              color="danger"
              onClick={() => setAction('delete')}
              data-testid="feedback-bulk-delete-btn"
            >
              Delete
            </Button>
          </BulkActionBar>
        </Box>
      )}
      {action && (
        <ActionDialog
          open
          onClose={close}
          title={action === 'delete' ? 'Delete selected feedback' : 'Set feedback status'}
          description={`Preview the reports that will change. Each batch is limited to ${FEEDBACK_BULK_MAX_REPORTS} reports.${action === 'delete' ? ' Deletion cannot be undone.' : ''}`}
          reasonPresets={action === 'delete' ? ['Spam or abuse', 'Test submission'] : ['Resolved after review']}
          confirmLabel={action === 'delete' ? 'Delete reports' : 'Apply status'}
          tone={action === 'delete' ? 'danger' : 'neutral'}
          typedConfirm={
            action === 'delete' && preview ? { expected: String(preview.count), noun: 'report count' } : undefined
          }
          blockedReason={
            invalid
              ? 'Choose a resolution and valid original report if needed.'
              : !preview
                ? 'Run a preview before applying.'
                : preview.count === 0
                  ? 'No reports would change.'
                  : null
          }
          pending={busy}
          onConfirm={reason => run(reason)}
          data-testid="feedback-bulk-dialog"
        >
          <Stack gap={1}>
            {action === 'status' && (
              <>
                <FormControl>
                  <FormLabel>Status</FormLabel>
                  <Select
                    value={status}
                    disabled={busy}
                    onChange={(_, value) => {
                      if (value) setStatus(value);
                      resetPreview();
                    }}
                    slotProps={{
                      button: { 'data-testid': 'feedback-bulk-status-select', 'aria-label': 'Status' },
                      listbox: { sx: { zIndex: 1500 } },
                    }}
                  >
                    {FEEDBACK_STATUS_ORDER.map(value => (
                      <Option key={value} value={value}>
                        {FEEDBACK_STATUS_LABELS[value]}
                      </Option>
                    ))}
                  </Select>
                </FormControl>
                {status === FeedbackStatus.Closed && (
                  <FormControl>
                    <FormLabel>Resolution</FormLabel>
                    <Select
                      value={resolution}
                      disabled={busy}
                      onChange={(_, value) => {
                        setResolution(value);
                        resetPreview();
                      }}
                      slotProps={{
                        button: { 'data-testid': 'feedback-bulk-resolution-select', 'aria-label': 'Resolution' },
                        listbox: { sx: { zIndex: 1500 } },
                      }}
                    >
                      {FEEDBACK_RESOLUTIONS.map(value => (
                        <Option key={value} value={value} data-testid={`feedback-bulk-resolution-${value}`}>
                          {FEEDBACK_RESOLUTION_LABELS[value]}
                        </Option>
                      ))}
                    </Select>
                  </FormControl>
                )}
                {status === FeedbackStatus.Closed && resolution === 'duplicate' && (
                  <Input
                    value={duplicateId}
                    disabled={busy}
                    placeholder="Original report id"
                    onChange={event => {
                      setDuplicateId(event.target.value);
                      resetPreview();
                    }}
                    slotProps={{
                      input: { 'data-testid': 'feedback-bulk-original-input', 'aria-label': 'Original report id' },
                    }}
                  />
                )}
              </>
            )}
            <Button
              disabled={!!invalid || busy}
              variant="outlined"
              onClick={() => void run()}
              data-testid="feedback-bulk-preview-btn"
            >
              Preview changes
            </Button>
            {preview && (
              <Typography data-testid="feedback-bulk-preview-count">
                {preview.count} reports will {action === 'delete' ? 'be deleted' : 'change status'}.
              </Typography>
            )}
            {error && (
              <Typography color="danger" role="alert" data-testid="feedback-bulk-error">
                {error}
              </Typography>
            )}
          </Stack>
        </ActionDialog>
      )}
    </>
  );
}
