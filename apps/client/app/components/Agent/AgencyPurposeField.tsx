import React from 'react';
import { Grid, FormControl, FormLabel, Textarea, Box } from '@mui/joy';
import ShimmerWrapper from '../ShimmerWrapper';
import AutoAwesomeIconButton from './AutoAwesomeIconButton';
import { AgencyPurposeFieldProps } from '../../types/agentForm';

const AgencyPurposeField: React.FC<AgencyPurposeFieldProps> = ({
  fieldName,
  label,
  placeholder,
  shimmeringField,
  value,
  onChange,
  onRandomize,
  readOnly = false,
}) => {
  return (
    <Grid>
      <FormControl size="sm" sx={{ mb: 0, height: '100%' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <FormLabel sx={{ mb: 0, fontWeight: 400, color: 'text.primary50' }}>{label}</FormLabel>
          <AutoAwesomeIconButton
            sx={{ width: '20px', height: '20px', minWidth: '20px', minHeight: '20px' }}
            onClick={readOnly ? undefined : () => onRandomize(fieldName, value)}
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
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            readOnly={readOnly}
          />
        </ShimmerWrapper>
      </FormControl>
    </Grid>
  );
};

export default AgencyPurposeField;
