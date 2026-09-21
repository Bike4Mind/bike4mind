import React, { useState } from 'react';
import { Box, Card, Typography, Chip, Stack, IconButton, Tooltip } from '@mui/joy';
import { Edit } from '@mui/icons-material';
import ContentPreviewModal from '../ProfileModal/ContentPreviewModal';
import { actionButtonSx } from '@client/app/components/common/actionButtonSx';
import { brand } from '@client/app/utils/themes/themePrimitives';

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
 * Built to the same anatomy as ArtifactPreviewCard - overhanging type badge, title with
 * its small print beneath, actions trailing on the same row - because a draft sits in the
 * transcript beside artifact cards and used to be the one card that read as a different
 * component. It had its own green accent rail, a second type chip on the right saying
 * roughly what the badge says, and a full-width Preview & Publish button.
 *
 * Clicking the card opens the review modal, which is where publishing lives; the pencil
 * opens the same modal straight in edit mode.
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
        sx={theme => ({
          // The artifact-card recipe, shared so a blog draft reads as the same family as
          // every other card a reply produces. surface2 rather than background.level1,
          // which this theme never defines - it used to resolve to a Joy default that
          // matched nothing else in the transcript.
          backgroundColor: theme.palette.reading.cardBase,
          backgroundImage: `linear-gradient(180deg, ${theme.palette.reading.cardTintTop}, ${theme.palette.reading.cardTintBottom})`,
          borderRadius: '8px',
          position: 'relative',
          overflow: 'visible',
          borderWidth: 1,
          borderColor: theme.palette.reading.cardLine,
          transition: 'all 0.2s ease-in-out',
          cursor: 'pointer',
          '&:hover': {
            transform: 'translateY(-2px)',
            boxShadow: 'sm',
          },
        })}
        onClick={openPreview}
      >
        {/* Type badge overhanging the top-left corner, as every artifact card has. */}
        <Chip
          size="sm"
          variant="solid"
          data-testid="blog-draft-badge"
          sx={theme => ({
            position: 'absolute',
            top: '-8px',
            left: '16px',
            zIndex: 1,
            backgroundColor: brand[800],
            color: 'text.primary',
            border: 'none',
            paddingInline: '8px',
            '&:hover': { backgroundColor: brand[800] },
            // Light mode's text.primary is near-black and unreadable on the blue pill.
            [theme.getColorSchemeSelector('light')]: { color: '#fff' },
          })}
        >
          {/* Escaped bullet: added lines are ASCII-only (see CLAUDE.md), and an escape
              stays greppable in review. */}
          {`Blog draft \u2022 ${wordCount.toLocaleString()} words`}
        </Chip>

        <Box>
          {/* Title and its small print are one block, so the trailing control centres
              against the pair rather than the title alone - as in ArtifactPreviewCard. */}
          <Stack direction="row" spacing={1} alignItems="center">
            <Stack sx={{ minWidth: 0 }}>
              <Typography
                level="title-md"
                sx={{
                  color: 'text.primary',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {data.title}
              </Typography>
              {data.summary && (
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
                  }}
                >
                  {data.summary}
                </Typography>
              )}
            </Stack>

            <Box sx={{ flex: 1 }} />

            <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
              <Tooltip title="Edit draft" placement="top">
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  sx={actionButtonSx}
                  data-testid="blog-draft-edit-btn"
                  onClick={e => {
                    e.stopPropagation();
                    openEdit();
                  }}
                >
                  <Edit />
                </IconButton>
              </Tooltip>
            </Box>
          </Stack>
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
