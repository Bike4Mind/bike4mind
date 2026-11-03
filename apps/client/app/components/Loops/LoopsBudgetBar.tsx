import { useState } from 'react';
import { Button, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { useLoopsBudget, useSetLoopsBudget } from '@client/app/hooks/data/loops';

/** Today's spend across all of the caller's loops against their all-loops daily cap, and the field to set it. */
export default function LoopsBudgetBar() {
  const { data } = useLoopsBudget();
  const setBudget = useSetLoopsBudget();
  const [draft, setDraft] = useState<string | null>(null);
  if (!data) return null;

  const value = draft ?? data.userDailyCredits?.toString() ?? '';
  const parsed = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(parsed) && parsed > 0;
  const save = (dailyCredits: number | null) => setBudget.mutate(dailyCredits, { onSuccess: () => setDraft(null) });

  return (
    <Stack direction="row" gap={2} alignItems="center" flexWrap="wrap" sx={{ mb: 1.5 }} data-testid="loops-budget-bar">
      <Typography level="body-sm" data-testid="loops-budget-today">
        Today: {Math.round(data.creditsToday).toLocaleString()}
        {data.effectiveCap !== undefined && ` / ${data.effectiveCap.toLocaleString()}`} credits across all loops
      </Typography>
      <FormControl orientation="horizontal" size="sm" sx={{ gap: 1, alignItems: 'center' }}>
        <FormLabel>All loops: max credits per day</FormLabel>
        <Input
          type="number"
          value={value}
          placeholder="No limit"
          onChange={event => setDraft(event.target.value)}
          sx={{ width: 120 }}
          slotProps={{ input: { min: 1, 'data-testid': 'loops-budget-input' } }}
        />
      </FormControl>
      <Button
        size="sm"
        variant="outlined"
        disabled={!valid || parsed === data.userDailyCredits}
        loading={setBudget.isPending}
        onClick={() => save(parsed)}
        data-testid="loops-budget-save-btn"
      >
        Save
      </Button>
      {data.userDailyCredits !== undefined && (
        <Button size="sm" variant="plain" onClick={() => save(null)} data-testid="loops-budget-clear-btn">
          Clear
        </Button>
      )}
      {data.adminDailyCredits !== undefined && (
        <Typography level="body-xs" data-testid="loops-budget-admin-cap">
          Admin limit: {data.adminDailyCredits.toLocaleString()} credits per day
        </Typography>
      )}
    </Stack>
  );
}
