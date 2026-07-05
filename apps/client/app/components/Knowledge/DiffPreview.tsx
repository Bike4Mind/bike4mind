import React, { useState } from 'react';
import {
  Modal,
  ModalDialog,
  ModalClose,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Chip,
  CircularProgress,
  Alert,
} from '@mui/joy';
import { Check, X, Eye, GitCompare, AlertCircle } from 'lucide-react';
import { Theme } from '@mui/joy/styles';

interface DiffPreviewProps {
  open: boolean;
  onClose: () => void;
  fileName: string;
  original: string;
  modified: string;
  diff: {
    additions: number;
    deletions: number;
    changes: number;
    hunks: string;
  };
  onApply: () => Promise<void>;
  onReject: () => void;
}

type ViewMode = 'unified' | 'split' | 'preview';

const DiffPreview: React.FC<DiffPreviewProps> = ({
  open,
  onClose,
  fileName,
  original,
  modified,
  diff,
  onApply,
  onReject,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('unified');
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApply = async () => {
    setIsApplying(true);
    setError(null);
    try {
      await onApply();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply changes');
    } finally {
      setIsApplying(false);
    }
  };

  const handleReject = () => {
    onReject();
    onClose();
  };

  const renderUnifiedDiff = () => {
    const lines = diff.hunks.split('\n');
    return (
      <Box
        sx={{
          fontFamily: 'monospace',
          fontSize: '0.875rem',
          backgroundColor: 'background.surface',
          borderRadius: 'sm',
          p: 2,
          overflowX: 'auto',
          maxHeight: '60vh',
          overflowY: 'auto',
        }}
      >
        {lines.map((line, index) => {
          let bgColor = 'transparent';
          let color = 'text.primary';

          if (line.startsWith('+')) {
            bgColor = 'success.softBg';
            color = 'success.plainColor';
          } else if (line.startsWith('-')) {
            bgColor = 'danger.softBg';
            color = 'text.primary';
          } else if (line.startsWith('  ...')) {
            color = 'text.secondary';
          }

          return (
            <Box
              key={index}
              sx={(theme: Theme) => ({
                backgroundColor: bgColor,
                color: color,
                px: 1,
                py: 0.25,
                borderLeft: line.startsWith('+') ? '3px solid' : line.startsWith('-') ? '3px solid' : 'none',
                borderLeftColor: line.startsWith('+')
                  ? theme.palette.success.solidBg
                  : line.startsWith('-')
                    ? theme.palette.danger.solidBg
                    : undefined,
                whiteSpace: 'pre',
              })}
            >
              {line}
            </Box>
          );
        })}
      </Box>
    );
  };

  const renderSplitDiff = () => {
    // Simplified split view - does not parse/align hunks, just shows original vs modified
    return (
      <Box sx={{ display: 'flex', gap: 2, overflowX: 'auto' }}>
        <Box sx={{ flex: 1 }}>
          <Typography level="body-sm" sx={{ mb: 1 }}>
            Original
          </Typography>
          <Box
            sx={{
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              backgroundColor: 'background.surface',
              borderRadius: 'sm',
              p: 2,
              maxHeight: '60vh',
              overflowY: 'auto',
            }}
          >
            <pre style={{ margin: 0 }}>{original}</pre>
          </Box>
        </Box>
        <Box sx={{ flex: 1 }}>
          <Typography level="body-sm" sx={{ mb: 1 }}>
            Modified
          </Typography>
          <Box
            sx={{
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              backgroundColor: 'background.surface',
              borderRadius: 'sm',
              p: 2,
              maxHeight: '60vh',
              overflowY: 'auto',
            }}
          >
            <pre style={{ margin: 0 }}>{modified}</pre>
          </Box>
        </Box>
      </Box>
    );
  };

  const renderPreview = () => {
    return (
      <Box
        sx={{
          fontFamily: 'monospace',
          fontSize: '0.875rem',
          backgroundColor: 'background.surface',
          borderRadius: 'sm',
          p: 2,
          maxHeight: '60vh',
          overflowY: 'auto',
        }}
      >
        <pre style={{ margin: 0 }}>{modified}</pre>
      </Box>
    );
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog size="lg" sx={{ width: '90%', maxWidth: 1200, height: '90vh', maxHeight: 800 }}>
        <ModalClose />
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <GitCompare size={20} />
              Diff Preview - {fileName}
            </Box>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Chip color="success" size="sm">
                +{diff.additions}
              </Chip>
              <Chip color="danger" size="sm">
                -{diff.deletions}
              </Chip>
              <Chip color="neutral" size="sm">
                ~{diff.changes} changes
              </Chip>
            </Box>
          </Box>
        </DialogTitle>

        <DialogContent sx={{ p: 0 }}>
          <Tabs value={viewMode} onChange={(_, value) => setViewMode(value as ViewMode)}>
            <TabList>
              <Tab value="unified">
                <GitCompare size={16} />
                Unified
              </Tab>
              <Tab value="split">Split</Tab>
              <Tab value="preview">
                <Eye size={16} />
                Preview
              </Tab>
            </TabList>

            <TabPanel value="unified" sx={{ p: 2 }}>
              {renderUnifiedDiff()}
            </TabPanel>

            <TabPanel value="split" sx={{ p: 2 }}>
              {renderSplitDiff()}
            </TabPanel>

            <TabPanel value="preview" sx={{ p: 2 }}>
              {renderPreview()}
            </TabPanel>
          </Tabs>

          {error && (
            <Alert color="danger" startDecorator={<AlertCircle size={16} />} sx={{ m: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>

        <DialogActions>
          <Button
            variant="plain"
            color="danger"
            onClick={handleReject}
            disabled={isApplying}
            startDecorator={<X size={16} />}
            data-testid="diff-preview-reject-btn"
          >
            Reject
          </Button>
          <Button
            variant="solid"
            color="success"
            onClick={handleApply}
            disabled={isApplying}
            startDecorator={isApplying ? <CircularProgress size="sm" /> : <Check size={16} />}
            data-testid="diff-preview-apply-btn"
          >
            {isApplying ? 'Applying...' : 'Apply Changes'}
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default DiffPreview;
