import React from 'react';
import { Card, Typography, FormControl, Input, Button, Stack, Chip, ChipDelete } from '@mui/joy';
import { FormState } from '../../types/agentForm';

interface TriggerWordsSectionProps {
  formState: FormState;
  onInputChange: (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAddTriggerWord: () => void;
  onRemoveTriggerWord: (word: string) => void;
  readOnly?: boolean;
}

const TriggerWordsSection: React.FC<TriggerWordsSectionProps> = ({
  formState,
  onInputChange,
  onAddTriggerWord,
  onRemoveTriggerWord,
  readOnly = false,
}) => {
  return (
    <Card
      variant="plain"
      sx={{
        backgroundColor: theme => theme.palette.background.body,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '8px',
        p: 2,
        gap: 0,
        height: '100%',
      }}
    >
      <Typography level="title-md" sx={{ mb: 2 }}>
        Trigger Words{' '}
        <Typography component="span" sx={{ color: 'danger.500' }} aria-hidden>
          *
        </Typography>
      </Typography>

      <FormControl size="sm" sx={{ position: 'relative' }}>
        <Stack direction="row" spacing={1} sx={{ position: 'relative' }}>
          <Input
            data-testid="agent-form-trigger-word"
            size="sm"
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              boxShadow: 'none',
              backgroundColor: 'background.panel',
              color: 'text.primary',
              pr: 9,
              width: '100%',
              '&::placeholder': { color: 'text.secondary' },
            }}
            placeholder="Words starting with @ that activate this agent (e.g., @help)"
            value={formState.newTriggerWord}
            onChange={onInputChange('newTriggerWord')}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), onAddTriggerWord())}
            readOnly={readOnly}
            // The section's "*" is aria-hidden; convey "required" to assistive tech too
            slotProps={{ input: { 'aria-required': true } }}
          />
          <Button
            data-testid="agent-form-trigger-word-add"
            size="sm"
            disabled={!formState.newTriggerWord.trim() || readOnly}
            onClick={readOnly ? undefined : onAddTriggerWord}
            sx={{
              position: 'absolute',
              top: '50%',
              right: '4px',
              transform: 'translateY(-50%)',
              height: '24px',
              minHeight: '24px',
              minWidth: '60px',
              fontSize: '12px',
              borderRadius: '6px',
              fontWeight: 600,
            }}
          >
            Add
          </Button>
        </Stack>
      </FormControl>

      {formState.triggerWords.length > 0 && (
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mt: 3, mb: 0 }}>
          {formState.triggerWords.map(word => (
            <Chip
              key={word}
              size="sm"
              color="primary"
              variant="soft"
              sx={{
                pr: '16px',
                pl: '12px',
                pt: '2px',
                pb: '2px',
                backgroundColor: 'background.panel',
                color: 'text.primary',
                border: '1px solid',
                borderColor: 'border.light',
              }}
              endDecorator={
                <ChipDelete
                  sx={{
                    width: '12px',
                    height: '12px',
                    minWidth: '12px',
                    minHeight: '12px',
                    backgroundColor: 'transparent',
                    right: '-4px',

                    '& svg': {
                      width: '10px',
                      height: '10px',
                    },
                  }}
                  onDelete={readOnly ? undefined : () => onRemoveTriggerWord(word)}
                />
              }
            >
              {word}
            </Chip>
          ))}
        </Stack>
      )}
    </Card>
  );
};

export default TriggerWordsSection;
