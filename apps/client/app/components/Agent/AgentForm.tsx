import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { IAgent, IAgentCapabilities } from '@bike4mind/common';
import { toast } from 'sonner';
import { AGENT_FORM_ID, DEFAULT_MAX_ITERATIONS } from '../../constants/agentForm';
import { isOrchestrationConfigured } from '../../utils/agentFormUtils';

import { Box, Grid, Button, Typography, Tooltip } from '@mui/joy';
import TuneIcon from '@mui/icons-material/Tune';

import {
  useFormState,
  useFormHandlers,
  useFormSections,
  useTagManagement,
  useImageBrowser,
  useImageUpload,
  useProjectManagement,
  useAgentImportExport,
  useAgentGeneration,
  useSystemPrompt,
  useAgentPageActions,
  useAvatarGeneration,
} from '@client/app/hooks/agent';
import AgentPageHeader from './AgentPageHeader';

import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

import MainInformationSection from './MainInformationSection';
import TriggerWordsSection from './TriggerWordsSection';
import CapabilitiesSection from './CapabilitiesSection';
import SystemPromptSection from './SystemPromptSection';
import AgencyPurposeSection from './AgencyPurposeSection';
import CorePersonalitySection from './CorePersonalitySection';
import EnhancedPersonalitySection from './EnhancedPersonalitySection';
import ModelConfigSection from './ModelConfigSection';
import OrchestrationSection from './OrchestrationSection';
import EmbedSnippetSection from './EmbedSnippetSection';
import ImportModal from './ImportModal';
import ImageBrowserModal from './ImageBrowserModal';

export type AgentFormActionsApi = {
  isSubmitting: boolean;
};

type AgentFormActionRenderer = (api: AgentFormActionsApi) => React.ReactNode;

interface AgentFormProps {
  mode: 'create' | 'edit' | 'view';

  initialData?: Partial<IAgent>;

  onSubmit: (data: Partial<IAgent>) => Promise<void>;

  isSubmitting?: boolean;
  isLoading?: boolean;

  readOnly?: boolean;

  title: string;
  subtitle?: string;

  titleIcon?: React.ReactNode;

  actions?: {
    create?: AgentFormActionRenderer;
    edit?: AgentFormActionRenderer;
    view?: AgentFormActionRenderer;
  };

  backTo?: string;
}

