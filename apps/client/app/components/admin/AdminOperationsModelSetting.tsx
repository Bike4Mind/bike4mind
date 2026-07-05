import React, { useState, useEffect } from 'react';
import {
  Card,
  FormControl,
  FormLabel,
  Select,
  Option,
  Button,
  Typography,
  Chip,
  Box,
  FormHelperText,
  Alert,
  CircularProgress,
} from '@mui/joy';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import SaveIcon from '@mui/icons-material/Save';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { toast } from 'sonner';

interface OperationsModelConfig {
  modelId: string;
  imageModelId: string;
  speechModelId: string;
}

interface OperationsModelResponse {
  success: boolean;
  config: OperationsModelConfig;
  activeModel: {
    id: string;
    name: string;
    imageModelId: string;
    imageModelName: string;
    speechModelId: string;
    speechModelName: string;
  };
}

export const AdminOperationsModelSetting: React.FC = () => {
  const { data: models } = useModelInfo();
  const queryClient = useQueryClient();

  const {
    data: currentConfig,
    isLoading: configLoading,
    error,
  } = useQuery({
    queryKey: ['operationsModel'],
    queryFn: async () => {
      const response = await api.get('/api/admin/operations-model');
      return response.data as OperationsModelConfig;
    },
  });

  const [selectedModel, setSelectedModel] = useState<string>('');
  const [selectedImageModel, setSelectedImageModel] = useState<string>('');
  const [selectedSpeechModel, setSelectedSpeechModel] = useState<string>('');

  // Update local state when config loads
  useEffect(() => {
    if (currentConfig) {
      setSelectedModel(currentConfig.modelId);
      setSelectedImageModel(currentConfig.imageModelId);
      setSelectedSpeechModel(currentConfig.speechModelId);
    }
  }, [currentConfig]);

  const updateMutation = useMutation({
    mutationFn: async (config: OperationsModelConfig) => {
      const response = await api.put('/api/admin/operations-model', config);
      return response.data as OperationsModelResponse;
    },
    onSuccess: data => {
      toast.success(
        `Operations model updated to ${data.activeModel.name}, ${data.activeModel.imageModelName} & ${data.activeModel.speechModelName}`
      );
      queryClient.invalidateQueries({ queryKey: ['operationsModel'] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to update operations model: ${error.message}`);
    },
  });

  const currentModelInfo = models?.find(m => m.id === selectedModel);
  const currentImageModelInfo = models?.find(m => m.id === selectedImageModel);

  const speechModels = models?.filter(m => m.type === 'speech-to-text') || [];
  const allSpeechModels = [...speechModels];

  const currentSpeechModelInfo = allSpeechModels.find(m => m.id === selectedSpeechModel);

  const isDirty =
    selectedModel !== currentConfig?.modelId ||
    selectedImageModel !== currentConfig?.imageModelId ||
    selectedSpeechModel !== currentConfig?.speechModelId;

  // Group text models by provider
  const modelsByProvider = models?.reduce(
    (acc, model) => {
      if (model.type === 'text') {
        const provider = model.backend || 'unknown';
        if (!acc[provider]) acc[provider] = [];
        acc[provider].push(model);
      }
      return acc;
    },
    {} as Record<string, typeof models>
  );

  const imageModelsByProvider = models?.reduce(
    (acc, model) => {
      if (model.type === 'image') {
        const provider = model.backend || 'unknown';
        if (!acc[provider]) acc[provider] = [];
        acc[provider].push(model);
      }
      return acc;
    },
    {} as Record<string, typeof models>
  );

  // Group speech models by provider
  const speechModelsByProvider = allSpeechModels.reduce(
    (acc, model) => {
      const provider = model.backend || 'unknown';
      if (!acc[provider]) acc[provider] = [];
      acc[provider].push(model);
      return acc;
    },
    {} as Record<string, typeof allSpeechModels>
  );

  const handleSave = () => {
    if (!selectedModel || !selectedImageModel) return;

    const config: OperationsModelConfig = {
      modelId: selectedModel,
      imageModelId: selectedImageModel,
      speechModelId: selectedSpeechModel,
    };

    updateMutation.mutate(config);
  };

  const handleReset = () => {
    if (currentConfig) {
      setSelectedModel(currentConfig.modelId);
      setSelectedImageModel(currentConfig.imageModelId);
      setSelectedSpeechModel(currentConfig.speechModelId);
    }
  };

  if (configLoading) {
    return (
      <Card variant="outlined" sx={{ mb: 2, p: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
        <CircularProgress size="sm" />
        <Typography>Loading operations model configuration...</Typography>
      </Card>
    );
  }

  if (error) {
    console.error(error);
    return (
      <Card variant="outlined" sx={{ mb: 2, p: 3 }}>
        <Alert color="danger" startDecorator={<ErrorIcon />}>
          Failed to load operations model configuration
        </Alert>
      </Card>
    );
  }

  return (
    <Card variant="outlined" sx={{ mb: 2, p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
        <SmartToyIcon sx={{ mr: 1, color: 'primary.main' }} />
        <Typography level="h4">Operations Model</Typography>
      </Box>

      <FormHelperText sx={{ mb: 3 }}>
        The text model will be used for these background operations: auto-rename sessions, notebook summarization &
        tagging, smart file naming, agent descriptions, and translations.
        <br />
        The image model will be used for these background operations: agent avatars, image generation, and editing.
        <br />
        The speech model will be used for these background operations: audio transcription and speech-to-text
        conversion.
      </FormHelperText>

      <FormControl sx={{ mb: 2 }}>
        <FormLabel>Primary Operations Model</FormLabel>
        <Select
          value={selectedModel}
          onChange={(_, value) => {
            // Filter out header values
            if (value && !value.startsWith('__header_')) {
              setSelectedModel(value);
            }
          }}
          placeholder="Choose a model..."
        >
          {Object.entries(modelsByProvider || {})
            .map(([provider, providerModels]) => [
              <Option key={`${provider}-header`} value={`__header_${provider}`} disabled>
                <Typography
                  level="body-xs"
                  sx={{ fontWeight: 'bold', textTransform: 'uppercase', color: 'text.primary50' }}
                >
                  {provider}
                </Typography>
              </Option>,
              ...providerModels!.map(model => (
                <Option key={model.id} value={model.id}>
                  <Typography sx={{ color: 'text.primary' }}>{model.name}</Typography>
                </Option>
              )),
            ])
            .flat()}
        </Select>
      </FormControl>

      <FormControl sx={{ mb: 3 }}>
        <FormLabel>Image Generation Model</FormLabel>
        <Select
          value={selectedImageModel}
          onChange={(_, value) => {
            // Filter out header values
            if (value && !value.startsWith('__header_')) {
              setSelectedImageModel(value);
            }
          }}
          placeholder="Choose an image model..."
        >
          {Object.entries(imageModelsByProvider || {})
            .map(([provider, providerModels]) => [
              <Option key={`${provider}-header-image`} value={`__header_image_${provider}`} disabled>
                <Typography
                  level="body-xs"
                  sx={{ fontWeight: 'bold', textTransform: 'uppercase', color: 'text.primary50' }}
                >
                  {provider}
                </Typography>
              </Option>,
              ...providerModels!.map(model => (
                <Option key={`image-${model.id}`} value={model.id}>
                  <Typography sx={{ color: 'text.primary' }}>{model.name}</Typography>
                </Option>
              )),
            ])
            .flat()}
        </Select>
      </FormControl>

      <FormControl sx={{ mb: 3 }}>
        <FormLabel>Speech-to-Text Model</FormLabel>
        <Select
          value={selectedSpeechModel}
          onChange={(_, value) => {
            // Filter out header values
            if (value && !value.startsWith('__header_')) {
              setSelectedSpeechModel(value);
            }
          }}
          placeholder="Choose a speech model..."
        >
          {Object.entries(speechModelsByProvider || {})
            .map(([provider, providerModels]) => [
              <Option key={`${provider}-header-speech`} value={`__header_speech_${provider}`} disabled>
                <Typography
                  level="body-xs"
                  sx={{ fontWeight: 'bold', textTransform: 'uppercase', color: 'text.primary50' }}
                >
                  {provider}
                </Typography>
              </Option>,
              ...providerModels!.map(model => (
                <Option key={`speech-${model.id}`} value={model.id}>
                  <Typography sx={{ color: 'text.primary' }}>{model.name}</Typography>
                </Option>
              )),
            ])
            .flat()}
        </Select>
      </FormControl>

      {(currentModelInfo || currentImageModelInfo || currentSpeechModelInfo) && (
        <Alert sx={{ mb: 2 }} startDecorator={<CheckCircleIcon />}>
          <Box>
            {currentModelInfo && (
              <Typography level="body-sm" sx={{ wordBreak: 'break-word' }}>
                <strong>Text Model:</strong> {currentModelInfo.name} ({currentModelInfo.backend})
              </Typography>
            )}
            {currentImageModelInfo && (
              <Typography level="body-sm" sx={{ wordBreak: 'break-word' }}>
                <strong>Image Model:</strong> {currentImageModelInfo.name} ({currentImageModelInfo.backend})
              </Typography>
            )}
            {currentSpeechModelInfo && (
              <Typography level="body-sm" sx={{ wordBreak: 'break-word' }}>
                <strong>Speech Model:</strong> {currentSpeechModelInfo.name} ({currentSpeechModelInfo.backend})
              </Typography>
            )}
            <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {currentModelInfo?.supportsTools && (
                <Chip size="sm" color="success">
                  Tools
                </Chip>
              )}
              {currentModelInfo?.supportsVision && (
                <Chip size="sm" color="success">
                  Vision
                </Chip>
              )}
              {currentModelInfo?.contextWindow && (
                <Chip size="sm" color="neutral">
                  {(currentModelInfo?.contextWindow / 1000).toFixed(0)}K context
                </Chip>
              )}
            </Box>
          </Box>
        </Alert>
      )}

      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button
          color="success"
          disabled={!isDirty || !selectedModel || !selectedImageModel || !selectedSpeechModel}
          loading={updateMutation.isPending}
          onClick={handleSave}
          startDecorator={<SaveIcon />}
        >
          Save Operations Model
        </Button>

        <Button variant="outlined" color="neutral" disabled={!isDirty} onClick={handleReset}>
          Reset
        </Button>
      </Box>

      <Typography level="body-xs" sx={{ mt: 2, color: 'text.secondary' }}>
        <strong>Note:</strong> Changes take effect immediately for new operations. Existing background jobs will
        complete with their current model.
      </Typography>
    </Card>
  );
};
