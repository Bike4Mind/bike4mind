import { useMemo } from 'react';
import { Alert, Typography } from '@mui/joy';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { estimateEmbeddingCostUsd, estimateEmbeddingTokens } from '@client/app/utils/embeddingCostEstimate';

/** A stored admin setting arrives as a raw string ('true'/'false') from the server, but the
 * coded default is a real boolean - handle both so a string 'false' is never truthy-coerced. */
function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return !!value;
}

export interface EmbeddingBudgetEstimateProps {
  files: { name: string; size: number }[];
}

/**
 * Advisory-only upload-time cost warning. Pure client-side heuristic on file SIZE, not
 * text extraction: this repo's ingest pipeline (mammoth/JSZip/tiktoken/unpdf) does not belong in
 * a browser bundle, and a server round-trip is not possible either - `useBatchUpload` uploads via
 * presigned S3 URLs, so the server has no bytes to extract from until after the commit this
 * estimate is meant to precede. Never blocks the upload - advisory only.
 */
export function EmbeddingBudgetEstimate({ files }: EmbeddingBudgetEstimateProps) {
  const spendEnabledRaw = useGetSettingsValue('dataLakeEmbeddingSpendEnabled');
  const perRunBudgetRaw = useGetSettingsValue('dataLakeEmbeddingBudgetPerRunUsd');
  const model = useGetSettingsValue('defaultEmbeddingModel');

  const tokens = useMemo(() => estimateEmbeddingTokens(files), [files]);
  const estimatedCostUsd = model ? estimateEmbeddingCostUsd(tokens, String(model)) : 0;

  const spendEnabled = toBool(spendEnabledRaw, true);
  const perRunBudgetUsd = perRunBudgetRaw !== undefined ? Number(perRunBudgetRaw) : undefined;

  // spendEnabled false is the master kill switch, not "no limit" - enforceEmbeddingSpendGate
  // throws before any file reaches a provider call, so every pending upload is guaranteed not
  // to index. That is the one case here that needs its own loud banner, not silence.
  if (!spendEnabled) {
    return (
      <Alert size="md" color="danger" variant="soft" data-testid="datalake-estimate-spend-disabled-alert">
        <Typography level="body-sm">
          Indexing is paused: a platform admin turned embedding spend off. Files uploaded now will not be processed
          until an admin turns it back on.
        </Typography>
      </Alert>
    );
  }
  // Silent (return null, not a $0 banner) whenever there's nothing worth warning about: no
  // usable budget figure, no model resolved yet, nothing selected, or the estimate settles at
  // exactly 0 (a zero-price self-host model, or an unpriced one - both are correctly silent,
  // never a misleading "estimated cost: $0.00").
  if (perRunBudgetUsd === undefined || !Number.isFinite(perRunBudgetUsd) || perRunBudgetUsd <= 0) return null;
  if (!model) return null;
  if (files.length === 0) return null;
  if (estimatedCostUsd === 0) return null;

  const overBudget = estimatedCostUsd > perRunBudgetUsd;
  const roundedCost = estimatedCostUsd < 1 ? estimatedCostUsd.toFixed(4) : estimatedCostUsd.toFixed(2);

  if (!overBudget) {
    return (
      <Typography level="body-xs" color="neutral" data-testid="datalake-estimate-line">
        Estimated embedding cost: ~$
        <span data-testid="datalake-estimate-total">{roundedCost}</span> (approximate, based on file size)
      </Typography>
    );
  }

  return (
    <Alert size="md" color="warning" variant="soft" data-testid="datalake-estimate-over-budget-alert">
      {/* Alert lays its own children out as flex row items - a bare mix of text nodes and
          <span>s becomes several independent flex items that wrap into overlapping columns
          instead of flowing as one paragraph. Wrapping in a single Typography (matching the
          "Adding files to..." Alert elsewhere in this file's own directory) keeps it one item. */}
      <Typography level="body-sm">
        This upload may exceed the per-run embedding budget. Rough estimate: ~$
        <span data-testid="datalake-estimate-total">{roundedCost}</span> for {files.length.toLocaleString()} file
        {files.length === 1 ? '' : 's'}, against ~$
        <span data-testid="datalake-estimate-remaining">{perRunBudgetUsd.toFixed(2)}</span> for this run. The estimate
        is approximate - it is based on file size, not the text actually extracted, and rounds up. You can still upload.
      </Typography>
    </Alert>
  );
}
