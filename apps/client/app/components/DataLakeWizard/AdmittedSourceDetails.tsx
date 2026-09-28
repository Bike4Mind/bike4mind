import type { ReactNode } from 'react';
import { Box, Link, Typography } from '@mui/joy';
import { FabFileSourceType, type IFabFileDocument } from '@bike4mind/common';
import { useGetFabFile } from '@client/app/hooks/data/fabFiles';

type ProcessingFields = Pick<
  IFabFileDocument,
  | 'error'
  | 'chunkStallReason'
  | 'noExtractableTextAt'
  | 'isChunking'
  | 'chunkCount'
  | 'vectorizedChunkCount'
  | 'embeddedChunkCount'
  | 'chunkEmbeddingModelStampedAt'
>;

/**
 * Where a file is in the chunk -> embed pipeline. `chunkEmbeddingModelStampedAt` is the terminal
 * marker; `vectorized` is not (see its doc on `IFabFileDocument`). The stamp alone does not mean
 * anything is searchable: it is also set once every chunk reaches a terminal state, which includes
 * an oversized chunk that was never embeddable - so a fully-stamped file can still have zero
 * VECTOR-bearing chunks (`embeddedChunkCount`, not `chunkCount`).
 */
export function describeProcessingState(file: ProcessingFields): string {
  if (file.error) return 'Processing failed';
  if (file.chunkStallReason || file.noExtractableTextAt) return 'Stopped - see the notice above';
  if (file.chunkEmbeddingModelStampedAt) {
    const embedded = file.embeddedChunkCount ?? 0;
    if (embedded === 0 && (file.chunkCount ?? 0) > 0) return 'Processed - no passages could be embedded';
    return `Searchable (${embedded.toLocaleString()} ${embedded === 1 ? 'passage' : 'passages'})`;
  }
  if (file.isChunking) return 'Splitting into passages';
  if (file.chunkCount) {
    return `Embedding passages (${(file.vectorizedChunkCount ?? 0).toLocaleString()} of ${file.chunkCount.toLocaleString()})`;
  }
  return 'Queued for processing';
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

function formatDate(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

// A producer-supplied URL rendered as a link: anything but http(s) is shown as text, never linked.
function safeHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, minWidth: 0 }} data-testid={testId}>
      <Typography level="body-xs" sx={{ color: 'text.tertiary', flexShrink: 0, width: 88 }}>
        {label}
      </Typography>
      <Typography level="body-xs" sx={{ color: 'text.secondary', minWidth: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </Box>
  );
}

/**
 * Provenance for a file admitted from an approved acquisition proposal: the source, the research
 * run that found it, who approved it, and how far processing has got. Everything shown here is
 * stamped server-side at admission (`approveDataLakeProposal`); renders nothing for other files.
 */
export default function AdmittedSourceDetails({ file }: { file: IFabFileDocument }) {
  // The caller's `file` is the selection the sidebar last clicked - a snapshot that does not
  // update on its own while chunking/vectorization continues in the background, so "Queued" could
  // sit on screen long after the file actually finished. Polled only while non-terminal (see
  // isFabFileProcessingTerminal), so an already-settled file costs nothing here.
  const { data: liveFile } = useGetFabFile(file.id, { pollWhileProcessing: true });
  const processingFile = liveFile ?? file;

  if (file.sourceType !== FabFileSourceType.PROPOSAL_APPROVAL) return null;

  const meta = file.sourceMetadata ?? {};
  const sourceUrl = asString(meta.sourceUrl);
  const href = sourceUrl ? safeHref(sourceUrl) : undefined;
  const runId = asString(meta.runId);
  const query = asString(meta.query);
  const approver = asString(meta.approvedByName) ?? asString(meta.approvedByUserId);
  const approvedAt = formatDate(meta.approvedAt);

  return (
    <Box
      data-testid="datalake-admitted-source"
      sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, mb: 1, minWidth: 0 }}
    >
      {sourceUrl && (
        <Row label="Source" testId="datalake-admitted-source-url">
          {href ? (
            <Link href={href} target="_blank" rel="noopener noreferrer" level="body-xs">
              {sourceUrl}
            </Link>
          ) : (
            sourceUrl
          )}
        </Row>
      )}
      {(runId || query) && (
        <Row label="Research run" testId="datalake-admitted-source-run">
          {query ? `"${query}"` : null}
          {query && runId ? ' ' : null}
          {runId ? `(run ${runId})` : null}
        </Row>
      )}
      {approver && (
        <Row label="Approved by" testId="datalake-admitted-source-approver">
          {approver}
          {approvedAt ? ` on ${approvedAt}` : null}
        </Row>
      )}
      <Row label="Processing" testId="datalake-admitted-source-processing">
        {describeProcessingState(processingFile)}
      </Row>
    </Box>
  );
}
