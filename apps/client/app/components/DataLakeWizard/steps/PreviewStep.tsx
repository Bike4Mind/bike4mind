import { Box, Checkbox, Chip, IconButton, Input, Stack, Typography } from '@mui/joy';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOffIcon from '@mui/icons-material/FolderOff';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import { useTheme } from '@mui/joy/styles';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import type { FolderTreeNode } from '@client/app/utils/folderTreeParser';
import { formatBytes, getFileTypeBreakdown, countExcludedFiles } from '@client/app/utils/folderTreeParser';
import { toast } from 'sonner';

// Folder Tree Node Component

interface TreeNodeProps {
  node: FolderTreeNode;
  depth: number;
  onToggleExclude: (path: string) => void;
}

const TreeNodeComponent = memo(function TreeNodeComponent({ node, depth, onToggleExclude }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const theme = useTheme();
  const hasChildren = node.children.length > 0;
  const isRoot = depth === 0;

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          pl: depth * 2.5,
          py: 0.4,
          opacity: node.excluded ? 0.45 : 1,
          '&:hover': { bgcolor: theme.palette.mode === 'dark' ? 'neutral.800' : 'neutral.50' },
          borderRadius: 'sm',
        }}
      >
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <IconButton
            size="sm"
            variant="plain"
            sx={{ minWidth: 24, minHeight: 24, p: 0 }}
            onClick={() => setExpanded(prev => !prev)}
          >
            {expanded ? <ExpandMoreIcon sx={{ fontSize: 18 }} /> : <ChevronRightIcon sx={{ fontSize: 18 }} />}
          </IconButton>
        ) : (
          <Box sx={{ width: 24 }} />
        )}

        {/* Exclude checkbox */}
        {!isRoot && (
          <Checkbox
            size="sm"
            checked={!node.excluded}
            onChange={() => onToggleExclude(node.path)}
            aria-label={`Include folder ${node.path}`}
            sx={{ mr: 0.5 }}
          />
        )}

        {/* Icon */}
        {node.excluded ? (
          <FolderOffIcon sx={{ fontSize: 18, color: 'neutral.400' }} />
        ) : (
          <FolderIcon sx={{ fontSize: 18, color: 'warning.400' }} />
        )}

        {/* Name */}
        <Typography
          level="body-sm"
          sx={{
            textDecoration: node.excluded ? 'line-through' : 'none',
            fontWeight: isRoot ? 'bold' : 'normal',
            flex: 1,
          }}
          noWrap
        >
          {node.name || 'Root'}
        </Typography>

        {/* Stats */}
        <Chip size="sm" variant="soft" color={node.excluded ? 'neutral' : 'primary'} sx={{ fontSize: 11 }}>
          {node.fileCount} files
        </Chip>
        <Typography level="body-xs" color="neutral" sx={{ minWidth: 60, textAlign: 'right' }}>
          {formatBytes(node.totalSize)}
        </Typography>
      </Box>

      {/* Children */}
      {expanded && hasChildren && (
        <Box>
          {node.children.map(child => (
            <TreeNodeComponent key={child.path} node={child} depth={depth + 1} onToggleExclude={onToggleExclude} />
          ))}
        </Box>
      )}
    </Box>
  );
});

// Main Preview Step

