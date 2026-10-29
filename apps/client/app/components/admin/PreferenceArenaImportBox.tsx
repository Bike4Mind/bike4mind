import { useState } from 'react';
import { Box, Button, FormControl, FormHelperText, FormLabel, Stack, Textarea, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { arenaPairImportRequestSchema, type ArenaPairImport } from '@bike4mind/common';
import { useImportArenaPairs } from '@client/app/hooks/data/preferenceArena';
import { getErrorMessage } from '@client/app/utils/error';
import { SectionCard } from './shared';

const MAX_SHOWN_ERRORS = 10;
// 50 pairs at the schema maximum (50k chars each) stay well under the endpoint's 4 MB body limit.
const IMPORT_CHUNK_SIZE = 50;

type ParseResult = { ok: true; pairs: ArenaPairImport[] } | { ok: false; errors: string[] };

function isPairsEnvelope(value: unknown): value is { pairs: unknown[] } {
  return typeof value === 'object' && value !== null && 'pairs' in value && Array.isArray(value.pairs);
}

export function parseArenaPairImport(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`Invalid JSON: ${error instanceof Error ? error.message : 'could not parse'}`] };
  }
  const candidate = isPairsEnvelope(json) ? json.pairs : json;
  const parsed = arenaPairImportRequestSchema.safeParse({ pairs: candidate });
  if (parsed.success) return { ok: true, pairs: parsed.data.pairs };
  return {
    ok: false,
    errors: parsed.error.issues.map(issue => {
      const location = issue.path.slice(1).join('.');
      return location ? `${location}: ${issue.message}` : issue.message;
    }),
  };
}

export default function PreferenceArenaImportBox() {
  const [raw, setRaw] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const importPairs = useImportArenaPairs();

  const submit = async () => {
    const result = parseArenaPairImport(raw);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    setImporting(true);
    let inserted = 0;
    try {
      for (let start = 0; start < result.pairs.length; start += IMPORT_CHUNK_SIZE) {
        const response = await importPairs.mutateAsync(result.pairs.slice(start, start + IMPORT_CHUNK_SIZE));
        inserted += response.inserted;
      }
      toast.success(`Imported ${inserted} pair${inserted === 1 ? '' : 's'}`);
      setRaw('');
    } catch (error) {
      const progress = inserted > 0 ? ` (${inserted} imported before the failure)` : '';
      toast.error(`${getErrorMessage(error)}${progress}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <SectionCard title="Import pairs" body="custom" data-testid="arena-import-card">
      <Stack gap={1.5} sx={{ p: 2 }}>
        <FormControl error={errors.length > 0}>
          <FormLabel>Pairs JSON</FormLabel>
          <Textarea
            minRows={6}
            value={raw}
            onChange={event => setRaw(event.target.value)}
            placeholder='[{"prompt": "...", "taskType": "qa", "source": "synthetic", "answers": [{"modelId": "...", "text": "..."}, {"modelId": "...", "text": "..."}]}]'
            slotProps={{ textarea: { 'data-testid': 'arena-import-input' } }}
            sx={{ fontFamily: 'monospace', fontSize: 13 }}
          />
          <FormHelperText>
            A JSON array of up to 500 pairs. Add goldChoice (a or b) only to gold questions; gold pairs must have a
            clear winner, since a Tie on a gold pair counts as a miss.
          </FormHelperText>
        </FormControl>
        {errors.length > 0 && (
          <Box role="alert" data-testid="arena-import-errors">
            {errors.slice(0, MAX_SHOWN_ERRORS).map(message => (
              <Typography key={message} level="body-sm" color="danger">
                {message}
              </Typography>
            ))}
            {errors.length > MAX_SHOWN_ERRORS && (
              <Typography level="body-sm" color="danger">
                and {errors.length - MAX_SHOWN_ERRORS} more
              </Typography>
            )}
          </Box>
        )}
        <Stack direction="row" justifyContent="flex-end">
          <Button
            onClick={submit}
            loading={importing}
            disabled={raw.trim() === ''}
            data-testid="arena-import-submit-btn"
          >
            Import pairs
          </Button>
        </Stack>
      </Stack>
    </SectionCard>
  );
}
