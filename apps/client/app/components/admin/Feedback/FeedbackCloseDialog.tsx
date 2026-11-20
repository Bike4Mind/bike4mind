import { useState } from 'react';
import { FormControl, FormLabel, Input, Option, Select } from '@mui/joy';
import { FEEDBACK_RESOLUTIONS, FEEDBACK_RESOLUTION_LABELS, type FeedbackResolution } from '@bike4mind/common';
import { ActionDialog } from '../shared';
import type { UseFeedbackOperationsReturn } from './types';

export default function FeedbackCloseDialog({
  feedbackId,
  onClose,
  onConfirm,
}: {
  feedbackId: string;
  onClose: () => void;
  onConfirm: UseFeedbackOperationsReturn['confirmClose'];
}) {
  const [resolution, setResolution] = useState<FeedbackResolution | null>(null);
  const [duplicateId, setDuplicateId] = useState('');
  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Close feedback"
      description="Choose how this report was resolved."
      reasonPresets={['Resolved after review']}
      confirmLabel="Close feedback"
      data-testid="feedback-close-dialog"
      blockedReason={
        !resolution
          ? 'Choose a resolution.'
          : resolution === 'duplicate' && !/^[a-f\d]{24}$/i.test(duplicateId.trim())
            ? 'Enter a valid original report id.'
            : resolution === 'duplicate' && duplicateId.trim().toLowerCase() === feedbackId.toLowerCase()
              ? 'Choose another report as the original.'
              : null
      }
      onConfirm={reason =>
        onConfirm({
          resolution: resolution!,
          reason,
          ...(resolution === 'duplicate' ? { resolutionDuplicateId: duplicateId.trim() } : {}),
        })
      }
    >
      <FormControl>
        <FormLabel>Resolution</FormLabel>
        <Select
          value={resolution}
          onChange={(_, value) => setResolution(value)}
          slotProps={{
            button: { 'data-testid': 'feedback-close-resolution-select', 'aria-label': 'Resolution' },
            listbox: { sx: { zIndex: 1500 } },
          }}
        >
          {FEEDBACK_RESOLUTIONS.map(value => (
            <Option key={value} value={value}>
              {FEEDBACK_RESOLUTION_LABELS[value]}
            </Option>
          ))}
        </Select>
      </FormControl>
      {resolution === 'duplicate' && (
        <FormControl>
          <FormLabel>Original report id</FormLabel>
          <Input
            value={duplicateId}
            onChange={event => setDuplicateId(event.target.value)}
            slotProps={{ input: { 'data-testid': 'feedback-close-duplicate-input' } }}
          />
        </FormControl>
      )}
    </ActionDialog>
  );
}