export default function PreviewStep() {
  const theme = useTheme();
  const folderTree = useDataLakeWizardStore(s => s.folderTree);
  const allFiles = useDataLakeWizardStore(s => s.allFiles);
  const excludedPatterns = useDataLakeWizardStore(s => s.excludedPatterns);
  const toggleFolderExcl = useDataLakeWizardStore(s => s.toggleFolderExclusion);
  const setExcludedPatterns = useDataLakeWizardStore(s => s.setExcludedPatterns);
  const [newPattern, setNewPattern] = useState('');

  // Show toast on mount about auto-excluded files
  useEffect(() => {
    if (folderTree) {
      const excludedCount = countExcludedFiles(folderTree);
      if (excludedCount > 0) {
        toast.info(`Auto-excluded ${excludedCount} junk file${excludedCount !== 1 ? 's' : ''}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only on mount

  const includedFiles = useMemo(() => allFiles.filter(f => !f.excluded), [allFiles]);
  const breakdown = useMemo(() => getFileTypeBreakdown(allFiles), [allFiles]);
  const totalIncludedSize = useMemo(() => includedFiles.reduce((sum, f) => sum + f.size, 0), [includedFiles]);

  const handleToggleExclude = useCallback(
    (path: string) => {
      toggleFolderExcl(path);
    },
    [toggleFolderExcl]
  );

  const handleAddPattern = useCallback(() => {
    const trimmed = newPattern.trim();
    if (!trimmed || excludedPatterns.includes(trimmed)) return;
    setExcludedPatterns([...excludedPatterns, trimmed]);
    setNewPattern('');
  }, [newPattern, excludedPatterns, setExcludedPatterns]);

  const handleRemovePattern = useCallback(
    (pattern: string) => {
      setExcludedPatterns(excludedPatterns.filter(p => p !== pattern));
    },
    [excludedPatterns, setExcludedPatterns]
  );

  if (!folderTree) {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <Typography color="neutral">No files loaded. Go back and select a folder.</Typography>
      </Box>
    );
  }

  return (
    <Box data-testid="wizard-preview-step" sx={{ flex: 1, display: 'flex', gap: 2, p: 2, overflow: 'hidden' }}>
      {/* Left panel: Folder tree */}
      <Box
        sx={{
          flex: 3,
          overflow: 'auto',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 'md',
          p: 1,
        }}
      >
        <TreeNodeComponent node={folderTree} depth={0} onToggleExclude={handleToggleExclude} />
      </Box>

      {/* Right panel: Summary */}
      <Box sx={{ flex: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {/* File counts */}
        <Box
          sx={{
            p: 2,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 'md',
            bgcolor: theme.palette.mode === 'dark' ? 'neutral.900' : 'neutral.50',
          }}
        >
          <Typography level="title-sm" sx={{ mb: 1 }}>
            Summary
          </Typography>
          <Stack gap={0.5}>
            <Typography level="body-sm">
              <strong>{includedFiles.length.toLocaleString()}</strong> of {allFiles.length.toLocaleString()} files
              included
            </Typography>
            <Typography level="body-sm">
              Total size: <strong>{formatBytes(totalIncludedSize)}</strong>
            </Typography>
          </Stack>
        </Box>

        {/* File type breakdown */}
        <Box
          sx={{
            p: 2,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 'md',
            bgcolor: theme.palette.mode === 'dark' ? 'neutral.900' : 'neutral.50',
          }}
        >
          <Typography level="title-sm" sx={{ mb: 1 }}>
            File Types
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {Object.entries(breakdown)
              .sort((a, b) => b[1].count - a[1].count)
              .map(([category, info]) => (
                <Chip key={category} size="sm" variant="soft" color="neutral">
                  {category}: {info.count.toLocaleString()}
                </Chip>
              ))}
          </Box>
        </Box>

        {/* Excluded patterns */}
        <Box
          sx={{
            p: 2,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 'md',
            flex: 1,
            overflow: 'auto',
            bgcolor: theme.palette.mode === 'dark' ? 'neutral.900' : 'neutral.50',
          }}
        >
          <Typography level="title-sm" sx={{ mb: 1 }}>
            Excluded Patterns
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
            {excludedPatterns.map(pattern => (
              <Chip
                key={pattern}
                size="sm"
                variant="soft"
                color="danger"
                endDecorator={
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="danger"
                    onClick={() => handleRemovePattern(pattern)}
                    sx={{ minWidth: 16, minHeight: 16, p: 0, '--IconButton-size': '16px' }}
                  >
                    <CloseIcon sx={{ fontSize: 12 }} />
                  </IconButton>
                }
              >
                {pattern}
              </Chip>
            ))}
          </Box>
          <Stack direction="row" gap={0.5}>
            <Input
              size="sm"
              placeholder="Add pattern..."
              value={newPattern}
              onChange={e => setNewPattern(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAddPattern();
              }}
              sx={{ flex: 1 }}
            />
            <IconButton
              size="sm"
              variant="soft"
              color="primary"
              onClick={handleAddPattern}
              disabled={!newPattern.trim()}
            >
              <AddIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Stack>
        </Box>
      </Box>
    </Box>
  );
}
