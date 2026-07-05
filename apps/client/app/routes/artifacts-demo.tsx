import React, { useState } from 'react';
import { Box, Typography, Stack, Button, Modal, ModalDialog, ModalClose, Divider, Alert, Chip } from '@mui/joy';
import { AutoAwesome as MagicIcon, Visibility as ViewIcon, Create as CreateIcon } from '@mui/icons-material';
import { ArtifactGallery, ArtifactCreator, ArtifactEditor } from '@client/app/components/artifacts';
import { type BaseArtifact } from '@bike4mind/common';
import { toast } from 'sonner';

interface ArtifactWithContent extends BaseArtifact {
  content?: string;
  contentSize: number;
  contentHash: string;
}

const ArtifactsDemoPage: React.FC = () => {
  const [showCreator, setShowCreator] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactWithContent | null>(null);
  const [editingArtifact, setEditingArtifact] = useState<ArtifactWithContent | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleArtifactCreate = () => {
    setShowCreator(true);
  };

  const handleArtifactSave = (artifact: BaseArtifact) => {
    setShowCreator(false);
    setRefreshKey(prev => prev + 1); // Force refresh of gallery
    toast.success(`Artifact "${artifact.title}" created successfully!`);
  };

  const handleArtifactSelect = (artifact: ArtifactWithContent) => {
    setSelectedArtifact(artifact);
    toast.info(`Selected artifact: ${artifact.title}`);
  };

  const handleArtifactEdit = (artifact: ArtifactWithContent) => {
    setEditingArtifact(artifact);
    setShowEditor(true);
  };

  const handleArtifactUpdate = (artifact: BaseArtifact) => {
    setShowEditor(false);
    setEditingArtifact(null);
    setRefreshKey(prev => prev + 1); // Force refresh of gallery
    toast.success(`Artifact "${artifact.title}" updated successfully!`);
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        p: 3,
      }}
    >
      <Box
        sx={{
          maxWidth: '1400px',
          mx: 'auto',
          backgroundColor: 'background.surface',
          borderRadius: 'lg',
          p: 4,
          minHeight: 'calc(100vh - 48px)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <Stack spacing={3} sx={{ mb: 4 }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <MagicIcon sx={{ fontSize: 40, color: 'primary.500' }} />
            <Box>
              <Typography
                level="h1"
                sx={{
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  mb: 1,
                }}
              >
                🏔️💎 Crystal Caverns of Frontend Integration
              </Typography>
              <Typography level="body-lg" color="neutral">
                Quest 5: Bridging the artifact system to beautiful, interactive interfaces
              </Typography>
            </Box>
          </Stack>

          <Alert color="success" variant="soft">
            <Typography level="title-sm">✨ Quest 5 Achievement Unlocked!</Typography>
            <Typography level="body-sm" sx={{ mt: 1 }}>
              The Crystal Bridge Components have been forged! Your Quest 4 APIs now flow through beautiful React
              interfaces with real-time data streams, advanced filtering, and intuitive user experiences.
            </Typography>
          </Alert>

          <Stack direction="row" spacing={2} flexWrap="wrap">
            <Chip variant="soft" color="primary">
              🗃️ Artifact Gallery
            </Chip>
            <Chip variant="soft" color="success">
              🎨 Artifact Creator
            </Chip>
            <Chip variant="soft" color="primary">
              🔍 Advanced Search
            </Chip>
            <Chip variant="soft" color="warning">
              📊 Category Filtering
            </Chip>
            <Chip variant="soft" color="danger">
              ⚡ Real-time Updates
            </Chip>
          </Stack>
        </Stack>

        <Divider sx={{ mb: 4 }} />

        {/* Demo Controls */}
        <Stack direction="row" spacing={2} sx={{ mb: 4 }}>
          <Button variant="solid" color="primary" startDecorator={<CreateIcon />} onClick={handleArtifactCreate}>
            Create New Artifact
          </Button>

          <Button variant="outlined" startDecorator={<ViewIcon />} onClick={() => setRefreshKey(prev => prev + 1)}>
            Refresh Gallery
          </Button>
        </Stack>

        {/* Main Content - Artifact Gallery */}
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          <ArtifactGallery
            key={refreshKey}
            onArtifactSelect={handleArtifactSelect}
            onArtifactCreate={handleArtifactCreate}
            onArtifactEdit={handleArtifactEdit}
          />
        </Box>

        {/* Selected Artifact Info */}
        {selectedArtifact && (
          <Alert color="primary" sx={{ mt: 3 }}>
            <Typography level="title-sm">Selected: {selectedArtifact.title}</Typography>
            <Typography level="body-sm">
              Type: {selectedArtifact.type} | Status: {selectedArtifact.status} | Created:{' '}
              {new Date(selectedArtifact.createdAt).toLocaleDateString()}
            </Typography>
          </Alert>
        )}
      </Box>

      {/* Artifact Creator Modal */}
      <Modal open={showCreator} onClose={() => setShowCreator(false)}>
        <ModalDialog
          sx={{
            width: '95vw',
            height: '90vh',
            maxWidth: '1200px',
            p: 0,
            overflow: 'hidden',
          }}
        >
          <ModalClose />
          <ArtifactCreator onClose={() => setShowCreator(false)} onSave={handleArtifactSave} />
        </ModalDialog>
      </Modal>

      {/* Artifact Editor Modal */}
      <Modal open={showEditor} onClose={() => setShowEditor(false)}>
        <ModalDialog
          sx={{
            width: '95vw',
            height: '90vh',
            maxWidth: '1200px',
            p: 0,
            overflow: 'hidden',
          }}
        >
          <ModalClose />
          {editingArtifact && (
            <ArtifactEditor
              artifact={editingArtifact}
              onClose={() => setShowEditor(false)}
              onSave={handleArtifactUpdate}
            />
          )}
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default ArtifactsDemoPage;
