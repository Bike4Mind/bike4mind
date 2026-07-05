import React, { useRef, useState, useCallback } from 'react';
import {
  Box,
  Grid,
  Typography,
  Card,
  Chip,
  Stack,
  CircularProgress,
  Button,
  Modal,
  ModalDialog,
  IconButton,
} from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import SettingsIcon from '@mui/icons-material/Settings';
import { IAgent } from '@bike4mind/common';
import AgentViewSection from './AgentViewSection';
import MissionsSection from '../DeepAgentConsole/MissionsSection';
import AgentPageHeader from './AgentPageHeader';
import AgentCreditManagement from './AgentCreditManagement';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { useGetProject } from '@client/app/hooks/data/projects';
import { Link } from '@tanstack/react-router';
import { useUser } from '@client/app/contexts/UserContext';
import { CREDIT_SOURCE, LOW_CREDITS_THRESHOLD } from '@client/app/constants/agentForm';
import Bike4MindIcon from '../svgs/icons/Bike4MindIcon';
import { AgentAvatar } from './AgentAvatar';

interface AgentViewProps {
  agent: IAgent;
  title: string;
  subtitle?: string;
  headerActions?: React.ReactNode;
  backTo?: string;
}

interface PersonalityFieldProps {
  label: string;
  value: string;
  labelColor?: string;
  valueLevel?: 'body-sm' | 'body-md';
  labelWeight?: 400 | 500 | 600;
}

const PersonalityField: React.FC<PersonalityFieldProps> = ({
  label,
  value,
  labelColor = 'primary.500',
  valueLevel = 'body-sm',
  labelWeight = 500,
}) => (
  <Box>
    <Typography level="body-sm" sx={{ color: labelColor, fontWeight: labelWeight, mb: 0.5 }}>
      {label}
    </Typography>
    <Typography level={valueLevel}>{value}</Typography>
  </Box>
);

