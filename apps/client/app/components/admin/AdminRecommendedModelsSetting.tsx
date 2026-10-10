import React, { useMemo, useState } from 'react';
import { Box, Button, Card, Chip, IconButton, Option, Select, Stack, Tooltip, Typography } from '@mui/joy';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import CloseIcon from '@mui/icons-material/Close';
import SaveIcon from '@mui/icons-material/Save';
import { toast } from 'sonner';
import type { ModelInfo } from '@bike4mind/common';
import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { useAccessibleModels } from '@client/app/hooks/useAccessibleModels';
import { resolveRecommendedModelIds } from '@client/app/utils/recommendedModels';

const emptyIds: string[] = [];

const RecommendedModelsEditor: React.FC<{ storedIds: string[]; defaultModelId: unknown }> = ({
  storedIds,
  defaultModelId,
}) => {
  const updateSettings = useUpdateSettings();
  // Same source as the picker, so "unavailable" here means the picker would skip the id too.
  const { accessibleTextModels, isLoading } = useAccessibleModels();
  const [draft, setDraft] = useState<string[]>(storedIds);

  const modelsById = useMemo(
    () => new Map<string, ModelInfo>(accessibleTextModels.map(m => [m.id, m])),
    [accessibleTextModels]
  );
  const addable = useMemo(
    () => accessibleTextModels.filter(m => !draft.includes(m.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [accessibleTextModels, draft]
  );
  const isDirty = draft.join('\n') !== storedIds.join('\n');
  const fallbackId = resolveRecommendedModelIds([], defaultModelId)[0] ?? '';

  const move = (index: number, delta: -1 | 1) =>
    setDraft(prev => {
      const next = [...prev];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });

  const handleSave = () =>
    updateSettings.mutate(
      { key: 'recommendedModelIds', value: draft },
      {
        onSuccess: () => toast.success('Recommended models updated'),
        onError: (error: Error) => toast.error(`Failed to update recommended models: ${error.message}`),
      }
    );

  return (
    <Card variant="outlined" sx={{ mb: 2, p: 3 }} data-testid="admin-recommended-models-card">
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <AutoAwesomeRoundedIcon sx={{ mr: 1, color: 'primary.plainColor' }} />
        <Typography level="h4">Recommended Models</Typography>
      </Box>
      <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
        Models pinned in the Recommended group at the top of the model picker, shown in this order.
      </Typography>

      <Stack spacing={1} sx={{ mb: 2 }}>
        {draft.length === 0 && (
          <Typography level="body-sm" data-testid="admin-recommended-models-empty">
            Empty: the picker recommends the Default API Model ({modelsById.get(fallbackId)?.name ?? fallbackId}).
          </Typography>
        )}
        {draft.map((id, index) => {
          const info = modelsById.get(id);
          const label = info?.name ?? id;
          return (
            <Box
              key={id}
              data-testid={`admin-recommended-models-row-${id}`}
              sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography level="title-sm">{label}</Typography>
                {info && (
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    {id}
                  </Typography>
                )}
              </Box>
              {!info && !isLoading && (
                <Tooltip title="Not in the model list; the picker skips it" placement="top">
                  <Chip
                    size="sm"
                    color="warning"
                    variant="soft"
                    data-testid={`admin-recommended-models-${id}-unavailable`}
                  >
                    Unavailable
                  </Chip>
                </Tooltip>
              )}
              <IconButton
                size="sm"
                aria-label={`Move ${label} up`}
                data-testid={`admin-recommended-models-${id}-up-btn`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUpwardIcon />
              </IconButton>
              <IconButton
                size="sm"
                aria-label={`Move ${label} down`}
                data-testid={`admin-recommended-models-${id}-down-btn`}
                disabled={index === draft.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDownwardIcon />
              </IconButton>
              <IconButton
                size="sm"
                color="danger"
                aria-label={`Remove ${label}`}
                data-testid={`admin-recommended-models-${id}-remove-btn`}
                onClick={() => setDraft(prev => prev.filter(x => x !== id))}
              >
                <CloseIcon />
              </IconButton>
            </Box>
          );
        })}
      </Stack>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Select
          size="sm"
          sx={{ flex: 1 }}
          placeholder="Add a model"
          value={null}
          disabled={addable.length === 0}
          onChange={(_, id: string | null) => id && setDraft(prev => [...prev, id])}
          slotProps={{ button: { 'data-testid': 'admin-recommended-models-add-select' } }}
        >
          {addable.map(m => (
            <Option key={m.id} value={m.id} data-testid={`admin-recommended-models-option-${m.id}`}>
              {m.name}
            </Option>
          ))}
        </Select>
        <Tooltip title="Save recommended models" placement="top">
          <Button
            color="success"
            size="sm"
            data-testid="admin-recommended-models-save-btn"
            loading={updateSettings.isPending}
            disabled={!isDirty}
            onClick={handleSave}
          >
            <SaveIcon sx={{ marginX: 1 }} />
          </Button>
        </Tooltip>
      </Box>
    </Card>
  );
};

/** Ordered editor for the `recommendedModelIds` admin setting. */
export const AdminRecommendedModelsSetting: React.FC = () => {
  const { getSetting, getSettingObject } = useAdminSettings();
  const stored = getSettingObject<unknown>('recommendedModelIds', emptyIds);
  const storedIds = useMemo(
    () =>
      Array.isArray(stored) ? [...new Set(stored.filter((id): id is string => typeof id === 'string' && !!id))] : [],
    [stored]
  );
  // Keyed on the stored list so a save (or another admin's change arriving on refetch) resets the draft.
  return (
    <RecommendedModelsEditor
      key={storedIds.join('\n')}
      storedIds={storedIds}
      defaultModelId={getSetting('DefaultAPIModel')}
    />
  );
};
