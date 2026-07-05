import React from 'react';
import { Card, Typography, Grid, FormControl, FormLabel, Textarea, Box } from '@mui/joy';
import ShimmerWrapper from '../ShimmerWrapper';
import AutoAwesomeIconButton from './AutoAwesomeIconButton';
import { FormState } from '../../types/agentForm';

interface CorePersonalitySectionProps {
  formState: FormState;
  shimmeringField: string | null;
  onNestedInputChange: (
    section: 'personality',
    field: string
  ) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onRandomizeField: (fieldName: string, currentValue?: string) => void;
  readOnly?: boolean;
}

const CorePersonalitySection: React.FC<CorePersonalitySectionProps> = ({
  formState,
  shimmeringField,
  onNestedInputChange,
  onRandomizeField,
  readOnly = false,
}) => {
  const personalityFields = [
    {
      fieldName: 'majorMotivation' as keyof FormState['personality'],
      label: 'Major Motivation',
      placeholder: 'Their primary driving force...',
    },
    {
      fieldName: 'minorMotivation' as keyof FormState['personality'],
      label: 'Minor Motivation',
      placeholder: 'Secondary motivations...',
    },
    {
      fieldName: 'quirk' as keyof FormState['personality'],
      label: 'Quirk',
      placeholder: 'Unique personality trait...',
    },
    {
      fieldName: 'flaw' as keyof FormState['personality'],
      label: 'Flaw',
      placeholder: 'Character weakness...',
    },
  ];

  return (
    <Card
      variant="outlined"
      sx={{
        height: '100%',
        backgroundColor: theme => theme.palette.background.body,
        border: theme => `1px solid ${theme.palette.border.soft}`,
        borderRadius: '8px',
        gap: 0,
        p: { xs: 2, sm: 3 },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
        <Typography level="title-md">Core Personality</Typography>
      </Box>

      <Grid sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr 1fr' }, gap: { xs: 2, sm: 3 } }}>
        {personalityFields.map(({ fieldName, label, placeholder }) => (
          <Box key={fieldName}>
            <FormControl size="sm" sx={{ mb: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <FormLabel sx={{ mb: 0, fontWeight: 400, color: 'text.primary50' }}>{label}</FormLabel>
                <AutoAwesomeIconButton
                  sx={{ width: '20px', height: '20px', minWidth: '20px', minHeight: '20px' }}
                  onClick={readOnly ? undefined : () => onRandomizeField(fieldName, formState.personality[fieldName])}
                  disabled={readOnly}
                />
              </Box>
              <ShimmerWrapper isShimmering={shimmeringField === fieldName} fieldName={fieldName}>
                <Textarea
                  sx={{
                    border: '1px solid',
                    borderColor: 'border.input',
                    backgroundColor: 'background.panel',
                    color: 'text.primary',
                    height: '100%',
                  }}
                  size="sm"
                  minRows={4}
                  maxRows={4}
                  value={formState.personality[fieldName]}
                  onChange={onNestedInputChange('personality', fieldName)}
                  placeholder={placeholder}
                  readOnly={readOnly}
                />
              </ShimmerWrapper>
            </FormControl>
          </Box>
        ))}
      </Grid>
    </Card>
  );
};

export default CorePersonalitySection;
