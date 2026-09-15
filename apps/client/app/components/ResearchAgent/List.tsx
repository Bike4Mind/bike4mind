import { FC } from 'react';
import { Box, Button, List as JoyList, ListItem, ListItemButton, Typography, Avatar } from '@mui/joy';
import { blue, brand, purple, brandAlpha, whiteAlpha } from '../../utils/themes/colors';
import { SmartToy, AutoAwesome, RocketLaunch } from '@mui/icons-material';
import { IResearchAgent } from '@bike4mind/common';

interface ResearchAgentListProps {
  agents: IResearchAgent[];
  selectedAgentId?: string;
  onSelectAgent: (agentId: string) => void;
  onCreateAgent: () => void;
}

const ResearchAgentList: FC<ResearchAgentListProps> = ({ agents, selectedAgentId, onSelectAgent, onCreateAgent }) => {
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 2 }}>
        <Button
          fullWidth
          size="lg"
          onClick={onCreateAgent}
          sx={{
            mb: 2,
            background: `linear-gradient(135deg, ${blue[400]} 0%, ${brand[500]} 50%, ${purple[500]} 100%)`,
            color: 'white',
            fontWeight: 600,
            fontSize: '15px',
            py: 1.5,
            borderRadius: '12px',
            border: 'none',
            boxShadow: `0 4px 20px ${brandAlpha[500][25]}`,
            position: 'relative',
            overflow: 'hidden',
            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            '&::before': {
              content: '""',
              position: 'absolute',
              top: 0,
              left: '-100%',
              width: '100%',
              height: '100%',
              background: `linear-gradient(90deg, transparent, ${whiteAlpha[0][20]}, transparent)`,
              transition: 'left 0.6s ease',
            },
            '&:hover': {
              transform: 'translateY(-2px) scale(1.02)',
              boxShadow: `0 8px 30px ${brandAlpha[500][40]}`,
              background: `linear-gradient(135deg, ${blue[700]} 0%, ${blue[800]} 50%, ${purple[700]} 100%)`,
              '&::before': {
                left: '100%',
              },
            },
            '&:active': {
              transform: 'translateY(-1px) scale(1.01)',
            },
            '& .MuiButton-startDecorator': {
              marginRight: '8px',
            },
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <RocketLaunch sx={{ fontSize: 20 }} />
            <Typography level="title-sm" sx={{ color: 'inherit', fontWeight: 'inherit' }}>
              Create New Agent
            </Typography>
            <AutoAwesome sx={{ fontSize: 16, opacity: 0.8 }} />
          </Box>
        </Button>
      </Box>
      <JoyList
        sx={{
          flex: 1,
          overflow: 'auto',
          '--ListItem-radius': '8px',
          '--List-gap': '8px',
          px: 2,
        }}
      >
        {agents.map(agent => (
          <ListItem key={agent.id}>
            <ListItemButton
              selected={agent.id === selectedAgentId}
              onClick={() => onSelectAgent(agent.id)}
              sx={{
                borderRadius: '8px',
                position: 'relative',
                transition: 'all 0.2s ease-in-out',
                '&:hover': {
                  bgcolor: 'background.level2',
                  transform: 'translateX(4px)',
                },
                '&.Mui-selected': {
                  bgcolor: 'primary.softBg',
                  borderLeft: '3px solid',
                  borderLeftColor: 'primary.500',
                  '&:hover': {
                    bgcolor: 'primary.softHoverBg',
                  },
                },
                '&.Mui-selected::before': {
                  content: '""',
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: '3px',
                  bgcolor: 'primary.500',
                  borderRadius: '0 4px 4px 0',
                },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%' }}>
                <Avatar
                  size="sm"
                  sx={{
                    bgcolor: agent.id === selectedAgentId ? 'primary.500' : 'neutral.500',
                    flexShrink: 0,
                  }}
                >
                  <SmartToy sx={{ fontSize: 18, color: 'white' }} />
                </Avatar>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}>
                  <Typography
                    level="title-sm"
                    sx={{
                      color: agent.id === selectedAgentId ? 'primary.700' : 'text.primary',
                      fontWeight: agent.id === selectedAgentId ? 600 : 500,
                    }}
                  >
                    {agent.name}
                  </Typography>
                  <Typography
                    level="body-sm"
                    noWrap
                    sx={{
                      color: agent.id === selectedAgentId ? 'primary.600' : 'text.secondary',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {agent.description}
                  </Typography>
                </Box>
              </Box>
            </ListItemButton>
          </ListItem>
        ))}
      </JoyList>
    </Box>
  );
};

export default ResearchAgentList;
