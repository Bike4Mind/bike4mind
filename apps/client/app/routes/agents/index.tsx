import { Box, CircularProgress } from '@mui/joy';
import { FC, useEffect, useRef, useState } from 'react';
import { getAgentsFromServer } from '@client/app/utils/agentsAPICalls';
import { IAgent } from '@bike4mind/common';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import SearchBar from '@client/app/components/Session/SearchBar';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import CreateAgentButton from '@client/app/components/AgentList/CreateAgentButton';
import NoAgentsState from '@client/app/components/AgentList/NoAgentsState';
import AgentsGrid from '@client/app/components/AgentList/AgentsGrid';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { useUser } from '@client/app/contexts/UserContext';
import SearchBarWithToggle from '@client/app/components/Session/SearchBarWithToggle';
import AgentPageHeader from '@client/app/components/Agent/AgentPageHeader';
import { ContextHelpButton } from '@client/app/components/help';

const AgentsPage: FC = () => {
  const [agents, setAgents] = useState<IAgent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const { currentUser } = useUser();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hasAgents = !isLoading && agents.length > 0;

  useEffect(() => {
    const fetchAgents = async () => {
      setIsLoading(true);
      try {
        const response = await getAgentsFromServer(search);
        setAgents(response.data);
      } catch (error) {
        console.error('Error fetching agents:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchAgents();
  }, [search]);

  useDocumentTitle('Your Agents');

  return (
    <Box
      ref={scrollContainerRef}
      sx={{
        display: 'flex',
        backgroundColor: theme => theme.palette.background.surface2,
        borderRadius: '8px',
        flexDirection: 'column',
        height: '100%',
        border: '1px solid',
        borderColor: theme => (theme.palette.mode === 'dark' ? 'transparent' : theme.palette.border.muted),
        boxShadow: '2px 2px 20px rgba(0, 0, 0, 0.05)',
        overflowY: 'auto',
        overflowX: 'hidden',
        ...scrollbarStyles,
      }}
    >
      <AgentPageHeader
        title="Agents"
        backButton={false}
        scrollContainerRef={scrollContainerRef}
        sx={{ borderBottomColor: 'divider' }}
        titleIcon={
          <SmartToyOutlinedIcon
            sx={{
              color: 'text.primary50',
              width: '24px',
              height: '24px',
            }}
          />
        }
        rightActions={
          <>
            {hasAgents && (
              <>
                <Box
                  sx={{
                    display: { xs: 'flex', sm: 'none' },
                    alignItems: 'center',
                    position: 'absolute',
                    right: { xs: '64px' },
                    top: '50%',
                    transform: 'translateY(-50%)',
                  }}
                >
                  <SearchBarWithToggle handleChange={setSearch} placeHolder="Search agents" debounceTimeout={300} />
                </Box>

                <Box sx={{ display: { xs: 'none', sm: 'flex' } }}>
                  <SearchBar
                    handleChange={setSearch}
                    placeHolder="Search agents"
                    debounceTimeout={300}
                    endDecorator={isLoading ? <CircularProgress size="sm" /> : null}
                  />
                </Box>
              </>
            )}

            <ContextHelpButton helpId="features/agents" tooltipText="Learn about AI Agents" />
            {hasAgents && <CreateAgentButton variant="header" />}
          </>
        }
      />

      <Box display="flex" flexDirection="column" flexGrow={1} px={hasAgents ? 1 : 0} py={hasAgents ? 2 : 0}>
        {isLoading ? (
          <Box display="flex" justifyContent="center" alignItems="center" flex={1}>
            <CircularProgress />
          </Box>
        ) : agents.length === 0 ? (
          <NoAgentsState />
        ) : (
          <AgentsGrid
            agents={agents}
            currentUserCredits={currentUser?.currentCredits}
            onAgentDelete={deletedAgentId => {
              setAgents(prevAgents => prevAgents.filter(agent => agent.id !== deletedAgentId));
            }}
          />
        )}
      </Box>
    </Box>
  );
};

export default AgentsPage;
