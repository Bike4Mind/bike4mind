import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Button,
  Menu,
  MenuItem,
  Chip,
  Stack,
  CircularProgress,
  Alert,
  FormControl,
  FormLabel,
} from '@mui/joy';
import { History as VersionIcon, CheckCircle as LatestIcon, KeyboardArrowDown } from '@mui/icons-material';
import {
  useArtifactVersions,
  useSubscribeToArtifactVersions,
  useArtifactVersionContent,
} from '@/app/hooks/data/artifacts';
import { useArtifactPersistence } from '@client/app/hooks/useArtifactPersistence';

interface ArtifactVersionDropdownProps {
  artifactId: string;
  currentVersion: number;
  onVersionChange: (version: number) => void;
}

export const ArtifactVersionDropdown: React.FC<ArtifactVersionDropdownProps> = ({
  artifactId,
  currentVersion,
  onVersionChange,
}) => {
  const [selectedVersion, setSelectedVersion] = useState(currentVersion);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  // Check if this is an incomplete artifact ID (missing timestamp and index)
  const isIncompleteId = artifactId.startsWith('artifact_') && artifactId.split('_').length < 5;

  // Check if artifact is persisted
  const { isPersisted, isLoading: isPersistenceLoading } = useArtifactPersistence(artifactId);

  // Only fetch versions if artifact is persisted
  const {
    data: versions = [],
    isLoading: loading,
    error,
  } = useArtifactVersions(isPersisted === true ? (artifactId as string) : null);

  // Only subscribe to real-time updates if persisted
  useSubscribeToArtifactVersions(isPersisted === true ? artifactId : undefined);

  // Fetch content for selected version
  const { isLoading: loadingContent } = useArtifactVersionContent(
    isPersisted === true && selectedVersion !== currentVersion ? (artifactId as string) : null,
    selectedVersion !== currentVersion ? selectedVersion : null
  );

  // Update selected version when current version changes
  useEffect(() => {
    setSelectedVersion(currentVersion);
  }, [currentVersion]);

  // Use actual versions data only
  const displayVersions = versions;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleVersionChange = useCallback(
    (version: number) => {
      setSelectedVersion(version);
      handleClose();
      onVersionChange(version);
    },
    [onVersionChange]
  );

  // Don't show anything for incomplete IDs (display-only IDs)
  if (isIncompleteId) {
    return null;
  }

  if (isPersistenceLoading || isPersisted === null) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CircularProgress size="sm" />
        <Typography level="body-sm">Checking database...</Typography>
      </Box>
    );
  }

  if (isPersisted === false) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <VersionIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          Version 1 (Not saved)
        </Typography>
      </Box>
    );
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CircularProgress size="sm" />
        <Typography level="body-sm">Loading versions...</Typography>
      </Box>
    );
  }

  if (error) {
    return (
      <Alert color="danger" size="sm">
        Failed to load versions
      </Alert>
    );
  }

  const sortedVersions = displayVersions.length > 0 ? [...displayVersions].sort((a, b) => b.version - a.version) : [];
  const latestVersion = displayVersions.length > 0 ? Math.max(...displayVersions.map(v => v.version)) : currentVersion;

  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography level="body-sm" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <VersionIcon fontSize="small" />
          Version History
        </Typography>

        <FormControl size="sm">
          <FormLabel>Version</FormLabel>
          <Button
            variant="soft"
            size="sm"
            onClick={handleClick}
            endDecorator={<KeyboardArrowDown />}
            disabled={loadingContent}
            sx={{ minWidth: 200 }}
          >
            <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
              <Typography level="body-sm">Version {selectedVersion}</Typography>
              {selectedVersion === latestVersion && (
                <Chip size="sm" color="success" variant="soft" sx={{ minHeight: 20, fontSize: '0.75rem' }}>
                  Latest
                </Chip>
              )}
            </Stack>
          </Button>
          <Menu anchorEl={anchorEl} open={open} onClose={handleClose} size="sm" sx={{ minWidth: 250 }}>
            {sortedVersions.length > 0 ? (
              sortedVersions.map((version, index) => {
                const isLatest = version.version === latestVersion;
                const isSelected = version.version === selectedVersion;

                return (
                  <MenuItem
                    key={version._id || `v${version.version}`}
                    onClick={() => {
                      handleVersionChange(version.version);
                    }}
                    selected={isSelected}
                  >
                    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ width: '100%' }}>
                      <Typography level="body-sm" fontWeight={isSelected ? 'bold' : 'normal'}>
                        Version {version.version}
                      </Typography>
                      <Stack direction="row" spacing={0.5}>
                        {isLatest && (
                          <Chip size="sm" color="success" variant="soft" sx={{ fontSize: '0.7rem' }}>
                            Latest
                          </Chip>
                        )}
                        {isSelected && <LatestIcon sx={{ fontSize: 16, color: 'primary.main' }} />}
                      </Stack>
                    </Stack>
                    {version.versionTag && (
                      <Typography level="body-xs" color="neutral" sx={{ pl: 2 }}>
                        {version.versionTag}
                      </Typography>
                    )}
                    {version.changeDescription && (
                      <Typography level="body-xs" color="neutral" sx={{ fontStyle: 'italic', pl: 2 }}>
                        {version.changeDescription}
                      </Typography>
                    )}
                  </MenuItem>
                );
              })
            ) : (
              <MenuItem disabled>
                <Typography level="body-sm" color="neutral">
                  No version history available
                </Typography>
              </MenuItem>
            )}
          </Menu>
        </FormControl>

        {loadingContent && <CircularProgress size="sm" />}
      </Stack>
    </Box>
  );
};

export default ArtifactVersionDropdown;
