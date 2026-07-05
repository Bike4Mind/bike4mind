import React from 'react';
import {
  Card,
  Typography,
  FormControl,
  FormLabel,
  Input,
  Button,
  Stack,
  Chip,
  ChipDelete,
  Select,
  Option,
  Box,
} from '@mui/joy';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { FormState } from '../../types/agentForm';
import { RESPONSE_STYLES } from '../../constants/agentForm';
import ShimmerWrapper from '../ShimmerWrapper';
import AutoAwesomeIconButton from './AutoAwesomeIconButton';

interface CapabilitiesSectionProps {
  formState: FormState;
  shimmeringField: string | null;
  onResponseStyleChange: (value: string | null) => void;
  onCapabilitiesChange: (updates: any) => void;
  onAddBehavior: () => void;
  onRemoveBehavior: (behavior: string) => void;
  onRandomizeCapabilities: () => void;
  readOnly?: boolean;
}

const CapabilitiesSection: React.FC<CapabilitiesSectionProps> = ({
  formState,
  shimmeringField,
  onResponseStyleChange,
  onCapabilitiesChange,
  onAddBehavior,
  onRemoveBehavior,
  onRandomizeCapabilities,
  readOnly = false,
}) => {
  return (
    <Card
      variant="outlined"
      sx={{
        backgroundColor: theme => theme.palette.background.body,
        border: theme => `1px solid ${theme.palette.border.soft}`,
        borderRadius: '8px',
        p: { xs: 2, sm: 3 },
        gap: 0,
        height: '100%',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <Typography level="title-md">Capabilities</Typography>
          <Typography level="body-xs" sx={{ mt: 0.5, mb: 3, color: 'text.primary50' }}>
            Response Style & Special Behaviors
          </Typography>
        </Box>
        <AutoAwesomeIconButton onClick={readOnly ? undefined : onRandomizeCapabilities} disabled={readOnly} />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
        {/* First Column - Response Style */}
        <FormControl size="sm">
          <FormLabel sx={{ fontWeight: 400, color: 'text.primary50' }}>Response Style</FormLabel>
          <ShimmerWrapper isShimmering={shimmeringField === 'all'} fieldName="responseStyle">
            <Select
              size="sm"
              sx={{
                border: '1px solid',
                borderColor: 'border.input',
                backgroundColor: 'background.panel',
                color: 'text.primary',
                boxShadow: 'none',
              }}
              indicator={<KeyboardArrowDownIcon />}
              value={formState.capabilities.responseStyle}
              onChange={(_, value) => onResponseStyleChange(value)}
              disabled={readOnly}
            >
              {RESPONSE_STYLES.map(style => (
                <Option key={style.value} value={style.value}>
                  {style.label}
                </Option>
              ))}
            </Select>
          </ShimmerWrapper>
        </FormControl>

        {/* Second Column - Add Special Behavior */}
        <FormControl size="sm">
          <FormLabel sx={{ fontWeight: 400, color: 'text.primary50' }}>Special Behaviors</FormLabel>
          <Stack direction="row" spacing={1} sx={{ position: 'relative' }}>
            <Input
              size="sm"
              sx={{
                flexGrow: 1,
                border: '1px solid',
                borderColor: 'border.input',
                backgroundColor: 'background.panel',
                color: 'text.primary',
                boxShadow: 'none',
              }}
              placeholder="Add special behavior"
              value={formState.capabilities.newBehavior}
              onChange={e =>
                onCapabilitiesChange({
                  newBehavior: e.target.value,
                })
              }
              onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), onAddBehavior())}
              readOnly={readOnly}
            />
            <Button
              size="sm"
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
              disabled={!formState.capabilities.newBehavior.trim() || readOnly}
              onClick={readOnly ? undefined : onAddBehavior}
            >
              Add
            </Button>
          </Stack>
        </FormControl>
      </Box>

      <Box>
        <ShimmerWrapper isShimmering={shimmeringField === 'all'} fieldName="specialBehaviors">
          <Box>
            {formState.capabilities.specialBehaviors.length > 0 && (
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mt: 3 }}>
                {formState.capabilities.specialBehaviors.map(behavior => (
                  <Chip
                    key={behavior}
                    size="sm"
                    color="neutral"
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
                          right: '-2px',

                          '& svg': {
                            width: '10px',
                            height: '10px',
                          },
                        }}
                        onDelete={readOnly ? undefined : () => onRemoveBehavior(behavior)}
                      />
                    }
                  >
                    {behavior}
                  </Chip>
                ))}
              </Stack>
            )}
          </Box>
        </ShimmerWrapper>
      </Box>
    </Card>
  );
};

export default CapabilitiesSection;
