import { FC } from 'react';
import { Box, List, ListItem, Typography } from '@mui/joy';
import { WarningAmberRounded as WarningIcon, InfoOutlined as InfoIcon } from '@mui/icons-material';
import type { IAttachmentDelivery } from '@bike4mind/common';

interface AttachmentNoticesProps {
  attachmentNotices?: string[];
  attachmentDelivery?: IAttachmentDelivery;
}

/**
 * "attached file" rather than "attachment" on purpose: on the chat door `requested` also counts the
 * session and system files inlined beside the turn's own attachments, so a denominator phrased as
 * what the caller just attached would overstate it.
 */
const files = (n: number) => `${n} attached file${n === 1 ? '' : 's'}`;

function heading(delivery?: IAttachmentDelivery): string {
  // Absent on every quest written before the field existed - keep the countless wording there
  // rather than rendering "0 of 0".
  if (!delivery) return 'Some attachments did not reach the model intact';
  if (delivery.dropped > 0) {
    return `${delivery.dropped} of ${files(delivery.requested)} did not reach the model intact`;
  }
  const partial = delivery.delivered - delivery.fullyDelivered;
  const arrived = `All ${files(delivery.requested)} reached the model`;
  return partial > 0 ? `${arrived}; ${partial} in part` : arrived;
}

/**
 * Per-file warnings for attachments that did not arrive intact on this turn, headed by the
 * requested-vs-delivered count. The same lines are given to the model, so the reply and this banner
 * agree - the point is that a dropped attachment is never silent, which is how one used to look
 * identical to never having been attached.
 */
const AttachmentNotices: FC<AttachmentNoticesProps> = ({ attachmentNotices, attachmentDelivery }) => {
  if (!attachmentNotices || attachmentNotices.length === 0) return null;

  // Nothing was refused, so the notices are truncation caveats: real, but not a failure to flag amber.
  const informational = attachmentDelivery !== undefined && attachmentDelivery.dropped === 0;

  return (
    <Box
      data-testid="attachment-notices-list"
      sx={{
        mt: 1.5,
        p: 1.5,
        borderRadius: 'md',
        border: '1px solid',
        borderColor: informational ? 'neutral.outlinedBorder' : 'warning.outlinedBorder',
        bgcolor: informational ? 'neutral.softBg' : 'warning.softBg',
        maxHeight: 220,
        overflowY: 'auto',
      }}
    >
      <Typography
        level="body-xs"
        data-testid="attachment-notices-heading"
        startDecorator={informational ? <InfoIcon sx={{ fontSize: 16 }} /> : <WarningIcon sx={{ fontSize: 16 }} />}
        sx={{ mb: 0.5, fontWeight: 600 }}
      >
        {heading(attachmentDelivery)}
      </Typography>
      <List size="sm" marker="disc" sx={{ '--ListItem-minHeight': '0px', py: 0 }}>
        {attachmentNotices.map((notice, index) => (
          <ListItem key={index} data-testid="attachment-notice-item">
            <Typography level="body-xs">{notice}</Typography>
          </ListItem>
        ))}
      </List>
    </Box>
  );
};

export default AttachmentNotices;
