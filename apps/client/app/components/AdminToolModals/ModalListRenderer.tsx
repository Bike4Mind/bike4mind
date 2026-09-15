import React from 'react';
import { Box, Typography, Stack, Divider } from '@mui/joy';
import { ModalPreviewCard } from './ModalPreviewCard';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

interface ModalListRendererProps {
  modals: any[];
  message?: string;
}

export const ModalListRenderer: React.FC<ModalListRendererProps> = ({ modals, message }) => {
  return (
    <Box sx={{ width: '100%', py: 2 }}>
      {/* Header */}
      <Stack spacing={2} sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <AutoAwesomeIcon sx={{ fontSize: 28, color: 'warning.400' }} />
          <Typography level="h2" sx={{ fontWeight: 'bold' }}>
            {message || `Found ${modals.length} modals`}
          </Typography>
        </Box>
        <Divider />
      </Stack>

      {/* Modal Cards */}
      <Stack spacing={3}>
        {modals.map((modal, index) => (
          <ModalPreviewCard
            key={modal.id}
            modal={{
              id: modal.id,
              title: modal.title,
              content: modal.description || modal.content,
              enabled: modal.enabled,
              type: modal.type || (modal.isBanner ? 'banner' : 'modal'),
              priority: modal.priority || 0,
              tags: modal.tags || [],
              startDate: modal.startDate,
              endDate: modal.endDate,
              icon: modal.icon,
              primaryButtonText: modal.primaryButtonText || modal.primaryAction?.text,
              secondaryButtonText: modal.secondaryButtonText || modal.secondaryAction?.text,
              dismissible: modal.dismissible,
              style: modal.style,
            }}
            index={index}
          />
        ))}
      </Stack>

      {modals.length === 0 && (
        <Box
          sx={{
            textAlign: 'center',
            py: 8,
            px: 4,
            borderRadius: 'lg',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
          }}
        >
          <Typography level="h3" sx={{ mb: 1 }}>
            No modals found
          </Typography>
          <Typography level="body-md">Create your first modal using natural language!</Typography>
        </Box>
      )}
    </Box>
  );
};
