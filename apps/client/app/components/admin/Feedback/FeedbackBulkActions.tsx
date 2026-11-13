import { useState } from 'react';
import { Button, FormControl, FormLabel, Input, Option, Select, Stack, Typography } from '@mui/joy';
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
import type { AdminSelection } from '../shared/BulkActionBar';
import type { FeedbackListFilterParams } from './types';
import { FEEDBACK_STATUS_LABELS, FEEDBACK_STATUS_ORDER } from './constants';
import { FEEDBACK_BULK_MAX_REPORTS, type FeedbackBulkChange, type FeedbackBulkResponse } from './feedbackBulk';

export default function FeedbackBulkActions({
  selection,
  filters,
  total,
  disabled,
  onSelectionChange,
  onApplied,
}: {
  selection: AdminSelection;
  filters: FeedbackListFilterParams;
  total: number;
  disabled: boolean;
  onSelectionChange: (selection: AdminSelection) => void;
  onApplied: () => Promise<void>;
}) {
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
