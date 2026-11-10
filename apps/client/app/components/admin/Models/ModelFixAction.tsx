import type { ReactElement } from 'react';
import { Button } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import type { AdminModelFixAction } from '@bike4mind/common';
import { ADMIN_SETTINGS_SEARCH_PARAM, ADMIN_SETTINGS_TAB_SLUG } from '../adminTabParams';
import { useRunDiscoveryNow } from './Discovery/runDiscoveryNow';
import { MODEL_FIX_ACTION_LABEL } from './modelPresentation';
import { ModelWriteAction } from './ModelWriteAction';
import { useModelsNavigation } from './modelsNavigation';

type Props = {
  action: AdminModelFixAction;
  model: { id: string; backend: string };
  /** Turn on opens the caller's access dialog. */
  onTurnOn: () => void;
  'data-testid'?: string;
};

/** Starts the shared Run now, so this and the header's Run discovery disable together while a run is in flight. */
function RunDiscoveryFix({ button }: { button: (onClick: () => void, disabled: boolean) => ReactElement }) {
  const { runNow, announceFinished, busy } = useRunDiscoveryNow();
  const { openSection } = useModelsNavigation();

  const run = async () => {
    const outcome = await runNow(announceFinished);
    if (outcome.kind === 'failed') {
      toast.error(
        outcome.message,
        outcome.discoveryOff
          ? { action: { label: 'Open settings', onClick: () => void openSection('settings') } }
          : undefined
      );
    } else if (outcome.kind === 'gave-up') {
      toast(outcome.message);
    }
  };

  return <ModelWriteAction>{disabled => button(() => void run(), disabled || busy)}</ModelWriteAction>;
}

/** The button a reason's fix action names; the reason and the action come from the server. */
export function ModelFixAction({ action, model, onTurnOn, 'data-testid': testId = 'models-fix-action-btn' }: Props) {
  const navigate = useNavigate();
  const { openPrices, openSection } = useModelsNavigation();
  const label = MODEL_FIX_ACTION_LABEL[action];

  const button = (onClick: () => void, disabled = false) => (
    <Button
      size="sm"
      variant="plain"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      data-action={action}
      sx={{ minHeight: 24, px: 1, flexShrink: 0 }}
    >
      {label}
    </Button>
  );

  switch (action) {
    case 'turn-on':
      return <ModelWriteAction>{disabled => button(onTurnOn, disabled)}</ModelWriteAction>;
    case 'add-price':
      return button(() => void openPrices(model.id));
    case 'run-discovery':
      return <RunDiscoveryFix button={button} />;
    case 'review-lifecycle':
      return button(() => void openSection('discovery'));
    case 'open-key-settings':
      return button(
        () =>
          void navigate({
            to: '/admin',
            search: { tab: ADMIN_SETTINGS_TAB_SLUG, [ADMIN_SETTINGS_SEARCH_PARAM]: model.backend },
          })
      );
  }
}
