import React from 'react';
import {
  Box,
  Typography,
  FormControl,
  FormLabel,
  Input,
  Textarea,
  Card,
  Select,
  Option,
  CircularProgress,
  IconButton,
  Link,
  Tooltip,
} from '@mui/joy';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { Skeleton } from '@mui/joy';
import AddAPhotoIcon from '@mui/icons-material/AddAPhoto';
import { IProject } from '@bike4mind/common';
import { FormState } from '../../types/agentForm';
import { VISUAL_STYLES, GENDER_OPTIONS, CREDIT_SOURCE } from '../../constants/agentForm';
import AutoAwesomeIconButton from './AutoAwesomeIconButton';
import AgentCreditManagement from './AgentCreditManagement';
import { AgentAvatar } from './AgentAvatar';
import { useNavigate } from '@tanstack/react-router';
import ShimmerWrapper from '../ShimmerWrapper';

interface MainInformationSectionProps {
  formState: FormState;
  projects: IProject[];
  isLoadingProjects: boolean;
  isDraggingImage: boolean;
  isUploadingImage: boolean;
  userCredits: number;
  shimmeringField: string | null;
  initialData?: any; // For showing current agent credits
  simplified?: boolean;
  onInputChange: (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => void;
  onNestedInputChange: (
    section: 'personality' | 'visual',
    field: string
  ) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onSquareSlideToggleChange: (field: keyof FormState) => (e: { target: { checked: boolean } }) => void;
  onProjectChange: (value: string | null) => void;
  onVisualStyleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onGenerateDescription: () => void;
  onOpenImageBrowser: () => void;
  onDragEnter: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onImageDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onCreditSourceChange: (value: string) => void;
  onCurrentCreditsChange: (value: number) => void;
  onGenderIdentityChange: (value: string) => void;
  onTransferCredits?: (amount: number) => void;
  onTransferComplete?: () => void;
  onGenerateAvatar?: () => void;
  isGeneratingDescription: boolean;
  isGeneratingAvatar?: boolean;
  readOnly?: boolean;
  agentId?: string;
  onCreditsUpdate?: (agentCredits: number, userCredits: number) => void;
  setCurrentUser?: (user: any) => void;
  currentUser?: any;
}

const MainInformationSection: React.FC<MainInformationSectionProps> = ({
  formState,
  projects,
  isLoadingProjects,
  isDraggingImage,
  isUploadingImage,
  userCredits,
  shimmeringField,
  initialData,
  simplified = false,
  onInputChange,
  onNestedInputChange,
  onSquareSlideToggleChange,
  onProjectChange,
  onVisualStyleChange,
  onDescriptionChange,
  onGenerateDescription,
  onOpenImageBrowser,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onImageDrop,
  onCreditSourceChange,
  onCurrentCreditsChange,
  onGenderIdentityChange,
  onTransferCredits,
  onTransferComplete,
  onGenerateAvatar,
  isGeneratingDescription,
  isGeneratingAvatar = false,
  readOnly = false,
  agentId,
  onCreditsUpdate,
  setCurrentUser,
  currentUser,
}) => {
  const navigate = useNavigate();

  return (
    <Box
      sx={{
        backgroundColor: theme => theme.palette.background.body,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '8px',
        p: 2,
      }}
    >
      {simplified ? (
        /* Simplified: avatar inline beside name + description */
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
          <Box sx={{ flexShrink: 0 }}>
            <Box sx={{ position: 'relative' }}>
              <AgentAvatar
                name={formState.name}
                portraitUrl={formState.visual.portraitUrl}
                size={80}
                onClick={onOpenImageBrowser}
                onDragEnter={onDragEnter}
                onDragLeave={onDragLeave}
                onDragOver={onDragOver}
                onDrop={onImageDrop}
                sx={{
                  border: isDraggingImage ? '1px dashed' : '1px solid',
                  borderColor: isDraggingImage ? 'text.primary' : 'divider',
                  transition: 'all 0.2s ease-in-out',
                }}
                showZoom
              />
              {isUploadingImage && (
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'rgba(0, 0, 0, 0.5)',
                    position: 'absolute',
                    inset: 0,
                    zIndex: 11,
                    borderRadius: '8px',
                  }}
                >
                  <CircularProgress size="sm" sx={{ color: 'white' }} />
                </Box>
              )}
              {!isGeneratingAvatar && (
                <Tooltip title="Choose avatar" placement="top">
                  <IconButton
                    size="sm"
                    onClick={readOnly ? undefined : onOpenImageBrowser}
                    disabled={readOnly}
                    sx={{
                      position: 'absolute',
                      bottom: 4,
                      right: 4,
                      width: 20,
                      height: 20,
                      minWidth: 20,
                      minHeight: 20,
                      backgroundColor: theme => theme.palette.background.surface2,
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: '4px',
                      zIndex: 3,
                      '&:hover': { backgroundColor: 'primary.dark' },
                    }}
                  >
                    <AddAPhotoIcon sx={{ fontSize: 10, color: 'text.tertiary' }} />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
          </Box>

          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <FormControl required size="sm">
              <FormLabel sx={{ fontWeight: 400, color: 'text.tertiary', mb: 0.5 }}>Agent Name</FormLabel>
              <Input
                data-testid="agent-form-name"
                size="sm"
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  backgroundColor: 'background.panel',
                  color: 'text.primary',
                  boxShadow: 'none',
                  '&::placeholder': { color: 'text.secondary' },
                }}
                value={formState.name}
                onChange={e => {
                  e.target.value = e.target.value.trimStart();
                  onInputChange('name')(e);
                }}
                placeholder="E.g., Research Assistant"
                readOnly={readOnly}
              />
            </FormControl>

            <FormControl size="sm">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <FormLabel sx={{ fontWeight: 400, color: 'text.tertiary', mb: 0 }}>Description</FormLabel>
                <AutoAwesomeIconButton
                  tooltip="Generate description from agent name"
                  onClick={readOnly ? undefined : onGenerateDescription}
                  disabled={!formState.name || isGeneratingDescription || readOnly}
                  sx={{ width: 20, height: 20, minWidth: 20, minHeight: 20 }}
                />
              </Box>
              <ShimmerWrapper isShimmering={shimmeringField === 'description'} fieldName="description">
                <Textarea
                  data-testid="agent-form-description"
                  size="sm"
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    backgroundColor: 'background.panel',
                    color: 'text.primary',
                    boxShadow: 'none',
                    '&::placeholder': { color: 'text.secondary' },
                  }}
                  minRows={3}
                  maxRows={5}
                  value={formState.description}
                  onChange={e => onDescriptionChange(e.target.value)}
                  placeholder="Describe what this agent does..."
                  readOnly={readOnly}
                />
              </ShimmerWrapper>
            </FormControl>
          </Box>
        </Box>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: '1fr',
              md: '120px 2fr minmax(300px, 1fr)',
              lg: '120px 1.5fr minmax(350px, 1fr)',
            },
            gap: 3,
            alignItems: 'stretch',
          }}
        >
          {/* First Column - Visual Appearance */}
          <Box sx={{ display: { xs: 'flex', sm: 'block' }, justifyContent: { xs: 'center', sm: 'flex-start' } }}>
            <Card
              variant="outlined"
              sx={{
                border: 'none',
                background: 'transparent',
                p: 0,
                gap: 0,
              }}
            >
              <Box sx={{ position: 'relative' }}>
                <AgentAvatar
                  name={formState.name}
                  portraitUrl={formState.visual.portraitUrl}
                  size={{ xs: 150, sm: 120 }}
                  onClick={onOpenImageBrowser}
                  onDragEnter={onDragEnter}
                  onDragLeave={onDragLeave}
                  onDragOver={onDragOver}
                  onDrop={onImageDrop}
                  sx={{
                    border: isDraggingImage ? '1px dashed' : '1px solid',
                    borderColor: isDraggingImage ? 'text.primary' : 'border.soft',
                    transition: 'all 0.2s ease-in-out',
                  }}
                  showZoom
                />

                {/* Loading skeleton overlay */}
                {isGeneratingAvatar && (
                  <Skeleton
                    variant="rectangular"
                    sx={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      width: '100%',
                      height: '100%',
                      zIndex: 10,
                      borderRadius: '8px',
                    }}
                  />
                )}

                {/* Upload progress overlay */}
                {isUploadingImage && (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: 'rgba(0, 0, 0, 0.5)',
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      zIndex: 11,
                      borderRadius: '8px',
                    }}
                  >
                    <CircularProgress size="sm" sx={{ color: 'white' }} />
                  </Box>
                )}

                {/* Drag overlay */}
                {isDraggingImage && (
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: 'rgba(0, 0, 0, 0.3)',
                      color: 'white',
                      zIndex: 2,
                      transition: 'opacity 0.2s ease-in-out',
                      pointerEvents: 'none',
                      borderRadius: '8px',
                    }}
                  />
                )}

                {!isGeneratingAvatar && (
                  <Tooltip title="Choose avatar" placement="top">
                    <IconButton
                      size="sm"
                      onClick={readOnly ? undefined : onOpenImageBrowser}
                      disabled={readOnly}
                      sx={{
                        position: 'absolute',
                        bottom: 8,
                        left: 8,
                        width: 24,
                        height: 24,
                        minWidth: 24,
                        minHeight: 24,
                        backgroundColor: theme => theme.palette.background.surface2,
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: '4px',
                        '&:hover': { backgroundColor: 'primary.dark' },
                        zIndex: 3,
                      }}
                    >
                      <AddAPhotoIcon sx={{ fontSize: 12, color: 'text.tertiary' }} />
                    </IconButton>
                  </Tooltip>
                )}

                {onGenerateAvatar && (
                  <AutoAwesomeIconButton
                    tooltip="Generate avatar"
                    onClick={readOnly ? undefined : onGenerateAvatar}
                    disabled={readOnly || isGeneratingAvatar}
                    loading={isGeneratingAvatar}
                    sx={{
                      position: 'absolute',
                      bottom: 8,
                      right: 8,
                      zIndex: 20,
                    }}
                  />
                )}
              </Box>
            </Card>
          </Box>

          {/* Second Column - Main Information */}
          <Box>
            <Card
              variant="outlined"
              sx={{
                border: 'none',
                background: 'transparent',
                p: 0,
              }}
            >
              <Box sx={{ mt: 0 }}>
                {/* Agent Name and Project */}
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, mb: 2 }}>
                  <FormControl required size="sm">
                    <FormLabel sx={{ fontWeight: 400, color: 'text.tertiary', mb: 1 }}>Agent Name</FormLabel>
                    <Input
                      data-testid="agent-form-name"
                      size="sm"
                      sx={{
                        border: '1px solid',
                        borderColor: 'divider',
                        backgroundColor: 'background.panel',
                        color: 'text.primary',
                        boxShadow: 'none',
                        '&::placeholder': { color: 'text.secondary' },
                      }}
                      value={formState.name}
                      onChange={e => {
                        e.target.value = e.target.value.trimStart();
                        onInputChange('name')(e);
                      }}
                      placeholder="E.g., Research Assistant"
                      readOnly={readOnly}
                    />
                  </FormControl>

                  <FormControl size="sm">
                    <Box>
                      <Box
                        sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, mb: 1 }}
                      >
                        <FormLabel sx={{ fontWeight: 400, color: 'text.tertiary', mb: 0 }}>Project</FormLabel>

                        {projects.length === 0 && !isLoadingProjects && (
                          <Link
                            data-testid="create-project-link"
                            onClick={() => navigate({ to: '/projects' })}
                            sx={{
                              color: 'danger.500',
                              fontSize: '12px',
                              cursor: 'pointer',
                              textDecoration: 'underline',
                              transition: 'color 0.2s ease-in-out',

                              '&:hover': {
                                color: 'danger.600',
                                transition: 'color 0.2s ease-in-out',
                              },
                            }}
                          >
                            Create a project first
                          </Link>
                        )}
                      </Box>

                      <Select
                        data-testid="agent-form-project"
                        size="sm"
                        placeholder="Select a project"
                        sx={{
                          border: '1px solid',
                          borderColor: 'border.input',
                          backgroundColor: 'background.panel',
                          color: 'text.primary',
                          boxShadow: 'none',
                        }}
                        indicator={<KeyboardArrowDownIcon />}
                        value={formState.projectId}
                        onChange={(_, value) => onProjectChange(value)}
                        disabled={isLoadingProjects || projects.length === 0 || readOnly}
                        endDecorator={isLoadingProjects ? <CircularProgress size="sm" /> : null}
                      >
                        {projects.map(project => (
                          <Option key={project.id} value={project.id}>
                            {project.name}
                          </Option>
                        ))}
                      </Select>
                    </Box>
                  </FormControl>
                </Box>

                {/* Style and Gender Identity in 2 columns */}
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, mb: 2 }}>
                  <FormControl size="sm">
                    <FormLabel sx={{ fontWeight: 400, color: 'text.tertiary' }}>Style</FormLabel>
                    <Select
                      size="sm"
                      value={formState.visual.style}
                      indicator={<KeyboardArrowDownIcon />}
                      sx={{
                        border: '1px solid',
                        borderColor: 'border.input',
                        backgroundColor: 'background.panel',
                        color: 'text.primary',
                        boxShadow: 'none',
                      }}
                      onChange={(_, value) => {
                        if (value) {
                          onVisualStyleChange(value);
                        }
                      }}
                      disabled={readOnly}
                    >
                      {VISUAL_STYLES.map(style => (
                        <Option key={style.value} value={style.value}>
                          {style.label}
                        </Option>
                      ))}
                    </Select>
                  </FormControl>

                  <FormControl size="sm">
                    <FormLabel sx={{ fontWeight: 400, color: 'text.tertiary' }}>Gender Identity</FormLabel>
                    <Select
                      size="sm"
                      value={formState.identity.gender}
                      indicator={<KeyboardArrowDownIcon />}
                      sx={{
                        border: '1px solid',
                        borderColor: 'border.input',
                        backgroundColor: 'background.panel',
                        color: 'text.primary',
                        boxShadow: 'none',
                      }}
                      onChange={(_, value) => {
                        if (value) {
                          onGenderIdentityChange(value);
                        }
                      }}
                      disabled={readOnly}
                    >
                      {GENDER_OPTIONS.map(option => (
                        <Option key={option.value} value={option.value}>
                          {option.label}
                        </Option>
                      ))}
                    </Select>
                  </FormControl>
                </Box>

                {/* Description in one column */}
                <FormControl size="sm">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <FormLabel sx={{ fontWeight: 400, color: 'text.tertiary', mb: 0 }}>Description</FormLabel>

                    <AutoAwesomeIconButton
                      tooltip="Generate description from agent name"
                      onClick={readOnly ? undefined : onGenerateDescription}
                      disabled={!formState.name || isGeneratingDescription || readOnly}
                      sx={{
                        width: 20,
                        height: 20,
                        minWidth: 20,
                        minHeight: 20,
                      }}
                    />
                  </Box>

                  <ShimmerWrapper isShimmering={shimmeringField === 'description'} fieldName="description">
                    <Textarea
                      data-testid="agent-form-description"
                      size="sm"
                      sx={{
                        border: '1px solid',
                        borderColor: 'border.input',
                        backgroundColor: 'background.panel',
                        color: 'text.primary',
                        boxShadow: 'none',
                      }}
                      minRows={6}
                      maxRows={6}
                      value={formState.description}
                      onChange={e => onDescriptionChange(e.target.value)}
                      placeholder="Describe what this agent does..."
                      readOnly={readOnly}
                    />
                  </ShimmerWrapper>
                </FormControl>
              </Box>
            </Card>
          </Box>

          {/* Third Column - Agent's Credits Management */}
          <Box>
            <Card
              variant="outlined"
              sx={{
                border: 'none',
                background: 'transparent',
                p: 0,
                gap: 0,
                height: '100%',
              }}
            >
              <Typography level="body-xs" sx={{ fontWeight: 400, color: 'text.tertiary', mb: 1 }}>
                Agent&apos;s Credit Management
              </Typography>
              <AgentCreditManagement
                useOwnCredits={formState.creditSource === CREDIT_SOURCE.AGENT}
                currentCredits={formState.currentCredits || 0}
                userCredits={userCredits}
                agentId={agentId}
                readOnly={readOnly}
                onCreditSourceChange={onCreditSourceChange}
                onTransferCredits={onTransferCredits}
                onCurrentCreditsChange={onCurrentCreditsChange}
                onTransferComplete={onTransferComplete}
                onCreditsUpdate={onCreditsUpdate}
                setCurrentUser={setCurrentUser}
                currentUser={currentUser}
                showInfoText={true}
              />
            </Card>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default MainInformationSection;
