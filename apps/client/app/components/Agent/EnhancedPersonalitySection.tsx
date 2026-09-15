import React from 'react';
import { Card, Typography, Grid, FormControl, FormLabel, Textarea, Box } from '@mui/joy';
import ShimmerWrapper from '../ShimmerWrapper';
import AutoAwesomeIconButton from './AutoAwesomeIconButton';
import { FormState } from '../../types/agentForm';

interface EnhancedPersonalitySectionProps {
  formState: FormState;
  shimmeringField: string | null;
  onNestedInputChange: (
    section: 'personality',
    field: string
  ) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onRandomizeField: (fieldName: string, currentValue?: string) => void;
  readOnly?: boolean;
}

const EnhancedPersonalitySection: React.FC<EnhancedPersonalitySectionProps> = ({
  formState,
  shimmeringField,
  onNestedInputChange,
  onRandomizeField,
  readOnly = false,
}) => {
  const enhancedFields = [
    {
      fieldName: 'emotionalIntelligence' as keyof FormState['personality'],
      label: 'Emotional Intelligence',
      placeholder: 'How they process emotions...',
    },
    {
      fieldName: 'communicationPattern' as keyof FormState['personality'],
      label: 'Communication Pattern',
      placeholder: 'How they structure conversations...',
    },
    {
      fieldName: 'memoryStyle' as keyof FormState['personality'],
      label: 'Memory Style',
      placeholder: 'How they process information...',
    },
    {
      fieldName: 'energyLevel' as keyof FormState['personality'],
      label: 'Energy Level',
      placeholder: 'Their energy and pacing...',
    },
    {
      fieldName: 'culturalFlavor' as keyof FormState['personality'],
      label: 'Cultural Flavor',
      placeholder: 'Cultural background and influences...',
    },
    {
      fieldName: 'humorStyle' as keyof FormState['personality'],
      label: 'Humor Style',
      placeholder: 'Their sense of humor and wit...',
    },
    {
      fieldName: 'backstoryElement' as keyof FormState['personality'],
      label: 'Backstory',
      placeholder: 'Their personal history and experiences...',
    },
    {
      fieldName: 'problemSolvingApproach' as keyof FormState['personality'],
      label: 'Problem Solving Approach',
      placeholder: 'How they approach challenges and problems...',
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
        <Typography level="title-md">Enhanced Personality Dimensions</Typography>
      </Box>

      <Grid sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' }, gap: { xs: 2, sm: 3 } }}>
        {enhancedFields.map(({ fieldName, label, placeholder }) => (
          <Box key={fieldName}>
            <FormControl size="sm">
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

export default EnhancedPersonalitySection;
