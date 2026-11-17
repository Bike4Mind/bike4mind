import React, { useState } from 'react';
import { Link as RouterLink, useParams } from '@tanstack/react-router';
import { Alert, Box, CircularProgress, Link, Stack, Typography } from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useArtifact, useArtifactVersionContent } from '@client/app/hooks/data/artifacts';
import { ArtifactVersionDropdown } from '@client/app/components/artifacts/ArtifactVersionDropdown';
import { ArtifactContentView } from '@client/app/components/artifacts/library/ArtifactContentView';
import { getArtifactSource } from '@client/app/components/artifacts/library/artifactSource';

const CenteredSpinner = () => (
  <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
    <CircularProgress size="sm" data-testid="artifact-page-loading" />
  </Box>
);

/** One artifact at `/artifacts/$id`: its viewer, version switcher, and a link back to where it was filed. */
const ArtifactPage: React.FC = () => {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data, isPending, error } = useArtifact(id, { includeContent: true });
  // null follows the artifact's current version; a number pins an older one.
  const [pinnedVersion, setPinnedVersion] = useState<number | null>(null);

  const artifact = data?.artifact;
  const isViewingOlderVersion = pinnedVersion !== null && pinnedVersion !== artifact?.version;
  const {
    data: olderVersion,
    isPending: olderVersionPending,
    error: olderVersionError,
  } = useArtifactVersionContent(isViewingOlderVersion ? id : null, isViewingOlderVersion ? pinnedVersion : null);

  // A public-only reader's view carries no session or project, so it has no source to link to.
  const source = data && data.access !== 'public' ? getArtifactSource(data.artifact) : null;
  const content = isViewingOlderVersion ? olderVersion?.content : data?.content?.content;

  const renderBody = () => {
    if (isPending) return <CenteredSpinner />;
    if (error || !artifact) {
      return (
        <Alert color="neutral" sx={{ alignSelf: 'flex-start' }} data-testid="artifact-page-not-found">
          This artifact does not exist, or you do not have access to it.
        </Alert>
      );
    }
    if (isViewingOlderVersion && olderVersionPending) return <CenteredSpinner />;
    if (isViewingOlderVersion && olderVersionError) {
      return (
        <Alert color="danger" sx={{ alignSelf: 'flex-start' }} data-testid="artifact-page-version-error">
          Could not load this version.
        </Alert>
      );
    }
    if (content === undefined) {
      return (
        <Alert color="warning" sx={{ alignSelf: 'flex-start' }} data-testid="artifact-page-no-content">
          This version has no content.
        </Alert>
      );
    }
    return (
      <ArtifactContentView key={`${artifact.id}:${pinnedVersion ?? 'current'}`} artifact={artifact} content={content} />
    );
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', p: 3, gap: 2 }} data-testid="artifact-page">
      <Link
        component={RouterLink}
        to="/artifacts"
        level="body-sm"
        startDecorator={<ArrowBackIcon sx={{ fontSize: 16 }} />}
        data-testid="artifact-page-back-link"
        sx={{ alignSelf: 'flex-start' }}
      >
        Artifacts
      </Link>

      {artifact && (
        <Stack direction="row" spacing={2} alignItems="flex-start" justifyContent="space-between">
          <Box sx={{ minWidth: 0 }}>
            <Typography level="h3" noWrap data-testid="artifact-page-title">
              {artifact.title || 'Untitled artifact'}
            </Typography>
            <Typography level="body-sm" textColor="text.tertiary">
              {artifact.type} {'\u00b7'} Updated {new Date(artifact.updatedAt).toLocaleDateString()}
              {source?.kind === 'notebook' && (
                <>
                  {' \u00b7 '}
                  <Link
                    component={RouterLink}
                    to={`/notebooks/${source.sessionId}`}
                    data-testid="artifact-page-notebook-link"
                  >
                    Open notebook
                  </Link>
                </>
              )}
              {source?.kind === 'project' && (
                <>
                  {' \u00b7 '}
                  <Link
                    component={RouterLink}
                    to={`/projects/${source.projectId}`}
                    data-testid="artifact-page-project-link"
                  >
                    Open project
                  </Link>
                </>
              )}
            </Typography>
          </Box>
          {data?.access !== 'public' && (
            <ArtifactVersionDropdown
              artifactId={artifact.id}
              currentVersion={artifact.version}
              onVersionChange={setPinnedVersion}
            />
          )}
        </Stack>
      )}

      <Box sx={{ flex: 1, minHeight: 480, display: 'flex' }}>{renderBody()}</Box>
    </Box>
  );
};

export default ArtifactPage;
