import React from 'react';
import { Modal, ModalDialog, ModalClose, Box, Typography, Avatar, Card, Stack, Chip } from '@mui/joy';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { IAgent } from '@bike4mind/common';
import { purple, whiteAlpha, blackAlpha, gray } from '../../utils/themes/colors';

interface AgentPortraitModalProps {
  agent: IAgent | null;
  open: boolean;
  onClose: () => void;
}

const AgentPortraitModal: React.FC<AgentPortraitModalProps> = ({ agent, open, onClose }) => {
  if (!agent) return null;

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        sx={{
          maxWidth: '90vw',
          maxHeight: '90vh',
          width: '600px',
          p: 0,
          overflow: 'hidden',
          borderRadius: '16px',
          boxShadow: `0 25px 50px -12px ${blackAlpha[0][25]}`,
        }}
      >
        <ModalClose
          sx={{
            position: 'absolute',
            top: '16px',
            right: '16px',
            zIndex: 10,
            bgcolor: whiteAlpha[0][90],
            backdropFilter: 'blur(8px)',
            '&:hover': {
              bgcolor: gray[0],
            },
          }}
        />

        <Box
          sx={{
            position: 'relative',
            background: `linear-gradient(135deg, ${purple[350]} 0%, ${purple[750]} 100%)`,
            p: 4,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 3,
          }}
        >
          {/* Main Portrait */}
          <Box
            sx={{
              position: 'relative',
              borderRadius: '50%',
              p: '6px',
              background: `linear-gradient(45deg, ${whiteAlpha[0][30]}, ${whiteAlpha[0][10]})`,
              backdropFilter: 'blur(10px)',
              boxShadow: `0 8px 32px ${blackAlpha[0][20]}`,
            }}
          >
            <Avatar
              src={agent.visual?.portraitUrl}
              sx={{
                width: 200,
                height: 200,
                border: `4px solid ${whiteAlpha[0][20]}`,
                boxShadow: `0 8px 24px ${blackAlpha[0][15]}`,
              }}
            >
              <SmartToyOutlinedIcon sx={{ fontSize: 100, color: whiteAlpha[0][80] }} />
            </Avatar>
          </Box>

          {/* Agent Info */}
          <Stack spacing={1} alignItems="center">
            <Typography
              level="h2"
              sx={{
                color: 'white',
                textAlign: 'center',
                textShadow: `0 2px 4px ${blackAlpha[0][30]}`,
                fontWeight: 600,
              }}
            >
              {agent.name}
            </Typography>

            {agent.description && (
              <Typography
                level="body-md"
                sx={{
                  color: whiteAlpha[0][90],
                  textAlign: 'center',
                  maxWidth: '400px',
                  textShadow: `0 1px 2px ${blackAlpha[0][30]}`,
                }}
              >
                {agent.description}
              </Typography>
            )}

            {/* Status Chips */}
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              {agent.isPublic && (
                <Chip
                  color="success"
                  variant="soft"
                  sx={{
                    bgcolor: whiteAlpha[0][20],
                    color: 'white',
                    backdropFilter: 'blur(8px)',
                  }}
                >
                  Public
                </Chip>
              )}
              {agent.useOwnCredits && (
                <Chip
                  color="primary"
                  variant="soft"
                  sx={{
                    bgcolor: whiteAlpha[0][20],
                    color: 'white',
                    backdropFilter: 'blur(8px)',
                  }}
                >
                  Uses Own Credits
                </Chip>
              )}
            </Stack>
          </Stack>
        </Box>

        {/* Bottom Info Card */}
        <Card
          variant="plain"
          sx={{
            borderRadius: 0,
            p: 3,
            bgcolor: 'background.surface',
          }}
        >
          <Stack spacing={2}>
            {/* Trigger Words */}
            {agent.triggerWords && agent.triggerWords.length > 0 && (
              <Box>
                <Typography level="title-sm" sx={{ mb: 1, color: 'text.secondary' }}>
                  Trigger Words
                </Typography>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                  {agent.triggerWords.map(word => (
                    <Chip key={word} size="sm" color="primary" variant="soft">
                      {word}
                    </Chip>
                  ))}
                </Stack>
              </Box>
            )}

            {/* Credits Info */}
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Box>
                <Typography level="title-sm" sx={{ color: 'text.secondary' }}>
                  Agent Credits
                </Typography>
                <Typography level="body-md" fontWeight="md">
                  {agent.currentCredits?.toLocaleString() || 0} credits
                </Typography>
              </Box>

              {/* Visual Style */}
              {agent.visual?.style && (
                <Box sx={{ textAlign: 'right' }}>
                  <Typography level="title-sm" sx={{ color: 'text.secondary' }}>
                    Visual Style
                  </Typography>
                  <Typography level="body-md" sx={{ textTransform: 'capitalize' }}>
                    {agent.visual.style}
                  </Typography>
                </Box>
              )}
            </Box>
          </Stack>
        </Card>
      </ModalDialog>
    </Modal>
  );
};

export default AgentPortraitModal;
