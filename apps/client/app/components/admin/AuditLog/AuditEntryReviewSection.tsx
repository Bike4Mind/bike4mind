import { useState } from 'react';
import { Button, Skeleton, Stack, Textarea, Typography } from '@mui/joy';
import { AUDIT_REVIEW_NOTE_MAX, auditReviewConflict, isFullAdmin, type AuditEntry } from '@bike4mind/common';
import { useAuditReview, useMarkAuditReviewed, useUnmarkAuditReviewed } from '@client/app/hooks/data/adminAuditLog';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';

type AuditEntryReviewSectionProps = { entry: AuditEntry };

/** Sign-off controls for one critical entry, shown in the entry drawer. */
export const AuditEntryReviewSection: React.FC<AuditEntryReviewSectionProps> = ({ entry }) => {
  const { currentUser } = useUser();
  const impersonating = useAccessToken(s => s.impersonating);
  const { data: review, isLoading } = useAuditReview(entry.id);
  const mark = useMarkAuditReviewed();
  const unmark = useUnmarkAuditReviewed();
  const [note, setNote] = useState('');

  if (isLoading) return <Skeleton variant="text" level="body-sm" width="60%" data-testid="audit-review-loading" />;

  if (review) {
    // Case-insensitive, like the server's undo check.
    const reviewerId = review.reviewer.userId?.toLowerCase();
    const isMine = !!reviewerId && reviewerId === currentUser?.id.toLowerCase();
    return (
      <Stack spacing={1} data-testid="audit-review-reviewed">
        <Typography level="body-sm">
          {review.baseline
            ? 'Baselined at rollout'
            : `Reviewed by ${review.reviewer.name}, ${relativeTimeFormat(review.reviewedAt)}`}
        </Typography>
        {review.note && <Typography level="body-sm">{review.note}</Typography>}
        {isMine && (
          <Button
            variant="plain"
            size="sm"
            loading={unmark.isPending}
            onClick={() => unmark.mutate({ entryIds: [entry.id] })}
            data-testid="audit-review-undo-btn"
            sx={{ alignSelf: 'flex-start' }}
          >
            Undo review
          </Button>
        )}
      </Stack>
    );
  }

  const conflict = currentUser ? auditReviewConflict(entry, currentUser.id) : null;
  if (conflict) {
    return (
      <Typography
        level="body-sm"
        data-testid={`audit-review-${conflict === 'own_action' ? 'own-action' : 'about-you'}`}
      >
        {conflict === 'own_action'
          ? 'You performed this action. Another admin needs to review it.'
          : 'This entry is about your account. Another admin needs to review it.'}
      </Typography>
    );
  }

  if (impersonating || !isFullAdmin(currentUser)) {
    return (
      <Typography level="body-sm" data-testid="audit-review-not-allowed">
        {impersonating
          ? 'Stop impersonating to review audit entries.'
          : 'Only full admins can sign off on critical entries.'}
      </Typography>
    );
  }

  return (
    <Stack spacing={1}>
      <Textarea
        minRows={2}
        maxRows={5}
        value={note}
        onChange={event => setNote(event.target.value)}
        placeholder="Add a note (optional)"
        slotProps={{ textarea: { maxLength: AUDIT_REVIEW_NOTE_MAX, 'data-testid': 'audit-review-note-input' } }}
      />
      <Button
        loading={mark.isPending}
        onClick={() => mark.mutate({ entryIds: [entry.id], note: note.trim() || undefined })}
        data-testid="audit-review-mark-btn"
        sx={{ alignSelf: 'flex-start' }}
      >
        Mark as reviewed
      </Button>
    </Stack>
  );
};