const AgentView: React.FC<AgentViewProps> = ({ agent, title, subtitle, headerActions, backTo }) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [creditModalOpen, setCreditModalOpen] = useState(false);
  const [useOwnCredits, setUseOwnCredits] = useState(agent.useOwnCredits || false);
  const [currentCredits, setCurrentCredits] = useState(agent.currentCredits || 0);
  const { currentUser, setCurrentUser } = useUser();

  const { data: project, isLoading: isProjectLoading } = useGetProject(agent.projectId);

  const handleCreditSourceChange = useCallback((value: string) => {
    const newUseOwnCredits = value === CREDIT_SOURCE.AGENT;
    setUseOwnCredits(newUseOwnCredits);
  }, []);

  const handleCreditsUpdate = useCallback(
    (agentCredits: number, userCredits: number) => {
      setCurrentCredits(agentCredits);
      if (currentUser && setCurrentUser) {
        setCurrentUser({
          ...currentUser,
          currentCredits: userCredits,
        });
      }
    },
    [currentUser, setCurrentUser]
  );

  const handleCurrentCreditsChange = useCallback((value: number) => {
    setCurrentCredits(value);
  }, []);

  // Parse capabilities
  let parsedCapabilities = {
    responseStyle: 'friendly' as const,
    specialBehaviors: [] as string[],
  };

  if (agent.capabilities && agent.capabilities.length > 0) {
    try {
      const capabilitiesData = JSON.parse(agent.capabilities[0]);
      parsedCapabilities = {
        responseStyle: capabilitiesData.responseStyle || 'friendly',
        specialBehaviors: capabilitiesData.specialBehaviors || [],
      };
    } catch (error) {
      console.warn('Failed to parse capabilities:', error);
    }
  }

  return (
    <>
      <Box
        ref={scrollContainerRef}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
          overflowX: 'hidden',
          border: '1px solid',
          borderColor: theme => (theme.palette.mode === 'dark' ? 'transparent' : theme.palette.border.muted),
          backgroundColor: theme => theme.palette.background.surface2,
          borderRadius: '8px',
          pb: 3,
          height: '100%',
          ...scrollbarStyles,
        }}
      >
        <AgentPageHeader
          title={title}
          backButton={true}
          backTo={backTo || '/agents'}
          rightActions={headerActions}
          scrollContainerRef={scrollContainerRef}
        />

        {/* Content */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: { xs: 2, sm: 3 },
            maxWidth: '1312px',
            width: '100%',
            mx: 'auto',
            px: 2,
          }}
        >
          {/* Main Information */}
          <Box
            sx={{
              backgroundColor: theme => theme.palette.background.body,
              border: theme => `1px solid ${theme.palette.border.soft}`,
              borderRadius: '8px',
              p: { xs: '24px 16px 16px 16px', sm: 3 },
            }}
          >
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: '120px 1fr' },
                gap: { xs: 2, md: 4 },
                alignItems: 'stretch',
              }}
            >
              {/* Avatar */}
              <Card variant="outlined" sx={{ border: 'none', background: 'transparent', p: 0, gap: 0 }}>
                <AgentAvatar
                  name={agent.name}
                  portraitUrl={agent.visual?.portraitUrl}
                  size={120}
                  sx={{ margin: { xs: '0 auto', md: '0' } }}
                  showZoom
                />
              </Card>

              {/* Main Details */}
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr' }}>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 3, sm: 2 } }}>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: { xs: 2, sm: 0 },
                      flexDirection: { xs: 'column', sm: 'row' },
                    }}
                  >
                    <Typography
                      data-testid="agent-view-name"
                      level="title-md"
                      sx={{ fontSize: '20px', textAlign: 'center' }}
                    >
                      {agent.name}
                    </Typography>

                    <Box
                      sx={{
                        display: 'flex',
                        backgroundColor: theme => theme.palette.background.body,
                        border: theme => `1px solid ${theme.palette.border.soft}`,
                        borderRadius: '8px',
                        p: 0,
                        width: { xs: '100%', sm: 'auto' },
                      }}
                    >
                      <Box
                        sx={{
                          display: 'flex',
                          fontWeight: 400,
                          flex: 1,
                          width: '100%',
                          color: 'text.tertiary',
                          mb: 0,
                        }}
                      >
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 1,
                            borderRight: '1px solid',
                            padding: { xs: '8px 12px', sm: '12px' },
                            width: '100%',
                            borderColor: 'border.soft',
                          }}
                        >
                          <Typography level="title-sm" sx={{ fontWeight: 400, color: 'text.primary50', mb: 0 }}>
                            {useOwnCredits ? "Agent's credits" : 'My credits'}
                          </Typography>
                          <Typography
                            level="body-sm"
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                              fontWeight: 400,
                              color:
                                (useOwnCredits ? currentCredits : currentUser?.currentCredits || 0) <
                                LOW_CREDITS_THRESHOLD
                                  ? 'danger.500'
                                  : 'text.primary',
                              mb: 0,
                            }}
                          >
                            <Bike4MindIcon
                              size="12"
                              fill={
                                (useOwnCredits ? currentCredits : currentUser?.currentCredits || 0) <
                                LOW_CREDITS_THRESHOLD
                                  ? 'var(--joy-palette-danger-500)'
                                  : 'var(--joy-palette-text-tertiary)'
                              }
                            />
                            {(useOwnCredits ? currentCredits : currentUser?.currentCredits || 0).toLocaleString()}
                          </Typography>
                        </Box>

                        <IconButton
                          onClick={() => setCreditModalOpen(true)}
                          size="sm"
                          variant="plain"
                          color="neutral"
                          sx={{
                            ml: 'auto',
                            minWidth: '40px',
                            minHeight: '32px',
                            borderRadius: '0px',
                            transition: 'background-color 0.2s ease',
                          }}
                        >
                          <SettingsIcon sx={{ fontSize: '16px' }} />
                        </IconButton>
                      </Box>
                      {/* <Typography level="title-sm" sx={{ fontWeight: 400, color: 'text.tertiary', mb: 1 }}>
                    Credit Management
                  </Typography>
                  <Button
                    variant="outlined"
                    onClick={() => setCreditModalOpen(true)}
                    sx={{
                      border: theme => `1px solid ${theme.palette.border.soft}`,
                      color: 'text.primary',
                    }}
                  >
                    Manage Credits
                  </Button> */}
                    </Box>
                  </Box>

                  <Box sx={{ display: 'flex', justifyContent: { xs: 'space-between', sm: 'flex-start' }, gap: 4 }}>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                      <Typography level="body-sm" sx={{ color: 'text.tertiary', mb: 0 }}>
                        Project
                      </Typography>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        {isProjectLoading ? (
                          <>
                            <CircularProgress size="sm" sx={{ fontSize: '14px' }} />
                            <Typography level="body-md" sx={{ color: 'text.primary', fontSize: '12px' }}>
                              Loading...
                            </Typography>
                          </>
                        ) : project ? (
                          <Link
                            to="/projects/$id"
                            params={{ id: project.id }}
                            style={{
                              textDecoration: 'none',
                              transition: 'border-color 0.2s ease',
                              borderBottom: '1px solid var(--joy-palette-text-primary)',
                            }}
                          >
                            <Typography
                              sx={{
                                color: 'text.primary',
                                lineHeight: 1,
                                '&:visited': {
                                  color: 'text.primary',
                                },
                              }}
                              level="body-sm"
                            >
                              {project.name}
                            </Typography>
                          </Link>
                        ) : (
                          <Typography level="body-md" sx={{ color: 'text.primary', fontSize: '14px', lineHeight: 1 }}>
                            Not set
                          </Typography>
                        )}
                      </Box>
                    </Box>

                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                      <Typography level="body-sm" sx={{ color: 'text.tertiary', mb: 0 }}>
                        Style
                      </Typography>
                      <Typography level="body-sm" sx={{ color: 'text.primary', lineHeight: 1 }}>
                        {agent.visual?.style || 'Not set'}
                      </Typography>
                    </Box>

                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                      <Typography level="body-sm" sx={{ color: 'text.tertiary', mb: 0 }}>
                        Gender
                      </Typography>
                      <Typography level="body-sm" sx={{ color: 'text.primary', lineHeight: 1 }}>
                        {agent.identity?.gender?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Not set'}
                      </Typography>
                    </Box>
                  </Box>
                </Box>

                <Box sx={{ mt: 3 }}>
                  <Typography level="title-sm" sx={{ color: 'text.primary50' }}>
                    {agent.description || 'No description'}
                  </Typography>
                </Box>
              </Box>
            </Box>
          </Box>

          {/* Trigger Words & Capabilities */}
          <Grid container spacing={{ xs: 2, sm: 3 }}>
            <Grid xs={12} md={6}>
              <AgentViewSection title="Trigger Words">
                <Typography level="body-sm" sx={{ color: 'text.tertiary', mb: 2 }}>
                  Use these trigger words in a message to activate this agent.
                </Typography>
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                  {agent.triggerWords.map((v, i) => (
                    <Chip
                      key={i}
                      size="sm"
                      sx={{
                        color: 'text.primary',
                        pr: '12px',
                        pl: '12px',
                        pt: '2px',
                        pb: '2px',
                        backgroundColor: 'background.panel',
                        border: '1px solid',
                        borderColor: 'border.light',
                      }}
                      variant="outlined"
                    >
                      {v}
                    </Chip>
                  ))}
                </Stack>
              </AgentViewSection>
            </Grid>

            <Grid xs={12} md={6}>
              <AgentViewSection title="Capabilities">
                <Typography level="body-sm" sx={{ color: 'text.tertiary', mb: 0 }}>
                  Response Style & Special Behaviors
                </Typography>
                <Stack direction="row" spacing={0} sx={{ flexWrap: 'wrap', gap: 1, mt: 3 }}>
                  <Chip
                    size="sm"
                    sx={{
                      color: 'text.primary',
                      pr: '12px',
                      pl: '12px',
                      pt: '2px',
                      pb: '2px',
                      backgroundColor: 'background.panel',
                      border: '1px solid',
                      borderColor: 'border.light',
                    }}
                    variant="outlined"
                  >
                    {parsedCapabilities.responseStyle}
                  </Chip>
                  {parsedCapabilities.specialBehaviors.map((v, i) => (
                    <Chip
                      key={i}
                      size="sm"
                      sx={{
                        color: 'text.primary',
                        pr: '12px',
                        pl: '12px',
                        pt: '2px',
                        pb: '2px',
                        backgroundColor: 'background.panel',
                        border: '1px solid',
                        borderColor: 'border.light',
                      }}
                      variant="outlined"
                    >
                      {v}
                    </Chip>
                  ))}
                </Stack>
              </AgentViewSection>
            </Grid>
          </Grid>

          {/* System Prompt */}
          {agent.systemPrompt && (
            <AgentViewSection title="System Prompt">
              <Typography level="body-sm" sx={{ mt: 3 }}>
                {agent.systemPrompt}
              </Typography>
            </AgentViewSection>
          )}

          {/* Agency Purpose */}
          {(agent.personality.personalMission ||
            agent.personality.activeProject ||
            agent.personality.secretAmbition ||
            agent.personality.coreValues ||
            agent.personality.legacyAspiration ||
            agent.personality.growthChallenge) && (
            <AgentViewSection title="Agency & Purpose">
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
                  columnGap: 5,
                  rowGap: { xs: 1.5, sm: 3 },
                  mt: 3,
                }}
              >
                {agent.personality.personalMission && (
                  <PersonalityField label="Personal Mission" value={agent.personality.personalMission} />
                )}
                {agent.personality.activeProject && (
                  <PersonalityField label="Active Project" value={agent.personality.activeProject} />
                )}
                {agent.personality.secretAmbition && (
                  <PersonalityField label="Secret Ambition" value={agent.personality.secretAmbition} />
                )}
                {agent.personality.coreValues && (
                  <PersonalityField label="Core Values" value={agent.personality.coreValues} />
                )}
                {agent.personality.legacyAspiration && (
                  <PersonalityField label="Legacy Aspiration" value={agent.personality.legacyAspiration} />
                )}
                {agent.personality.growthChallenge && (
                  <PersonalityField label="Growth Challenge" value={agent.personality.growthChallenge} />
                )}
              </Box>
            </AgentViewSection>
          )}

          {/* Core Personality */}
          {(agent.personality?.flaw ||
            agent.personality?.quirk ||
            agent.personality?.description ||
            agent.personality?.emotionalIntelligence) && (
            <AgentViewSection title="Core Personality">
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'repeat(4, 1fr)' },
                  columnGap: 5,
                  rowGap: { xs: 1.5, sm: 3 },
                  mt: 3,
                }}
              >
                {agent.personality?.majorMotivation && (
                  <PersonalityField label="Major Motivation" value={agent.personality.majorMotivation} />
                )}
                {agent.personality?.minorMotivation && (
                  <PersonalityField label="Minor Motivation" value={agent.personality.minorMotivation} />
                )}
                {agent.personality?.flaw && <PersonalityField label="Flaw" value={agent.personality.flaw} />}
                {agent.personality?.quirk && <PersonalityField label="Quirk" value={agent.personality.quirk} />}
              </Box>
            </AgentViewSection>
          )}

          {/* Enhanced Personality */}
          {(agent.personality?.culturalFlavor ||
            agent.personality?.energyLevel ||
            agent.personality?.humorStyle ||
            agent.personality?.backstoryElement) && (
            <AgentViewSection title="Enhanced Personality">
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
                  columnGap: 5,
                  rowGap: { xs: 1.5, sm: 3 },
                  mt: 3,
                }}
              >
                {agent.personality?.emotionalIntelligence && (
                  <PersonalityField label="Emotional Intelligence" value={agent.personality.emotionalIntelligence} />
                )}
                {agent.personality?.communicationPattern && (
                  <PersonalityField label="Communication Pattern" value={agent.personality.communicationPattern} />
                )}
                {agent.personality?.memoryStyle && (
                  <PersonalityField label="Memory Style" value={agent.personality.memoryStyle} />
                )}
                {agent.personality?.energyLevel && (
                  <PersonalityField label="Energy Level" value={agent.personality.energyLevel} />
                )}
                {agent.personality?.culturalFlavor && (
                  <PersonalityField label="Cultural Flavor" value={agent.personality.culturalFlavor} />
                )}
                {agent.personality?.humorStyle && (
                  <PersonalityField label="Humor Style" value={agent.personality.humorStyle} />
                )}
                {agent.personality?.backstoryElement && (
                  <PersonalityField label="Backstory Element" value={agent.personality.backstoryElement} />
                )}
                {agent.personality?.problemSolvingApproach && (
                  <PersonalityField label="Problem Solving Approach" value={agent.personality.problemSolvingApproach} />
                )}
              </Box>
            </AgentViewSection>
          )}

          {/* Missions - standing goals pursued across wakes (deep-agent charters) */}
          <AgentViewSection title="Missions">
            <MissionsSection b4mAgentId={agent.id} agentName={agent.name} />
          </AgentViewSection>
        </Box>
      </Box>

      {/* Credit Management Modal */}
      <Modal
        open={creditModalOpen}
        sx={{ boxShadow: 'none', border: 'none', p: 2 }}
        onClose={() => setCreditModalOpen(false)}
      >
        <ModalDialog
          sx={{
            width: '100%',
            boxShadow: 'none',
            border: 'none',
            gap: 0,
            p: 2,
            position: 'relative',
            backgroundColor: 'background.panel',
            maxWidth: '420px',
          }}
        >
          <IconButton
            variant="plain"
            color="neutral"
            onClick={() => setCreditModalOpen(false)}
            sx={{
              position: 'absolute',
              top: '12px',
              right: '12px',
              width: '16px',
              height: '16px',
              minWidth: '16px',
              minHeight: '16px',
              zIndex: 1,
            }}
          >
            <CloseIcon sx={{ fontSize: '14px' }} />
          </IconButton>
          <Typography level="title-lg" sx={{ mb: 3, fontWeight: 500, color: 'text.primary', pr: 2 }}>
            {agent.name}&apos;s credit management
          </Typography>
          <AgentCreditManagement
            useOwnCredits={useOwnCredits}
            currentCredits={currentCredits}
            userCredits={currentUser?.currentCredits || 0}
            agentId={agent.id}
            readOnly={false}
            onCreditSourceChange={handleCreditSourceChange}
            onCurrentCreditsChange={handleCurrentCreditsChange}
            onCreditsUpdate={handleCreditsUpdate}
            setCurrentUser={setCurrentUser}
            currentUser={currentUser}
            showInfoText={true}
            sx={{ height: 'auto', border: 'none', p: 0, gap: 0 }}
          />
          <Box sx={{ display: 'none', gap: 2, justifyContent: 'flex-end', mt: 3 }}>
            <Button variant="outlined" onClick={() => setCreditModalOpen(false)}>
              Close
            </Button>
          </Box>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default AgentView;
