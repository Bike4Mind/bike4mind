import React from 'react';
import { Box, Stack, Chip, Typography } from '@mui/joy';
import { GridView as LatticeIcon } from '@mui/icons-material';
import type { LatticeArtifact } from '@bike4mind/common';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

type ParseResult = { ok: true; artifact: LatticeArtifact } | { ok: false; error: unknown };

const buildLatticeArtifact = (content: string, title: string | undefined, fallbackId: string): ParseResult => {
  try {
    const latticeData = JSON.parse(content);
    const modelContent =
      typeof latticeData.content === 'string' ? JSON.parse(latticeData.content) : latticeData.content;

    // Use the original lattice ID from the data (e.g., "lattice_1767478742023_...")
    // This avoids the "artifact_" prefix which would trigger database fetch attempts
    const latticeId = latticeData.id || modelContent?.id || fallbackId;

    const artifact: LatticeArtifact = {
      id: latticeId,
      type: 'lattice' as const,
      title: title || latticeData.title || 'Financial Model',
      content: typeof modelContent === 'string' ? modelContent : JSON.stringify(modelContent),
      metadata: {
        modelType: latticeData.metadata?.modelType || modelContent?.modelType || 'custom',
        periodGrain: latticeData.metadata?.periodGrain || modelContent?.settings?.periodGrain || 'quarter',
        currency: latticeData.metadata?.currency || modelContent?.settings?.currency || 'USD',
        entityCount: latticeData.metadata?.entityCount || modelContent?.data?.entities?.length || 0,
        ruleCount: latticeData.metadata?.ruleCount || modelContent?.rules?.rules?.length || 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return { ok: true, artifact };
  } catch (error) {
    return { ok: false, error };
  }
};

const LatticePreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId, index }) => {
  const result = buildLatticeArtifact(artifact.content, artifact.title, artifactId);

  if (!result.ok) {
    console.error('Error parsing lattice artifact:', result.error);
    return (
      <Box
        key={index}
        data-testid="artifact-preview-lattice-error"
        sx={{ my: 2, p: 2, border: '1px solid', borderColor: 'danger.300', borderRadius: 'sm' }}
      >
        <Typography level="body-sm" color="danger">
          Error rendering financial model: Invalid artifact data
        </Typography>
      </Box>
    );
  }

  const { artifact: latticeArtifact } = result;

  return (
    <Box
      key={index}
      data-testid={`artifact-preview-lattice-${latticeArtifact.id}`}
      sx={{
        my: 2,
        cursor: 'pointer',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 'sm',
        p: 2,
        '&:hover': {
          bgcolor: 'background.level1',
        },
      }}
      onClick={() => {
        setSessionLayout({
          layout: 'vertical',
          artifactData: {
            type: 'lattice',
            content: latticeArtifact,
            mimeType: 'application/vnd.b4m.lattice',
            id: latticeArtifact.id,
          },
        });
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" mb={1}>
        <LatticeIcon sx={{ color: 'success.500', fontSize: '1.25rem' }} />
        <Typography level="body-sm">{latticeArtifact.title}</Typography>
        <Chip size="sm" variant="soft" color="success">
          {latticeArtifact.metadata?.modelType || 'Financial Model'}
        </Chip>
      </Stack>
      <Typography level="body-xs" color="neutral">
        {latticeArtifact.metadata?.entityCount || 0} entities, {latticeArtifact.metadata?.ruleCount || 0} rules
        {latticeArtifact.metadata?.currency && ` • ${latticeArtifact.metadata.currency}`}
      </Typography>
    </Box>
  );
};

registerArtifactType({ type: 'lattice', PreviewCard: LatticePreviewCard });
