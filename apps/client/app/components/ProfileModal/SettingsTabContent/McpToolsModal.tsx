import { Box, Chip, Modal, ModalClose, ModalDialog, Typography } from '@mui/joy';
import { startCase } from 'lodash';
import React from 'react';
import { gray } from '@client/app/utils/themes/colors';

interface McpToolsModalProps {
  open: boolean;
  onClose: () => void;
  serverName: string;
  tools: string[];
}

const McpToolsModal: React.FC<McpToolsModalProps> = ({ open, onClose, serverName, tools }) => {
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 500, width: '90%' }}>
        <ModalClose />
        <Typography level="h4" sx={{ mb: 2 }}>
          {startCase(serverName)} Tools ({tools.length})
        </Typography>
        <Box
          sx={{
            maxHeight: '400px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            pr: 1,
            '&::-webkit-scrollbar': {
              width: '6px',
            },
            '&::-webkit-scrollbar-thumb': {
              backgroundColor: gray[655],
              borderRadius: '3px',
            },
          }}
        >
          {tools.map((tool, index) => (
            <Chip
              key={index}
              variant="soft"
              color="neutral"
              sx={{
                justifyContent: 'flex-start',
                fontFamily: 'monospace',
                fontSize: '0.85rem',
              }}
            >
              {tool}
            </Chip>
          ))}
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default McpToolsModal;
