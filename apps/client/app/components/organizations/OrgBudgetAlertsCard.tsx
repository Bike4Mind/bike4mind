import { ORG_ALERT_MAX_PERCENT_THRESHOLDS, type IOrgBudgetAlerts } from '@bike4mind/common';
import { useOrgAlertSettings, useUpdateOrgAlertSettings } from '@client/app/hooks/data/organizations';
import {
  Button,
  Card,
  Chip,
  ChipDelete,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Stack,
  Switch,
  Typography,
} from '@mui/joy';
import { FC, useEffect, useRef, useState } from 'react';

const DEFAULT_PERCENT_THRESHOLDS = [50, 80, 100];

/** '' means "not set" (null); anything else must be a whole number at or above `min`. */
const parseCredits = (value: string, min: number): number | null | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : undefined;
};

/** Owner/manager editor for the org's budget and low-balance alert thresholds. */
const OrgBudgetAlertsCard: FC<{ organizationId: string }> = ({ organizationId }) => {
  const { data: saved, isSuccess } = useOrgAlertSettings(organizationId);
  const updateSettings = useUpdateOrgAlertSettings();
  const saving = useRef(false);
  const locked = !isSuccess || updateSettings.isPending;
  const editDraft = (update: () => void) => {
    if (saving.current || locked) return;
    update();
  };

  const [enabled, setEnabled] = useState(false);
  const [budget, setBudget] = useState('');
  const [thresholds, setThresholds] = useState<number[]>(DEFAULT_PERCENT_THRESHOLDS);
  const [newThreshold, setNewThreshold] = useState('');
  const [lowBalance, setLowBalance] = useState('');

  useEffect(() => {
    if (!isSuccess) return;
    setEnabled(saved?.enabled ?? false);
    setBudget(saved?.monthlyBudgetCredits != null ? String(saved.monthlyBudgetCredits) : '');
    setThresholds(saved ? saved.percentThresholds : DEFAULT_PERCENT_THRESHOLDS);
    setLowBalance(saved?.lowBalanceCredits != null ? String(saved.lowBalanceCredits) : '');
  }, [isSuccess, saved]);

  const budgetValue = parseCredits(budget, 1);
  const lowBalanceValue = parseCredits(lowBalance, 0);
  const newThresholdValue = parseCredits(newThreshold, 1);
  const canAddThreshold =
    newThresholdValue != null &&
    newThresholdValue <= 100 &&
    !thresholds.includes(newThresholdValue) &&
    thresholds.length < ORG_ALERT_MAX_PERCENT_THRESHOLDS;
  const valid = budgetValue !== undefined && lowBalanceValue !== undefined;

  const addThreshold = () => {
    if (saving.current || locked || !canAddThreshold || newThresholdValue == null) return;
    setThresholds([...thresholds, newThresholdValue].sort((a, b) => a - b));
    setNewThreshold('');
  };

  const handleSave = () => {
    if (saving.current || locked || budgetValue === undefined || lowBalanceValue === undefined) return;
    const budgetAlerts: IOrgBudgetAlerts = {
      enabled,
      monthlyBudgetCredits: budgetValue,
      percentThresholds: thresholds,
      lowBalanceCredits: lowBalanceValue,
    };
    saving.current = true;
    updateSettings.mutate(
      { organizationId, budgetAlerts },
      {
        onSettled: () => {
          saving.current = false;
        },
      }
    );
  };

  return (
    <Card variant="outlined" sx={{ mx: { xs: 0, sm: '20px' } }} data-testid="org-budget-alerts-card">
      <Stack spacing={2} p={2}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
          <Stack spacing={0.5} sx={{ minWidth: 0 }}>
            <Typography level="title-sm">Budget alerts</Typography>
            <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
              Notify the owner and opted-in managers when the credit pool crosses a threshold. Each configured
              percentage sends at most once per UTC calendar month, even if the budget changes.
            </Typography>
          </Stack>
          <Switch
            checked={enabled}
            onChange={e => editDraft(() => setEnabled(e.target.checked))}
            disabled={locked}
            slotProps={{ input: { 'aria-label': 'Enable budget alerts', 'data-testid': 'org-alerts-enable-switch' } }}
          />
        </Stack>

        <FormControl error={budgetValue === undefined}>
          <FormLabel>Monthly budget (credits)</FormLabel>
          <Input
            disabled={locked}
            value={budget}
            onChange={e => editDraft(() => setBudget(e.target.value))}
            placeholder="No budget"
            slotProps={{ input: { inputMode: 'numeric', 'data-testid': 'org-alerts-budget-input' } }}
          />
          <FormHelperText>Percent alerts measure spend against this. Leave empty to turn them off.</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Alert at percent of budget spent</FormLabel>
          <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
            {thresholds.map(value => (
              <Chip
                key={value}
                variant="soft"
                data-testid={`org-alerts-threshold-${value}-chip`}
                endDecorator={
                  <ChipDelete
                    aria-label={`Remove ${value}%`}
                    data-testid={`org-alerts-threshold-${value}-remove-btn`}
                    disabled={locked}
                    onDelete={() => editDraft(() => setThresholds(thresholds.filter(t => t !== value)))}
                  />
                }
              >
                {value}%
              </Chip>
            ))}
            <Input
              size="sm"
              disabled={locked}
              value={newThreshold}
              onChange={e => editDraft(() => setNewThreshold(e.target.value))}
              onKeyDown={e => {
                if (e.key === 'Enter') addThreshold();
              }}
              placeholder="Add %"
              sx={{ width: 96 }}
              slotProps={{ input: { inputMode: 'numeric', 'data-testid': 'org-alerts-threshold-input' } }}
            />
            <Button
              size="sm"
              variant="outlined"
              disabled={locked || !canAddThreshold}
              onClick={addThreshold}
              data-testid="org-alerts-threshold-add-btn"
            >
              Add
            </Button>
          </Stack>
          <FormHelperText>Up to {ORG_ALERT_MAX_PERCENT_THRESHOLDS} values from 1 to 100.</FormHelperText>
        </FormControl>

        <FormControl error={lowBalanceValue === undefined}>
          <FormLabel>Low balance (credits)</FormLabel>
          <Input
            disabled={locked}
            value={lowBalance}
            onChange={e => editDraft(() => setLowBalance(e.target.value))}
            placeholder="Off"
            slotProps={{ input: { inputMode: 'numeric', 'data-testid': 'org-alerts-low-balance-input' } }}
          />
          <FormHelperText>
            Alert when the pool falls to or below this balance. Leave empty to turn it off.
          </FormHelperText>
        </FormControl>

        {enabled && valid && lowBalanceValue === null && (budgetValue === null || thresholds.length === 0) && (
          <Typography level="body-sm" role="status">
            No effective thresholds are set. Add a budget with a percentage or a low-balance threshold before alerts can
            send.
          </Typography>
        )}

        <Stack direction="row" justifyContent="flex-end">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={locked || !valid}
            loading={updateSettings.isPending}
            data-testid="org-alerts-save-btn"
          >
            Save
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
};

export default OrgBudgetAlertsCard;
