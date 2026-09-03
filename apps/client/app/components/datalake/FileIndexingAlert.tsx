import { Tooltip } from '@mui/joy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import type { IFabFileDocument } from '@bike4mind/common';

/**
 * Red alert glyph on a lake file row when the file failed processing (chunking, embedding,
 * or a cost-governance denial). The stored per-file error is otherwise invisible in the
 * explorer - a file that cannot be found by search looks identical to one that can - so this
 * is the minimal honest surface until the lake-health work lands. Tooltip carries the stored
 * reason verbatim (it is written user-safe at the point of failure).
 */
export default function FileIndexingAlert({ file }: { file: Pick<IFabFileDocument, 'id' | 'error'> }) {
  if (!file.error) return null;
  return (
    <Tooltip title={file.error} size="sm" sx={{ maxWidth: 360 }}>
      <ErrorOutlineIcon
        data-testid={`datalake-file-error-${file.id}`}
        sx={{ fontSize: 16, color: 'danger.500', flexShrink: 0 }}
      />
    </Tooltip>
  );
}