const AgentForm: React.FC<AgentFormProps> = ({
  mode,
  initialData,
  onSubmit,
  isSubmitting = false,
  isLoading = false,
  readOnly = false,
  title,
  subtitle,
  titleIcon,
  actions,
  backTo,
}) => {
  const { currentUser, setCurrentUser } = useUser();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Simple vs Full Custom mode - edit/view always use full custom
  const [formMode, setFormMode] = useState<'simple' | 'custom'>(mode === 'create' ? 'simple' : 'custom');
  const isSimple = formMode === 'simple';

  const { formState, updateFormState } = useFormState();

  const formHandlers = useFormHandlers(formState, updateFormState);

  const { updatePersonality, updateVisual, updateCapabilities } = useFormSections(formState, updateFormState);

  const tagManagement = useTagManagement();

  const imageBrowser = useImageBrowser();
  const imageUpload = useImageUpload((imageUrl: string) => {
    updateVisual({ portraitUrl: imageUrl });
  });

  const { projects, isLoadingProjects } = useProjectManagement();

  const importExport = useAgentImportExport(updateFormState);

  const generation = useAgentGeneration(
    formState,
    updateFormState,
    updatePersonality,
    updateCapabilities,
    initialData?.id
  );

  const systemPrompt = useSystemPrompt();

  const avatarGeneration = useAvatarGeneration({
    agentId: initialData?.id,
    onAvatarGenerated: (portraitUrl, generationPrompt) => {
      updateVisual({
        portraitUrl,
        generationPrompt,
      });
    },
  });

  const userCredits = (currentUser as any)?.currentCredits || 0;

  // Initialize form with initial data for edit/view modes
  useEffect(() => {
    if (mode !== 'create' && initialData) {
      // Parse capabilities if they exist
      let parsedCapabilities = {
        responseStyle: 'friendly' as const,
        specialBehaviors: [] as string[],
      };

      if (initialData.capabilities && initialData.capabilities.length > 0) {
        try {
          const capabilitiesData = JSON.parse(initialData.capabilities[0]);
          parsedCapabilities = {
            responseStyle: capabilitiesData.responseStyle || 'friendly',
            specialBehaviors: capabilitiesData.specialBehaviors || [],
          };
        } catch (error) {
          console.warn('Failed to parse capabilities:', error);
        }
      }

      // Update form state with initial data
      updateFormState({
        name: initialData.name || '',
        description: initialData.description || '',
        triggerWords: initialData.triggerWords || [],
        newTriggerWord: '',
        isPublic: initialData.isPublic || false,
        useOwnCredits: initialData.useOwnCredits || false,
        creditSource: initialData.useOwnCredits ? 'agent' : 'user', // Map useOwnCredits to creditSource
        currentCredits: initialData.currentCredits || 0,
        projectId: initialData.projectId || '',
        systemPrompt: (initialData as any).systemPrompt || '',
        preferredModel: ((initialData as Record<string, unknown>).preferredModel as string) || '',
        preferredImageModel: ((initialData as Record<string, unknown>).preferredImageModel as string) || '',
        temperature: ((initialData as Record<string, unknown>).temperature as number) ?? 0.9,
        maxTokens: ((initialData as Record<string, unknown>).maxTokens as number) ?? 4000,
        personality: {
          majorMotivation: initialData.personality?.majorMotivation || '',
          minorMotivation: initialData.personality?.minorMotivation || '',
          flaw: initialData.personality?.flaw || '',
          quirk: initialData.personality?.quirk || '',
          description: initialData.personality?.description || '',
          emotionalIntelligence: initialData.personality?.emotionalIntelligence || '',
          communicationPattern: initialData.personality?.communicationPattern || '',
          memoryStyle: initialData.personality?.memoryStyle || '',
          culturalFlavor: initialData.personality?.culturalFlavor || '',
          energyLevel: initialData.personality?.energyLevel || '',
          humorStyle: initialData.personality?.humorStyle || '',
          backstoryElement: initialData.personality?.backstoryElement || '',
          problemSolvingApproach: initialData.personality?.problemSolvingApproach || '',
          personalMission: initialData.personality?.personalMission || '',
          activeProject: initialData.personality?.activeProject || '',
          secretAmbition: initialData.personality?.secretAmbition || '',
          coreValues: initialData.personality?.coreValues || '',
          legacyAspiration: initialData.personality?.legacyAspiration || '',
          growthChallenge: initialData.personality?.growthChallenge || '',
          personalityComplexity: initialData.personality?.personalityComplexity || 'simple',
          generationTimestamp: initialData.personality?.generationTimestamp || '',
          uniqueId: initialData.personality?.uniqueId || '',
        },
        visual: {
          portraitUrl: initialData.visual?.portraitUrl || '',
          style: initialData.visual?.style || 'modern',
          generationPrompt: initialData.visual?.generationPrompt || '',
        },
        identity: {
          gender: initialData.identity?.gender || 'prefer-not-to-say',
          pronouns: {
            subject: initialData.identity?.pronouns?.subject || '',
            object: initialData.identity?.pronouns?.object || '',
            possessive: initialData.identity?.pronouns?.possessive || '',
            possessiveAdjective: initialData.identity?.pronouns?.possessiveAdjective || '',
            reflexive: initialData.identity?.pronouns?.reflexive || '',
          },
          customPronouns: initialData.identity?.customPronouns || '',
        },
        capabilities: {
          responseStyle: parsedCapabilities.responseStyle,
          specialBehaviors: parsedCapabilities.specialBehaviors,
          newBehavior: '',
        },
        orchestration: {
          allowedTools: initialData.allowedTools ?? [],
          deniedTools: initialData.deniedTools ?? [],
          maxIterations: initialData.maxIterations ?? { ...DEFAULT_MAX_ITERATIONS },
          defaultThoroughness: initialData.defaultThoroughness ?? '',
          // Server stores a `Record<string,string>`; the form keeps a stable per-row id
          // so React doesn't unmount inputs as the user types.
          defaultVariables: Object.entries(initialData.defaultVariables ?? {}).map(([key, value], i) => ({
            id: `loaded-${i}-${key}`,
            key,
            value,
          })),
          exclusiveMcpServers: initialData.exclusiveMcpServers ?? [],
          fallbackModels: initialData.fallbackModels ?? [],
        },
      });
    }
  }, [mode, initialData, updateFormState]);

  // Tag management with form integration
  const handleAddTriggerWord = useCallback(() => {
    tagManagement.addTriggerWord(formState.newTriggerWord, formState.triggerWords, updates => updateFormState(updates));
  }, [tagManagement, formState.newTriggerWord, formState.triggerWords, updateFormState]);

  const handleRemoveTriggerWord = useCallback(
    (word: string) => {
      tagManagement.removeTriggerWord(word, formState.triggerWords, updates => updateFormState(updates));
    },
    [tagManagement, formState.triggerWords, updateFormState]
  );

  const handleAddBehavior = useCallback(() => {
    tagManagement.addBehavior(formState.capabilities.newBehavior, formState.capabilities.specialBehaviors, updates =>
      updateFormState({ capabilities: { ...formState.capabilities, ...updates } })
    );
  }, [tagManagement, formState.capabilities, updateFormState]);

  const handleRemoveBehavior = useCallback(
    (behavior: string) => {
      tagManagement.removeBehavior(behavior, formState.capabilities.specialBehaviors, updates =>
        updateFormState({ capabilities: { ...formState.capabilities, ...updates } })
      );
    },
    [tagManagement, formState.capabilities, updateFormState]
  );

  // Belt-and-suspenders guard against rapid double-Enter submissions firing two
  // concurrent saves within one render cycle. The Save/Create button is also
  // disabled via `loading={isSubmitting}`, but Enter-key submission bypasses
  // that check because the in-flight state hasn't propagated through React yet.
  const isSubmittingRef = useRef(false);

  // Core submission logic - invoked by the form's onSubmit (Enter key) and by
  // the header action button. Decoupled from the DOM event so callers don't
  // need a synthetic event or `form.requestSubmit()` to trigger it.
  const doSubmit = useCallback(async () => {
    if (isSubmittingRef.current) return;
    if (!formState.name) {
      toast.error('Please provide a name for your agent');
      return;
    }

    if (formState.triggerWords.length === 0) {
      toast.error('Please add at least one trigger word');
      return;
    }

    // If seeding the agent with the user's own credits, require sufficient balance
    if (formState.useOwnCredits && formState.currentCredits > 0) {
      if (userCredits < formState.currentCredits) {
        toast.error(`You don't have enough credits. Your balance: ${userCredits.toLocaleString()}`);
        return;
      }
    }

    isSubmittingRef.current = true;
    try {
      const agentData: Partial<IAgent> = {
        name: formState.name,
        description: formState.description,
        triggerWords: formState.triggerWords,
        isPublic: formState.isPublic,
        useOwnCredits: formState.useOwnCredits,
        currentCredits: formState.currentCredits,
        projectId: formState.projectId,
        systemPrompt: formState.systemPrompt,
        preferredModel: formState.preferredModel || undefined,
        preferredImageModel: formState.preferredImageModel || undefined,
        temperature: formState.temperature,
        maxTokens: formState.maxTokens,
        personality: {
          majorMotivation: formState.personality.majorMotivation,
          minorMotivation: formState.personality.minorMotivation,
          flaw: formState.personality.flaw,
          quirk: formState.personality.quirk,
          description: formState.personality.description,
          emotionalIntelligence: formState.personality.emotionalIntelligence,
          communicationPattern: formState.personality.communicationPattern,
          memoryStyle: formState.personality.memoryStyle,
          culturalFlavor: formState.personality.culturalFlavor,
          energyLevel: formState.personality.energyLevel,
          humorStyle: formState.personality.humorStyle,
          backstoryElement: formState.personality.backstoryElement,
          problemSolvingApproach: formState.personality.problemSolvingApproach,
          personalMission: formState.personality.personalMission,
          activeProject: formState.personality.activeProject,
          secretAmbition: formState.personality.secretAmbition,
          coreValues: formState.personality.coreValues,
          legacyAspiration: formState.personality.legacyAspiration,
          growthChallenge: formState.personality.growthChallenge,
          personalityComplexity: formState.personality.personalityComplexity,
          generationTimestamp: formState.personality.generationTimestamp,
          uniqueId: formState.personality.uniqueId,
        },
        visual: {
          portraitUrl: formState.visual.portraitUrl,
          style: formState.visual.style,
          generationPrompt: formState.visual.generationPrompt,
        },
        identity: {
          gender: formState.identity.gender,
          pronouns: formState.identity.pronouns,
          customPronouns: formState.identity.customPronouns,
        },
        capabilities: [
          JSON.stringify({
            triggerWords: formState.triggerWords,
            responseStyle: formState.capabilities.responseStyle,
            specialBehaviors: formState.capabilities.specialBehaviors,
          } as IAgentCapabilities),
        ],
        // Orchestration - only include fields the user actually configured so
        // an unconfigured form doesn't accidentally promote a chat agent to
        // ReAct. The server's `hasOrchestrationFields` predicate keys off
        // presence; we mirror that intent here.
        ...(formState.orchestration.allowedTools.length > 0 && {
          allowedTools: formState.orchestration.allowedTools,
        }),
        ...(formState.orchestration.deniedTools.length > 0 && {
          deniedTools: formState.orchestration.deniedTools,
        }),
        ...(formState.orchestration.defaultThoroughness !== '' && {
          defaultThoroughness: formState.orchestration.defaultThoroughness,
        }),
        ...(formState.orchestration.exclusiveMcpServers.length > 0 && {
          exclusiveMcpServers: formState.orchestration.exclusiveMcpServers,
        }),
        ...(formState.orchestration.fallbackModels.length > 0 && {
          fallbackModels: formState.orchestration.fallbackModels,
        }),
        // maxIterations is always populated (defaults to 5/15/30) so we only
        // send it when the user has otherwise opted into orchestration -
        // otherwise a freshly-mounted chat agent would acquire the field on
        // first save and silently flip to ReAct mode.
        ...(isOrchestrationConfigured(formState.orchestration) && {
          maxIterations: formState.orchestration.maxIterations,
        }),
        // defaultVariables: drop empty/whitespace entries and serialize to a
        // Record so the wire shape matches the IAgent type.
        ...((): { defaultVariables?: Record<string, string> } => {
          const cleaned = formState.orchestration.defaultVariables.filter(v => v.key.trim());
          if (cleaned.length === 0) return {};
          return { defaultVariables: Object.fromEntries(cleaned.map(v => [v.key.trim(), v.value])) };
        })(),
      };

      // Add ID for edit mode
      if (mode === 'edit' && initialData?.id) {
        agentData.id = initialData.id;
      }

      await onSubmit(agentData);
    } catch (error) {
      console.error('Error submitting form:', error);
      toast.error('Failed to submit form. Please try again.');
    } finally {
      isSubmittingRef.current = false;
    }
  }, [formState, userCredits, mode, initialData, onSubmit]);

  // Form-event wrapper for Enter-key submission inside the form. The button-
  // driven path uses `doSubmit` directly so callers never touch the DOM event.
  const handleFormSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void doSubmit();
    },
    [doSubmit]
  );

  // Call the hook at the top level. The Create button it renders is a native
  // `type="submit"` associated with the form via `form={AGENT_FORM_ID}`, so the
  // browser routes both click and Enter-key into the form's submit event.
  const agentPageActions = useAgentPageActions({
    formState,
    isSubmitting,
    updateFormState,
    updatePersonality,
    updateCapabilities,
  });

  // Get header actions. External callers receive `isSubmitting` for loading
  // state; the button itself uses `type="submit" form={AGENT_FORM_ID}` to
  // associate with the form, so the browser routes click + Enter into the
  // form's submit event.
  const headerActions =
    actions?.[mode]?.({ isSubmitting }) ||
    (mode === 'create' || mode === 'edit' ? agentPageActions.rightActions : null);

  // Handle credit transfer - now handled internally in AgentCreditManagement
  const handleCreditsUpdate = useCallback(
    (agentCredits: number, userCredits: number) => {
      updateFormState({
        currentCredits: agentCredits,
      });
      if (currentUser && setCurrentUser) {
        setCurrentUser({
          ...currentUser,
          currentCredits: userCredits,
        });
      }
    },
    [updateFormState, currentUser, setCurrentUser]
  );

  const getBackToUrl = () => {
    if (backTo) {
      return backTo;
    }

    if (mode === 'create') {
      return '/agents';
    } else if (mode === 'edit' || mode === 'view') {
      return initialData?.id ? `/agents/${initialData.id}` : '/agents';
    }

    return '/agents';
  };

  const backToUrl = getBackToUrl();

  const titleAction = mode === 'create' ? 'Create' : mode === 'edit' ? 'Edit' : 'View';
  const trimmedName = formState.name.trim();
  useDocumentTitle(trimmedName ? `${titleAction} Agent: ${trimmedName}` : `${titleAction} Agent`);

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div>Loading...</div>
      </Box>
    );
  }

  return (
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
        pb: { xs: 2, sm: 3 },
        height: '100%',
        ...scrollbarStyles,
        '&::-webkit-scrollbar-track': {
          background: theme => theme.palette.background.surface2,
        },
      }}
    >
      <AgentPageHeader
        title={title}
        titleIcon={titleIcon}
        backButton={mode !== 'view'}
        backTo={backToUrl}
        rightActions={headerActions}
        scrollContainerRef={scrollContainerRef}
      />

      {/*
        `noValidate` disables HTML5 native form validation. All field validation
        happens in JS — `doSubmit` checks required fields, and number inputs
        clamp their own values in `onChange`. Without `noValidate`, an
        out-of-range or step-mismatched field would silently abort submission
        (no submit event dispatched, no error surfaced).
      */}
      <Box
        component="form"
        id={AGENT_FORM_ID}
        noValidate
        onSubmit={handleFormSubmit}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          maxWidth: '1312px',
          px: 2,
          mx: 'auto',
          width: '100%',
          pb: mode === 'create' ? '80px' : 0,
        }}
      >
        {/* Mode toggle + required note */}
        {mode === 'create' && (
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              <Typography sx={{ color: 'danger.500' }}>*</Typography> required
            </Typography>
            <Tooltip
              title={
                isSimple
                  ? 'Show all customization options: model config, orchestration, personality, and more'
                  : 'Show only essential fields: name, description, trigger words, and system prompt'
              }
              placement="bottom"
            >
              <Button
                data-testid={isSimple ? 'agent-form-switch-to-custom' : 'agent-form-switch-to-simple'}
                variant="outlined"
                color="neutral"
                size="sm"
                startDecorator={<TuneIcon />}
                onClick={() => setFormMode(isSimple ? 'custom' : 'simple')}
              >
                {isSimple ? 'Full Custom' : 'Simple Mode'}
              </Button>
            </Tooltip>
          </Box>
        )}

        <MainInformationSection
          formState={formState}
          projects={projects}
          isLoadingProjects={isLoadingProjects}
          isDraggingImage={imageUpload.isDraggingImage}
          isUploadingImage={imageUpload.isUploadingImage}
          userCredits={userCredits}
          shimmeringField={generation.shimmeringField}
          initialData={initialData}
          simplified={isSimple}
          onInputChange={formHandlers.handleInputChange}
          onNestedInputChange={formHandlers.handleNestedInputChange}
          onSquareSlideToggleChange={formHandlers.handleSquareSlideToggleChange}
          onProjectChange={formHandlers.handleProjectChange}
          onVisualStyleChange={value => updateVisual({ style: value })}
          onDescriptionChange={value => updateFormState({ description: value })}
          onGenerateDescription={generation.handleGenerateDescription}
          onOpenImageBrowser={imageBrowser.openImageBrowser}
          onDragEnter={imageUpload.handleDragEnter}
          onDragLeave={imageUpload.handleDragLeave}
          onDragOver={imageUpload.handleDragOver}
          onImageDrop={imageUpload.handleImageDrop}
          onCreditSourceChange={formHandlers.handleCreditSourceChange}
          onCurrentCreditsChange={value => updateFormState({ currentCredits: value })}
          onGenderIdentityChange={formHandlers.handleGenderIdentityChange}
          agentId={initialData?.id}
          onCreditsUpdate={mode === 'edit' ? handleCreditsUpdate : undefined}
          setCurrentUser={setCurrentUser}
          currentUser={currentUser}
          onGenerateAvatar={mode === 'edit' ? avatarGeneration.generateAvatar : undefined}
          isGeneratingDescription={generation.isGeneratingDescription}
          isGeneratingAvatar={avatarGeneration.isGeneratingAvatar}
          readOnly={readOnly}
        />

        <Grid container spacing={2}>
          <Grid xs={12} md={isSimple ? 12 : 6}>
            <TriggerWordsSection
              formState={formState}
              onInputChange={formHandlers.handleInputChange}
              onAddTriggerWord={handleAddTriggerWord}
              onRemoveTriggerWord={handleRemoveTriggerWord}
              readOnly={readOnly}
            />
          </Grid>

          {!isSimple && (
            <Grid xs={12} md={6}>
              <CapabilitiesSection
                formState={formState}
                shimmeringField={generation.shimmeringField}
                onResponseStyleChange={formHandlers.handleResponseStyleChange}
                onCapabilitiesChange={updateCapabilities}
                onAddBehavior={handleAddBehavior}
                onRemoveBehavior={handleRemoveBehavior}
                onRandomizeCapabilities={generation.handleRandomizeCapabilities}
                readOnly={readOnly}
              />
            </Grid>
          )}
        </Grid>

        <Grid xs={12}>
          <SystemPromptSection
            systemPrompt={formState.systemPrompt}
            shimmeringField={generation.shimmeringField}
            isDownloadingSystemPrompt={systemPrompt.isDownloadingSystemPrompt}
            isGeneratingSystemPrompt={generation.isGeneratingSystemPrompt}
            onSystemPromptChange={value => updateFormState({ systemPrompt: value })}
            onGenerateSystemPrompt={generation.handleGenerateSystemPrompt}
            onDownloadSystemPrompt={() =>
              systemPrompt.handleDownloadSystemPrompt(formState.systemPrompt, formState.name)
            }
            readOnly={readOnly}
          />
        </Grid>

        {/* Advanced sections — hidden in simple mode */}
        {!isSimple && (
          <>
            <Grid xs={12}>
              <ModelConfigSection
                formState={formState}
                onModelChange={value => updateFormState({ preferredModel: value })}
                onImageModelChange={value => updateFormState({ preferredImageModel: value })}
                onTemperatureChange={value => updateFormState({ temperature: value })}
                onMaxTokensChange={value => updateFormState({ maxTokens: value })}
                readOnly={readOnly}
              />
            </Grid>

            <Grid xs={12}>
              <OrchestrationSection
                value={formState.orchestration}
                onChange={next => updateFormState({ orchestration: next })}
                readOnly={readOnly}
              />
            </Grid>

            <Grid xs={12}>
              <AgencyPurposeSection
                formState={formState}
                shimmeringField={generation.shimmeringField}
                onNestedInputChange={formHandlers.handleNestedInputChange}
                onRandomizeField={generation.handleRandomizeField}
                readOnly={readOnly}
              />
            </Grid>

            <Grid xs={12}>
              <CorePersonalitySection
                formState={formState}
                shimmeringField={generation.shimmeringField}
                onNestedInputChange={formHandlers.handleNestedInputChange}
                onRandomizeField={generation.handleRandomizeField}
                readOnly={readOnly}
              />
            </Grid>

            <Grid xs={12}>
              <EnhancedPersonalitySection
                formState={formState}
                shimmeringField={generation.shimmeringField}
                onNestedInputChange={formHandlers.handleNestedInputChange}
                onRandomizeField={generation.handleRandomizeField}
                readOnly={readOnly}
              />
            </Grid>
          </>
        )}

        {mode === 'edit' && initialData?.id && (
          <Grid xs={12}>
            <EmbedSnippetSection
              agentId={initialData.id}
              agentName={formState.name}
              preferredModel={formState.preferredModel}
            />
          </Grid>
        )}
      </Box>

      {/* Modals - only show for create/edit modes */}
      {/* Modals - only show for create/edit modes */}
      {mode !== 'view' && (
        <>
          <ImportModal
            isOpen={importExport.isImportModalOpen}
            onClose={importExport.handleImportClose}
            importJsonText={importExport.importJsonText}
            onImportTextChange={importExport.setImportJsonText}
            importError={importExport.importError}
            isProcessing={importExport.isProcessingImport}
            onProcess={importExport.handleImportProcess}
          />

          <ImageBrowserModal
            isOpen={imageBrowser.isImageBrowserOpen}
            onClose={imageBrowser.closeImageBrowser}
            imageSearch={imageBrowser.imageSearch}
            onImageSearchChange={imageBrowser.setImageSearch}
            isLoadingImages={imageBrowser.isLoadingImages}
            imageFiles={imageBrowser.imageFiles}
            selectedImage={imageBrowser.selectedImage}
            onSelectImage={imageBrowser.selectImage}
            onApplyImage={file =>
              imageBrowser.applySelectedImage(file, imageUrl => updateVisual({ portraitUrl: imageUrl }))
            }
            onSearch={imageBrowser.fetchImageFiles}
          />
        </>
      )}

      {/* Sticky footer — pinned Create Agent button */}
      {(mode === 'create' || mode === 'edit') && (
        <Box
          sx={{
            position: 'sticky',
            bottom: 0,
            zIndex: 100,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 2,
            px: 3,
            py: 1.5,
            borderTop: '1px solid',
            borderColor: 'divider',
            backgroundColor: theme => theme.palette.background.surface2,
          }}
        >
          {headerActions}
        </Box>
      )}
    </Box>
  );
};

export default AgentForm;
