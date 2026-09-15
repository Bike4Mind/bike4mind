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
  // Latches true once any load returns agents, and never drops back. Gating the search UI on
  // the live `agents.length` instead flickered the search bar + Create off for a frame when
  // clearing a no-result search: `search` clears (hasSearch false) while `agents` is still the
  // stale 0 from that search and the refetch hasn't repopulated. This keeps the affordance
  // stable for anyone who has agents; only a genuine first-run (never loaded any) hides it.
  const [hasEverHadAgents, setHasEverHadAgents] = useState(false);
  const { currentUser } = useUser();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hasSearch = search.trim().length > 0;
  const showSearchUI = hasEverHadAgents || hasSearch;

  useEffect(() => {
    const fetchAgents = async () => {
      setIsLoading(true);
      try {
        // Query the trimmed value so a whitespace-only search agrees with the UI gate
        // (which uses `hasSearch = search.trim()`); otherwise "   " could refetch to [] and
        // re-trigger the collapse-to-first-run this fix prevents.
        const response = await getAgentsFromServer(search.trim());
        setAgents(response.data);
        if (response.data.length > 0) setHasEverHadAgents(true);
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
            {showSearchUI && (
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
            {showSearchUI && <CreateAgentButton variant="header" />}
          </>
        }
      />

      <Box display="flex" flexDirection="column" flexGrow={1} px={showSearchUI ? 1 : 0} py={showSearchUI ? 2 : 0}>
        {isLoading ? (
          <Box display="flex" justifyContent="center" alignItems="center" flex={1}>
            <CircularProgress />
          </Box>
        ) : agents.length === 0 ? (
          <NoAgentsState variant={hasSearch ? 'no-results' : 'empty'} query={search} />
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
