import React from 'react';
import { Card, Stack, Typography, Chip, Button, Box } from '@mui/joy';
import SettingsIcon from '@mui/icons-material/Settings';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import CodeIcon from '@mui/icons-material/Code';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import ApiIcon from '@mui/icons-material/Api';
import LaunchIcon from '@mui/icons-material/Launch';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';

import { DocumentationItem, DocumentationCategory } from '../utils/docData';

interface DocSectionProps {
  doc: DocumentationItem;
}

const categoryConfig: Record<DocumentationCategory, { icon: React.ReactNode; color: any }> = {
  'admin-settings': { icon: <SettingsIcon />, color: 'primary' },
  architecture: { icon: <AccountTreeIcon />, color: 'success' },
  development: { icon: <CodeIcon />, color: 'warning' },
  migration: { icon: <SwapHorizIcon />, color: 'danger' },
  api: { icon: <ApiIcon />, color: 'info' },
  agents: { icon: <CodeIcon />, color: 'primary' },
  features: { icon: <SettingsIcon />, color: 'success' },
  'client-side': { icon: <CodeIcon />, color: 'warning' },
  aws: { icon: <AccountTreeIcon />, color: 'info' },
  artifacts: { icon: <SettingsIcon />, color: 'primary' },
  security: { icon: <SwapHorizIcon />, color: 'danger' },
  databases: { icon: <ApiIcon />, color: 'info' },
  testing: { icon: <CodeIcon />, color: 'warning' },
  onboarding: { icon: <SettingsIcon />, color: 'success' },
  files: { icon: <AccountTreeIcon />, color: 'neutral' },
  tags: { icon: <LocalOfferIcon />, color: 'info' },
  general: { icon: <SettingsIcon />, color: 'neutral' },
};

export const DocSection: React.FC<DocSectionProps> = ({ doc }) => {
  const categoryInfo = categoryConfig[doc.category];

  const handleOpenDocumentation = () => {
    window.open(doc.docusaurusUrl, '_blank');
  };

  return (
    <Card
      variant="outlined"
      sx={{
        height: '100%',
        transition: 'all 0.2s',
        '&:hover': {
          boxShadow: 'md',
          transform: 'translateY(-2px)',
        },
      }}
    >
      <Stack spacing={2} sx={{ height: '100%' }}>
        {/* Header */}
        <Stack direction="row" alignItems="flex-start" spacing={2}>
          <Box sx={{ color: `${categoryInfo.color}.500` }}>{categoryInfo.icon}</Box>
          <Box sx={{ flex: 1 }}>
            <Typography level="title-md">{doc.title}</Typography>
            <Chip
              size="sm"
              variant="soft"
              color={categoryInfo.color}
              startDecorator={categoryInfo.icon}
              sx={{ mt: 0.5 }}
            >
              {doc.category
                .split('-')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ')}
            </Chip>
          </Box>
        </Stack>

        {/* Description */}
        <Typography level="body-sm" sx={{ flex: 1, color: 'text.secondary' }}>
          {doc.description}
        </Typography>

        {/* Tags */}
        {doc.tags.length > 0 && (
          <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ gap: 0.5 }}>
            {doc.tags.slice(0, 3).map(tag => (
              <Chip key={tag} size="sm" variant="outlined" color="neutral">
                {tag}
              </Chip>
            ))}
            {doc.tags.length > 3 && (
              <Chip size="sm" variant="outlined" color="neutral">
                +{doc.tags.length - 3} more
              </Chip>
            )}
          </Stack>
        )}

        {/* Action Button */}
        <Button variant="soft" size="sm" startDecorator={<LaunchIcon />} onClick={handleOpenDocumentation}>
          Open in Docusaurus
        </Button>
      </Stack>
    </Card>
  );
};
