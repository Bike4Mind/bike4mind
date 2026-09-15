import React from 'react';
import { Box, List, ListItem, ListItemButton, Typography } from '@mui/joy';
import type { HelpHeading } from '@bike4mind/scripts/help/types';

interface HelpTOCProps {
  headings: HelpHeading[];
  currentAnchor?: string;
}

/**
 * Table of Contents component for help articles
 * Displays a hierarchical list of headings that can be clicked to navigate
 */
const HelpTOC: React.FC<HelpTOCProps> = ({ headings, currentAnchor }) => {
  // Filter to only show h2 and h3 for a cleaner TOC
  const tocHeadings = headings.filter(h => h.level >= 2 && h.level <= 3);

  if (tocHeadings.length === 0) {
    return null;
  }

  const handleClick = (anchor: string) => {
    const element = document.getElementById(anchor);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <Box sx={{ py: 2 }}>
      <Typography
        level="body-xs"
        sx={{
          px: 2,
          pb: 1,
          fontWeight: 'bold',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'text.tertiary',
        }}
      >
        On this page
      </Typography>

      <List size="sm" sx={{ '--ListItem-paddingY': '2px' }}>
        {tocHeadings.map((heading, index) => {
          const isActive = currentAnchor === heading.anchor;
          const indent = (heading.level - 2) * 12;

          return (
            <ListItem key={`${heading.anchor}-${index}`} sx={{ pl: indent / 8 + 1 }}>
              <ListItemButton
                onClick={() => handleClick(heading.anchor)}
                sx={{
                  py: 0.5,
                  px: 1.5,
                  borderLeft: '2px solid',
                  borderColor: isActive ? 'primary.500' : 'transparent',
                  backgroundColor: isActive ? 'primary.softBg' : 'transparent',
                  borderRadius: 0,
                  '&:hover': {
                    borderColor: 'primary.300',
                  },
                }}
              >
                <Typography
                  level="body-xs"
                  sx={{
                    color: isActive ? 'primary.600' : 'text.secondary',
                    fontWeight: isActive ? 'md' : 'normal',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {heading.text}
                </Typography>
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>
    </Box>
  );
};

export default HelpTOC;
