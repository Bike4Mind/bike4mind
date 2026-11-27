import React from 'react';
import { Button, Chip, Stack, Typography } from '@mui/joy';
import LaunchIcon from '@mui/icons-material/Launch';

import { DocumentationItem, documentationCategoryLabel } from '../utils/docData';
import { openInNewTab } from '@client/app/utils/externalLinks';
import { SectionCard } from '../../shared';

interface DocSectionProps {
  doc: DocumentationItem;
}

const VISIBLE_TAGS = 3;

export const DocSection: React.FC<DocSectionProps> = ({ doc }) => (
  <SectionCard
    title={doc.title}
    body="custom"
    data-testid={`documentation-doc-${doc.id}`}
    action={
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        endDecorator={<LaunchIcon />}
        onClick={() => openInNewTab(doc.docusaurusUrl)}
        aria-label={`Open ${doc.title} in Docusaurus`}
        data-testid={`documentation-doc-${doc.id}-open-btn`}
        sx={{ whiteSpace: 'nowrap' }}
      >
        Open
      </Button>
    }
  >
    <Stack gap={1.5} sx={{ p: 2 }}>
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
        {doc.description}
      </Typography>
      <Stack direction="row" flexWrap="wrap" gap={0.5}>
        <Chip size="sm" variant="soft" color="neutral" data-testid={`documentation-doc-${doc.id}-category`}>
          {documentationCategoryLabel(doc.category)}
        </Chip>
        {doc.tags.slice(0, VISIBLE_TAGS).map(tag => (
          <Chip key={tag} size="sm" variant="outlined" color="neutral">
            {tag}
          </Chip>
        ))}
        {doc.tags.length > VISIBLE_TAGS && (
          <Chip size="sm" variant="outlined" color="neutral">
            +{doc.tags.length - VISIBLE_TAGS} more
          </Chip>
        )}
      </Stack>
    </Stack>
  </SectionCard>
);
