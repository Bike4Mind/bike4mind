import { Box, Chip, Typography } from '@mui/joy';
import FolderIcon from '@mui/icons-material/Folder';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import { FC } from 'react';
import { TagNode } from './parseTagNamespace';
import { getTagColor } from './tagColors';

interface TagCardProps {
  node: TagNode;
  onClick: () => void;
}

const TagCard: FC<TagCardProps> = ({ node, onClick }) => {
  const hasChildren = node.children.length > 0;
  const accentColor = getTagColor(node.fullPath);

  return (
    <Box
      data-testid={`tag-card-${node.fullPath}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label={`${node.segment} — ${node.fileCount} files${hasChildren ? ', has subcategories' : ''}`}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        padding: '12px 16px',
        borderRadius: '8px',
        border: '1px solid',
        borderColor: 'neutral.outlinedBorder',
        backgroundColor: 'background.surface',
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        '&:hover, &:focus-visible': {
          borderColor: accentColor,
          boxShadow: `0 0 0 1px ${accentColor}20`,
          transform: 'translateY(-1px)',
        },
        '&:focus-visible': {
          outline: `2px solid ${accentColor}`,
          outlineOffset: 2,
        },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: '8px',
          backgroundColor: `${accentColor}15`,
          color: accentColor,
          flexShrink: 0,
        }}
      >
        {hasChildren ? <FolderIcon fontSize="small" /> : <LocalOfferIcon fontSize="small" />}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          level="title-sm"
          sx={{
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {node.segment}
        </Typography>
      </Box>

      <Chip
        size="sm"
        variant="soft"
        sx={{
          fontWeight: 600,
          fontSize: '11px',
          minWidth: '28px',
          justifyContent: 'center',
          backgroundColor: `${accentColor}15`,
          color: accentColor,
        }}
      >
        {node.fileCount}
      </Chip>
    </Box>
  );
};

export default TagCard;
