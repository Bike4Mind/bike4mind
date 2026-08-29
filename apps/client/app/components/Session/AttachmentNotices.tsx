import { FC } from 'react';
import { Box, List, ListItem, Typography } from '@mui/joy';
import { WarningAmberRounded as WarningIcon } from '@mui/icons-material';

interface AttachmentNoticesProps {
  attachmentNotices?: string[];
}

/**
 * Per-file warnings for attachments that did not arrive intact on this turn. The same lines are
 * given to the model, so the reply and this banner agree - the point is that a dropped attachment is
 * never silent, which is how one used to look identical to never having been attached.
 */
const AttachmentNotices: FC<AttachmentNoticesProps> = ({ attachmentNotices }) => {
  if (!attachmentNotices || attachmentNotices.length === 0) return null;

  return (
    <Box
      data-testid="attachment-notices-list"
      sx={{
        mt: 1.5,
        p: 1.5,
        borderRadius: 'md',
        border: '1px solid',
        borderColor: 'warning.outlinedBorder',
        bgcolor: 'warning.softBg',
        maxHeight: 220,
        overflowY: 'auto',
      }}
    >
      <Typography
        level="body-xs"
        startDecorator={<WarningIcon sx={{ fontSize: 16 }} />}
        sx={{ mb: 0.5, fontWeight: 600 }}
      >
        Some attachments did not reach the model
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
