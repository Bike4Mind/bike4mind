import { Box, Button, Card, CardContent, Textarea, Typography } from '@mui/joy';
import { useState } from 'react';
import { CopyCodeButton } from './CopyCodeButton';
import { SnippetCardProps } from './types/UserPromptTypes';
import { Save as SaveIcon } from '@mui/icons-material';
import { toast } from 'sonner';
import { KnowledgeType } from '@bike4mind/common';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { useSessions, useWorkBenchFiles, useWorkBenchActions } from '@client/app/contexts/SessionsContext';

export const SnippetCard: React.FC<SnippetCardProps> = ({ meta, content, expanded, isEditMode, onEdit }) => {
  const [editContent, setEditContent] = useState(content);
  const lines = content.split('\n');
  const previewContent = lines.slice(0, meta.previewLines).join('\n');
  const { currentSession, setCurrentSession, currentSessionId } = useSessions();
  const workBenchFiles = useWorkBenchFiles(currentSessionId);
  const { setWorkBenchFiles } = useWorkBenchActions();

  const handleSaveAsFile = async () => {
    try {
      const fileName = `${meta.title.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.${meta.type}`;
      const mimeType =
        meta.type === 'javascript'
          ? 'text/javascript'
          : meta.type === 'typescript'
            ? 'text/typescript'
            : meta.type === 'python'
              ? 'text/x-python'
              : meta.type === 'html'
                ? 'text/html'
                : meta.type === 'css'
                  ? 'text/css'
                  : 'text/plain';

      const file = new File([content], fileName, { type: mimeType });

      const data = {
        type: KnowledgeType.FILE,
        fileName,
        mimeType,
        fileSize: file.size,
      };

      const fabFile = await createFabFileOnServerWithUpload(data, file);

      // Add to workbench
      const newWorkBenchFiles = [...workBenchFiles, fabFile];
      setWorkBenchFiles(currentSessionId ?? '', newWorkBenchFiles);

      // Update session if we have one
      if (currentSession) {
        const knowledgeIds = newWorkBenchFiles.map(f => f.id);
        const updatedSession = { ...currentSession, knowledgeIds };
        setCurrentSession(updatedSession);
      }

      toast.success(`Saved as ${meta.type} file`);
    } catch (error) {
      console.error('Error saving file:', error);
      toast.error('Failed to save file');
    }
  };

  return (
    <Card
      variant="outlined"
      sx={{
        my: 1,
        width: '80%',
        backgroundColor: 'success.softBg',
        border: '4px solid',
        borderColor: 'success.softBg',
        boxShadow: theme => `0 2px 8px ${theme.vars.palette.success.softBg}`,
      }}
    >
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography level="title-sm" sx={{ color: 'success.softColor' }}>
              {meta.title}
            </Typography>
            <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
              ({meta.lineCount} lines)
            </Typography>
          </Box>
          {!isEditMode && (
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                startDecorator={<SaveIcon />}
                onClick={handleSaveAsFile}
              >
                Save
              </Button>
              <CopyCodeButton code={content} language={meta.type} />
            </Box>
          )}
        </Box>

        {isEditMode ? (
          <Box sx={{ mt: 1 }}>
            <Textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              minRows={3}
              maxRows={20}
              sx={{
                fontFamily: 'monospace',
                fontSize: '0.875rem',
                width: '100%',
              }}
            />
            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 1 }}>
              <Button size="sm" variant="plain" color="neutral" onClick={() => onEdit?.(content)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => onEdit?.(editContent)}>
                Save
              </Button>
            </Box>
          </Box>
        ) : (
          <Box
            sx={{
              fontFamily: 'monospace',
              fontSize: '0.575rem',
              whiteSpace: 'pre-wrap',
              position: 'relative',
              '&::after': !expanded
                ? {
                    content: '""',
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: '4em',
                    background: theme =>
                      `linear-gradient(to bottom, transparent, ${theme.vars.palette.success.softBg})`,
                    display: lines.length > meta.previewLines ? 'block' : 'none',
                  }
                : undefined,
            }}
          >
            {expanded ? content : previewContent + (lines.length > meta.previewLines ? '' : '')}
          </Box>
        )}
      </CardContent>
    </Card>
  );
};
