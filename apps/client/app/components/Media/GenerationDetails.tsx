import { GeneratedAssetMetadataSchema, type GeneratedAssetMetadata, type IFabFileDocument } from '@bike4mind/common';
import { Box, Stack, Typography } from '@mui/joy';
import React, { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { formatSecondsClock, stripLyricTimestamps } from './generationFormat';

/**
 * The generation record saveGeneratedAsset stamps on a file, or undefined for any other file. Parsed, not cast:
 * `sourceMetadata` is free-form per source type.
 */
export const readGenerationMetadata = (
  file: Pick<IFabFileDocument, 'sourceMetadata'>
): GeneratedAssetMetadata | undefined => {
  const parsed = GeneratedAssetMetadataSchema.safeParse(file.sourceMetadata?.generation);
  return parsed.success ? parsed.data : undefined;
};

const DetailRow: FC<{ label: string; testId: string; children: React.ReactNode; multiline?: boolean }> = ({
  label,
  testId,
  children,
  multiline = false,
}) => (
  <Box>
    <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
      {label}
    </Typography>
    <Typography
      level="body-sm"
      data-testid={testId}
      sx={multiline ? { whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' } : undefined}
    >
      {children}
    </Typography>
  </Box>
);

/** Prompt, model, length and lyrics of a generated file. Renders nothing for a file without a generation record. */
export const GenerationDetails: FC<{ file: Pick<IFabFileDocument, 'sourceMetadata'> }> = ({ file }) => {
  const { t } = useTranslation();
  const generation = readGenerationMetadata(file);
  if (!generation) return null;

  return (
    <Stack
      spacing={1.5}
      data-testid="generation-details"
      sx={{ p: 2, borderRadius: 'sm', backgroundColor: 'background.level1' }}
    >
      <Typography level="title-sm">{t('generation_details.title')}</Typography>
      <DetailRow label={t('generation_details.model')} testId="generation-details-model">
        {generation.modelId ?? generation.provider}
      </DetailRow>
      {generation.durationSeconds !== undefined && (
        <DetailRow label={t('generation_details.duration')} testId="generation-details-duration">
          {formatSecondsClock(generation.durationSeconds)}
        </DetailRow>
      )}
      <DetailRow label={t('generation_details.prompt')} testId="generation-details-prompt" multiline>
        {generation.prompt}
      </DetailRow>
      {generation.lyrics && (
        <DetailRow label={t('generation_details.lyrics')} testId="generation-details-lyrics" multiline>
          {stripLyricTimestamps(generation.lyrics)}
        </DetailRow>
      )}
    </Stack>
  );
};

export default GenerationDetails;
