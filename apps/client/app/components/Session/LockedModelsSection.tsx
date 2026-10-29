import React from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import type { ModelInfo } from '@bike4mind/common';
import { visuallyHidden } from '@client/app/utils/a11yStyles';

type LockedModelsSectionProps = {
  models: ModelInfo[];
  /** Omitted when there is no in-app upgrade flow (billing off): the rows still explain why the models are locked. */
  onUpgrade?: () => void;
};

/**
 * Paid-only models a free account can see but not pick (see ModelInfo.access). Rows are deliberately inert so
 * nothing here can set the session model; the only action is the upgrade CTA.
 */
const LockedModelsSection = ({ models, onUpgrade }: LockedModelsSectionProps) => {
  if (models.length === 0) return null;

  return (
    <Box
      data-testid="locked-models-section"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        paddingInline: '8px',
        paddingBlock: '12px',
        borderTop: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <LockOutlinedIcon sx={{ fontSize: '18px', color: 'text.tertiary' }} />
          <Typography level="h4" sx={{ color: 'text.primary', fontSize: '16px', fontWeight: 500 }}>
            Available on paid plans
          </Typography>
        </Box>
        {onUpgrade && (
          <Button size="sm" variant="solid" color="primary" onClick={onUpgrade} data-testid="locked-models-upgrade-btn">
            Upgrade
          </Button>
        )}
      </Stack>
      <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
        {models.map(model => (
          <Box
            component="li"
            key={model.id}
            data-testid={`locked-model-row-${model.id}`}
            title="Upgrade to a paid plan to use this model"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              paddingBlock: '6px',
              paddingInline: '4px',
              cursor: 'not-allowed',
              opacity: 0.6,
            }}
          >
            <LockOutlinedIcon sx={{ fontSize: '16px', color: 'text.tertiary' }} />
            <Typography level="body-sm" sx={{ color: 'text.secondary' }} noWrap>
              {model.name}
            </Typography>
            <Box component="span" sx={visuallyHidden}>
              (requires a paid plan)
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

export default LockedModelsSection;
