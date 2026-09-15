import { FC, useState } from 'react';
import { Box, Chip, IconButton, Modal, ModalDialog, Stack, Typography, Tooltip, CircularProgress } from '@mui/joy';
import { Lightbulb as MementoIcon, Close as CloseIcon } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IMementoDocument } from '@bike4mind/common';

interface MementoIndicatorProps {
  mementoIds?: string[];
}

/**
 * Component that displays an indicator when mementos were used in the AI response
 * Allows users to click and view the mementos that influenced the response
 */
const MementoIndicator: FC<MementoIndicatorProps> = ({ mementoIds }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Lazy load memento data only when modal is opened
  const { data: mementos, isLoading } = useQuery({
    queryKey: ['mementos', mementoIds],
    queryFn: async () => {
      try {
        // Bulk fetch mementos by IDs using query parameter
        const response = await api.get<IMementoDocument[]>(`/api/mementos?ids=${(mementoIds ?? []).join(',')}`);
        return response.data;
      } catch (error) {
        console.warn('Failed to fetch mementos:', error);
        return [];
      }
    },
    enabled: !!mementoIds?.length && isModalOpen, // Only fetch when modal is opened
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Only show indicator if there are memento IDs
  if (!mementoIds || mementoIds.length === 0) {
    return null;
  }

  return (
    <>
      <Tooltip title={`${mementoIds.length} personal memory${mementoIds.length > 1 ? 'ies' : ''} used`} placement="top">
        <Chip
          variant="soft"
          color="warning"
          size="sm"
          startDecorator={<MementoIcon sx={{ fontSize: '14px' }} />}
          onClick={() => setIsModalOpen(true)}
          sx={{
            cursor: 'pointer',
            transition: 'all 0.2s',
            '&:hover': {
              transform: 'scale(1.05)',
              boxShadow: 'sm',
            },
          }}
          data-testid="memento-indicator"
        >
          {mementoIds.length} {mementoIds.length > 1 ? 'memories' : 'memory'}
        </Chip>
      </Tooltip>

      <Modal open={isModalOpen} onClose={() => setIsModalOpen(false)}>
        <ModalDialog
          sx={{
            maxWidth: '600px',
            width: '90vw',
            maxHeight: '80vh',
            overflow: 'auto',
          }}
        >
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography level="h4" startDecorator={<MementoIcon />}>
              Memories Used in This Response
            </Typography>
            <IconButton variant="plain" onClick={() => setIsModalOpen(false)} data-testid="close-memento-modal">
              <CloseIcon />
            </IconButton>
          </Box>

          <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
            These personal memories helped inform the AI&apos;s response:
          </Typography>

          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress />
            </Box>
          ) : (
            <Stack spacing={2}>
              {mementos && mementos.length > 0 ? (
                mementos.map((memento, index) => (
                  <Box
                    key={memento.id}
                    sx={{
                      p: 2,
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 'sm',
                      bgcolor: 'background.level1',
                    }}
                    data-testid={`memento-item-${index}`}
                  >
                    <Typography level="title-sm" sx={{ mb: 1, fontWeight: 'bold' }}>
                      {memento.summary}
                    </Typography>

                    <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1 }}>
                      {memento.tags && memento.tags.length > 0 && (
                        <>
                          {memento.tags.map(tag => (
                            <Chip key={tag} size="sm" variant="outlined" color="neutral">
                              {tag}
                            </Chip>
                          ))}
                        </>
                      )}
                    </Stack>
                  </Box>
                ))
              ) : (
                <Typography level="body-sm" color="neutral">
                  No memento details available
                </Typography>
              )}
            </Stack>
          )}
        </ModalDialog>
      </Modal>
    </>
  );
};

export default MementoIndicator;
