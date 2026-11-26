import { FC } from 'react';
import { Alert, Box, Card, CircularProgress, Stack, Typography } from '@mui/joy';
import type { ISkillListingTemplate } from '@bike4mind/common';
import { useSkillTemplatePreviewHtml } from '@client/app/hooks/data/skillTemplate';
import { getErrorMessage } from '@client/app/utils/error';

type Props = { listingId: string; template: ISkillListingTemplate; unsavedChanges: boolean };

/** Any stored change to the template (copy, image, example run, switches) changes this. */
export const templatePreviewStamp = (template: ISkillListingTemplate): string =>
  [
    String(template.updatedAt),
    template.status,
    template.example?.status ?? '',
    String(template.example?.runAt ?? ''),
  ].join('|');

/**
 * The saved template page exactly as the public page renders it (the preview route), drafts
 * included. The HTML is fetched with the API token and shown in a sandbox without
 * allow-same-origin, so the page's own script runs but cannot reach the app's storage or session.
 */
const TemplateLivePreview: FC<Props> = ({ listingId, template, unsavedChanges }) => {
  const {
    data: html,
    isLoading,
    isError,
    error,
  } = useSkillTemplatePreviewHtml(listingId, templatePreviewStamp(template), true);

  return (
    <Card variant="outlined" sx={{ gap: 1, p: 1 }} data-testid="template-live-preview">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 0.5 }}>
        <Typography level="title-sm">Live preview</Typography>
        {isLoading ? <CircularProgress size="sm" /> : null}
      </Stack>
      {unsavedChanges ? (
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          sx={{ px: 0.5 }}
          data-testid="template-live-preview-unsaved"
        >
          Showing the saved page. Save to see your changes here.
        </Typography>
      ) : null}
      {isError ? (
        <Alert color="danger" variant="soft" data-testid="template-live-preview-error">
          {getErrorMessage(error) || "Couldn't load the preview."}
        </Alert>
      ) : (
        <Box sx={{ borderRadius: 'sm', overflow: 'hidden', border: '1px solid', borderColor: 'divider', height: 640 }}>
          {html ? (
            <iframe
              title="Template page preview"
              srcDoc={html}
              sandbox="allow-scripts"
              style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
              data-testid="template-live-preview-frame"
            />
          ) : null}
        </Box>
      )}
    </Card>
  );
};

export default TemplateLivePreview;
