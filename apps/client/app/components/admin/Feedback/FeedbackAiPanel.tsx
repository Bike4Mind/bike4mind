import { useState } from 'react';
import { Button, FormControl, FormLabel, Option, Select, Stack, Typography } from '@mui/joy';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FEEDBACK_AI_AREAS,
  FEEDBACK_AI_SEVERITIES,
  type FeedbackAiLabels,
  type FeedbackAiView,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ActionDialog, AiSuggestion } from '../shared';
import { FEEDBACK_LIST_QUERY_KEY } from './queryKeys';
import { toast } from 'sonner';

export default function FeedbackAiPanel({ feedbackId }: { feedbackId: string }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<FeedbackAiLabels | null>(null);
  const query = useQuery({
    queryKey: ['feedback-ai', feedbackId],
    queryFn: async () => (await api.get<FeedbackAiView>(`/api/admin/feedback/${feedbackId}/ai`)).data,
    retry: false,
  });
  const data = query.data;
  if (!data?.suggestion) return null;
  const suggestion = data.suggestion;
  return (
    <Stack gap={1} data-testid="feedback-ai-panel">
      <AiSuggestion
        variant="detail"
        suggestion={{
          id: suggestion.id,
          proposal: `${suggestion.labels.area}, ${suggestion.labels.severity}; ${suggestion.labels.actionable ? 'actionable' : 'not actionable'}; ${suggestion.labels.needsReply ? 'needs reply' : 'no reply needed'}${suggestion.labels.duplicateId ? '; possible duplicate' : ''}`,
          probability: suggestion.probability,
          model: suggestion.model,
          createdAt: suggestion.createdAt,
          status: suggestion.status,
          reasons: [{ text: 'Advisory only. Review before acting.' }],
        }}
        onAccept={suggestion.status === 'pending' ? () => setDraft(suggestion.labels) : undefined}
        onOverride={suggestion.status === 'pending' ? () => setDraft(data.labels ?? suggestion.labels) : undefined}
        data-testid="feedback-ai-suggestion"
      />
      {data.labels && (
        <Typography level="body-sm">
          Labels: {data.labels.area}, {data.labels.severity}
        </Typography>
      )}
      {data.similar.length > 0 && <Typography level="title-sm">Similar reports</Typography>}
      {data.similar.map(item => (
        <Button
          key={item.id}
          component="a"
          href={`/admin?tab=feedback&feedbackId=${item.id}`}
          variant="plain"
          size="sm"
          data-testid={`feedback-ai-similar-${item.id}`}
        >
          {item.id}
          {suggestion.labels.duplicateId === item.id ? ' (suggested duplicate)' : ''}
        </Button>
      ))}
      <ActionDialog
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title="Set feedback labels"
        confirmLabel="Set labels"
        reasonPresets={['Accepted AI suggestion', 'Corrected labels']}
        initialReason={{ preset: 'Accepted AI suggestion', note: '' }}
        onConfirm={async reason => {
          try {
            await api.patch(`/api/admin/feedback/${feedbackId}/ai`, {
              suggestionId: suggestion.id,
              labels: draft,
              reason,
            });
          } catch (error) {
            toast.error('Could not set feedback labels. Refresh and try again.');
            throw error;
          }
          await client.invalidateQueries({ queryKey: ['feedback-ai'] });
          await client.invalidateQueries({ queryKey: FEEDBACK_LIST_QUERY_KEY });
          setDraft(null);
        }}
        data-testid="feedback-ai-label-dialog"
      >
        {draft && (
          <Stack gap={1}>
            <FormControl>
              <FormLabel>Area</FormLabel>
              <Select
                value={draft.area}
                onChange={(_, value) => value && setDraft({ ...draft, area: value })}
                slotProps={{ button: { 'data-testid': 'feedback-ai-area-select' } }}
              >
                {FEEDBACK_AI_AREAS.map(value => (
                  <Option key={value} value={value}>
                    {value}
                  </Option>
                ))}
              </Select>
            </FormControl>
            <FormControl>
              <FormLabel>Severity</FormLabel>
              <Select
                value={draft.severity}
                onChange={(_, value) => value && setDraft({ ...draft, severity: value })}
                slotProps={{ button: { 'data-testid': 'feedback-ai-severity-select' } }}
              >
                {FEEDBACK_AI_SEVERITIES.map(value => (
                  <Option key={value} value={value}>
                    {value}
                  </Option>
                ))}
              </Select>
            </FormControl>
            {(['actionable', 'needsReply'] as const).map(key => (
              <FormControl key={key}>
                <FormLabel>{key === 'needsReply' ? 'Needs reply' : 'Actionable'}</FormLabel>
                <Select
                  value={String(draft[key])}
                  onChange={(_, value) => value && setDraft({ ...draft, [key]: value === 'true' })}
                  slotProps={{ button: { 'data-testid': `feedback-ai-${key}-select` } }}
                >
                  <Option value="true">Yes</Option>
                  <Option value="false">No</Option>
                </Select>
              </FormControl>
            ))}
            <FormControl>
              <FormLabel>Duplicate suggestion</FormLabel>
              <Select
                value={draft.duplicateId ?? 'none'}
                onChange={(_, value) => value && setDraft({ ...draft, duplicateId: value === 'none' ? null : value })}
                slotProps={{ button: { 'data-testid': 'feedback-ai-duplicate-select' } }}
              >
                <Option value="none">None</Option>
                {data.similar.map(item => (
                  <Option key={item.id} value={item.id}>
                    {item.id}
                  </Option>
                ))}
              </Select>
            </FormControl>
          </Stack>
        )}
      </ActionDialog>
    </Stack>
  );
}
