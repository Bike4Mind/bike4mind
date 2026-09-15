import React, { useState } from 'react';
import { Box, Card, Typography, Chip, Stack, IconButton, Tooltip, Button } from '@mui/joy';
import { Edit, Visibility, ArrowForward } from '@mui/icons-material';
import ContentPreviewModal from '../ProfileModal/ContentPreviewModal';

interface TransformedContent {
  title: string;
  content: string;
  summary: string;
  suggestedTags: string[];
}

interface ContentTransformPreviewCardProps {
  data: TransformedContent;
}

/**
 * Inline preview card for a drafted blog post (emitted by the blog_draft tool).
 *
 * Design notes:
 * - One success accent rail is the only structural color; the title reads in
 *   `text.primary` ink so the headline leads instead of competing with green.
 * - The footer CTA is a solid `success` Button so its foreground/background pair
 *   is legible in both light and dark modes (avoids the `success.700`-on-near-black
 *   contrast bug).
 * - Two distinct intents: the pencil opens the modal straight in edit mode; the
 *   card / primary button open it in preview (review then publish).
 */
const ContentTransformPreviewCard: React.FC<ContentTransformPreviewCardProps> = ({ data }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [openInEdit, setOpenInEdit] = useState(false);

  const openPreview = () => {
    setOpenInEdit(false);
    setIsModalOpen(true);
  };

  const openEdit = () => {
    setOpenInEdit(true);
    setIsModalOpen(true);
  };

  const handleClose = () => setIsModalOpen(false);

  const wordCount = data.content.trim() ? data.content.trim().split(/\s+/).length : 0;

  return (
    <>
      <Card
        variant="outlined"
        data-testid="blog-draft-card"
        sx={{
          backgroundColor: 'background.level1',
          borderRadius: '10px',
          borderColor: 'neutral.outlinedBorder',
          position: 'relative',
          overflow: 'hidden', // clip the accent rail to the radius
          p: 0, // inner Box owns padding (avoids doubling Card's default)
          transition: 'box-shadow 0.2s ease-in-out, border-color 0.2s ease-in-out',
          // success accent rail: the only structural color, brightens on hover
          '&::before': {
            content: '""',
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: '3px',
            backgroundColor: 'success.solidBg',
            opacity: 0.65,
            transition: 'opacity 0.2s ease-in-out',
          },
          // The card itself is presentational (no whole-card onClick) so we don't nest
          // interactive controls inside a clickable region. The pencil + primary button
          // own the actions and are natively keyboard-accessible.
          '&:hover': {
            boxShadow: 'sm',
            borderColor: 'success.outlinedBorder',
            '&::before': { opacity: 1 },
          },
        }}
      >
        <Box sx={{ p: 1.5, pl: 2 }}>
          {/* Eyebrow: type + word count on the left, type chip on the right */}
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
            <Typography
              level="body-xs"
              sx={{
                color: 'text.tertiary',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                fontWeight: 'lg',
              }}
            >
              Blog Draft &middot; {wordCount.toLocaleString()} words
            </Typography>
            <Chip size="sm" variant="soft" color="success">
              Blog Post
            </Chip>
          </Stack>

          {/* Title (ink) + edit pencil */}
          <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mb: 0.75 }}>
            <Typography
              level="title-md"
              sx={{
                color: 'text.primary',
                fontWeight: 'lg',
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {data.title}
            </Typography>

            <Tooltip title="Edit draft" placement="top">
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                data-testid="blog-draft-edit-btn"
                onClick={e => {
                  e.stopPropagation();
                  openEdit();
                }}
                sx={{ opacity: 0.6, '&:hover': { opacity: 1 } }}
              >
                <Edit />
              </IconButton>
            </Tooltip>
          </Stack>

          {/* Summary */}
          <Typography
            level="body-sm"
            sx={{
              color: 'text.secondary',
              lineHeight: 1.55,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              mb: 1.25,
            }}
          >
            {data.summary}
          </Typography>

          {/* Tags */}
          {data.suggestedTags && data.suggestedTags.length > 0 && (
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
              {data.suggestedTags.slice(0, 3).map((tag, index) => (
                <Chip key={index} size="sm" variant="plain" color="neutral" sx={{ color: 'text.tertiary' }}>
                  {tag}
                </Chip>
              ))}
              {data.suggestedTags.length > 3 && (
                <Chip size="sm" variant="plain" color="neutral" sx={{ color: 'text.tertiary' }}>
                  +{data.suggestedTags.length - 3}
                </Chip>
              )}
            </Stack>
          )}

          {/* Primary action: solid button guarantees contrast in both modes */}
          <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
            <Button
              fullWidth
              size="sm"
              variant="solid"
              color="success"
              data-testid="blog-draft-preview-btn"
              startDecorator={<Visibility sx={{ fontSize: '16px' }} />}
              endDecorator={<ArrowForward sx={{ fontSize: '16px' }} />}
              onClick={e => {
                e.stopPropagation();
                openPreview();
              }}
            >
              Preview &amp; Publish
            </Button>
          </Box>
        </Box>
      </Card>

      {/* Content Preview Modal */}
      <ContentPreviewModal
        open={isModalOpen}
        onClose={handleClose}
        initialEditing={openInEdit}
        initialTitle={data.title}
        initialContent={data.content}
        initialSummary={data.summary}
        initialTags={data.suggestedTags}
      />
    </>
  );
};

export default ContentTransformPreviewCard;
