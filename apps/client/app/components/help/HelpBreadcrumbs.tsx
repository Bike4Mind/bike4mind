import React from 'react';
import { Breadcrumbs, Link, Typography } from '@mui/joy';
import HomeIcon from '@mui/icons-material/Home';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import type { HelpIndexEntry } from '@bike4mind/scripts/help/types';

interface HelpBreadcrumbsProps {
  entry: HelpIndexEntry;
  onNavigate: (slug: string) => void;
  onCategoryClick?: (category: string) => void;
}

/**
 * Convert category path to display label
 */
const categoryToLabel = (category: string): string => {
  return category
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/**
 * Breadcrumb navigation component for help articles
 * Shows: Home > Category > Article Title
 */
const HelpBreadcrumbs: React.FC<HelpBreadcrumbsProps> = ({ entry, onNavigate, onCategoryClick }) => {
  const categoryPath = entry.category.split('/').filter(Boolean);

  return (
    <Breadcrumbs
      separator={<ChevronRightIcon sx={{ fontSize: 14 }} />}
      size="sm"
      sx={{
        fontSize: 'xs',
        '--Breadcrumbs-gap': '4px',
      }}
    >
      {/* Home link */}
      <Link
        component="button"
        onClick={() => onNavigate('index')}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          color: 'text.tertiary',
          textDecoration: 'none',
          '&:hover': {
            color: 'primary.500',
            textDecoration: 'underline',
          },
        }}
      >
        <HomeIcon sx={{ fontSize: 14 }} />
        <Typography level="body-xs">Help</Typography>
      </Link>

      {/* Category breadcrumbs */}
      {categoryPath.map((cat, index) => {
        const isLast = index === categoryPath.length - 1 && !entry.title;

        if (isLast) {
          return (
            <Typography key={cat} level="body-xs" sx={{ color: 'text.primary' }}>
              {categoryToLabel(cat)}
            </Typography>
          );
        }

        if (onCategoryClick) {
          return (
            <Link
              key={cat}
              component="button"
              onClick={() => onCategoryClick(cat)}
              sx={{
                color: 'text.tertiary',
                textDecoration: 'none',
                '&:hover': {
                  color: 'primary.500',
                  textDecoration: 'underline',
                },
              }}
            >
              <Typography level="body-xs">{categoryToLabel(cat)}</Typography>
            </Link>
          );
        }

        return (
          <Typography key={cat} level="body-xs" sx={{ color: 'text.tertiary' }}>
            {categoryToLabel(cat)}
          </Typography>
        );
      })}

      {/* Current article */}
      <Typography
        level="body-xs"
        sx={{
          color: 'text.primary',
          fontWeight: 'md',
          maxWidth: 200,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.title}
      </Typography>
    </Breadcrumbs>
  );
};

export default HelpBreadcrumbs;
