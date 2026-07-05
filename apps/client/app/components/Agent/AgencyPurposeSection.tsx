import React from 'react';
import { Card, Typography, Grid, Box } from '@mui/joy';
import AgencyPurposeField from './AgencyPurposeField';
import { FormState } from '../../types/agentForm';

interface AgencyPurposeSectionProps {
  formState: FormState;
  shimmeringField: string | null;
  onNestedInputChange: (
    section: 'personality',
    field: string
  ) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onRandomizeField: (fieldName: string, currentValue?: string) => void;
  readOnly?: boolean;
}

const AgencyPurposeSection: React.FC<AgencyPurposeSectionProps> = ({
  formState,
  shimmeringField,
  onNestedInputChange,
  onRandomizeField,
  readOnly = false,
}) => {
  return (
    <Card
      variant="outlined"
      sx={{
        p: { xs: 2, sm: 3 },
        gap: 0,
        backgroundColor: theme => theme.palette.background.body,
        border: theme => `1px solid ${theme.palette.border.soft}`,
        borderRadius: '8px',
        height: '100%',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
        <Typography level="title-md">Agency & Purpose - What Makes Them REAL!</Typography>
      </Box>
      <Grid sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' }, gap: { xs: 2, sm: 3 } }}>
        <AgencyPurposeField
          fieldName="personalMission"
          label="Personal Mission"
          placeholder="Their burning life purpose..."
          shimmeringField={shimmeringField}
          value={formState.personality.personalMission}
          onChange={onNestedInputChange('personality', 'personalMission')}
          onRandomize={onRandomizeField}
          readOnly={readOnly}
        />
        <AgencyPurposeField
          fieldName="activeProject"
          label="Active Project"
          placeholder="What they're working on right now..."
          shimmeringField={shimmeringField}
          value={formState.personality.activeProject}
          onChange={onNestedInputChange('personality', 'activeProject')}
          onRandomize={onRandomizeField}
          readOnly={readOnly}
        />
        <AgencyPurposeField
          fieldName="secretAmbition"
          label="Secret Ambition"
          placeholder="Their hidden dream..."
          shimmeringField={shimmeringField}
          value={formState.personality.secretAmbition}
          onChange={onNestedInputChange('personality', 'secretAmbition')}
          onRandomize={onRandomizeField}
          readOnly={readOnly}
        />
        <AgencyPurposeField
          fieldName="coreValues"
          label="Core Values"
          placeholder="Their unshakeable beliefs..."
          shimmeringField={shimmeringField}
          value={formState.personality.coreValues}
          onChange={onNestedInputChange('personality', 'coreValues')}
          onRandomize={onRandomizeField}
          readOnly={readOnly}
        />
        <AgencyPurposeField
          fieldName="legacyAspiration"
          label="Legacy Aspiration"
          placeholder="How they want to be remembered..."
          shimmeringField={shimmeringField}
          value={formState.personality.legacyAspiration}
          onChange={onNestedInputChange('personality', 'legacyAspiration')}
          onRandomize={onRandomizeField}
          readOnly={readOnly}
        />
        <AgencyPurposeField
          fieldName="growthChallenge"
          label="Growth Challenge"
          placeholder="Current personal struggle..."
          shimmeringField={shimmeringField}
          value={formState.personality.growthChallenge}
          onChange={onNestedInputChange('personality', 'growthChallenge')}
          onRandomize={onRandomizeField}
          readOnly={readOnly}
        />
      </Grid>
    </Card>
  );
};

export default AgencyPurposeSection;
