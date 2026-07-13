import React from 'react';
import { Box, Typography } from '@mui/joy';
import { GridView as LatticeIcon } from '@mui/icons-material';
import type { LatticeArtifact } from '@bike4mind/common';
import ArtifactPreviewCard from '@client/app/components/GenAI/ArtifactPreviewCard';
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
        sx={{ p: 2, border: '1px solid', borderColor: 'danger.300', borderRadius: 'sm' }}
      >
        <Typography level="body-sm" color="danger">
          Error rendering financial model: Invalid artifact data
        </Typography>
      </Box>
    );
  }

  const { artifact: model } = result;
  const { entityCount, ruleCount, currency, modelType } = model.metadata;

  return (
    <Box key={index} data-testid={`artifact-preview-lattice-${model.id}`}>
      <ArtifactPreviewCard
        artifactId={model.id}
        artifactType="lattice"
        mimeType="application/vnd.b4m.lattice"
        artifactContent={model}
        title={model.title}
        icon={<LatticeIcon color="success" sx={{ fontSize: '16px' }} />}
        chipLabel={modelType || 'Financial Model'}
        chipColor="success"
        testIdPrefix="lattice"
        source={model.content}
        copyTooltip="Copy model to clipboard"
        copyMessage="Financial model copied to clipboard"
        saveTooltip="Save model as file"
        saveFile={() => ({
          fileName: `${model.title.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.json`,
          mimeType: 'application/json',
          successMessage: 'Saved financial model as file',
        })}
        actions={{ copy: true, save: true }}
        // No inline render: the model is an editable spreadsheet and belongs in the
        // side panel, not the chat stream.
        stats={
          <>
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              {entityCount || 0} entities, {ruleCount || 0} rules
            </Typography>
            {currency && (
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                {currency}
              </Typography>
            )}
          </>
        }
      />
    </Box>
  );
};

registerArtifactType({ type: 'lattice', PreviewCard: LatticePreviewCard });
