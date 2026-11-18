import type { ReactNode } from 'react';
import { styled } from '@mui/system';
import CloseIcon from '@mui/icons-material/Close';
import { IconButton, Typography } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { studioFileMediaKind } from '@bike4mind/common';
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';
import { getFabFileByIdFromServer } from '@client/app/utils/filesAPICalls';
import { studioColor, studioRadius } from '../design/studioTokens';

const Frame = styled('div')({
  position: 'relative',
  flex: '0 0 auto',
  overflow: 'hidden',
  borderRadius: studioRadius('md'),
  border: `2px solid ${studioColor('hairline')}`,
  background: studioColor('sunken'),
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  '&[data-selected="true"]': { borderColor: studioColor('accent') },
  '& > img, & > video': { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  '& > button.thumb-select': {
    position: 'absolute',
    inset: 0,
    border: 'none',
    padding: 0,
    background: 'transparent',
    cursor: 'pointer',
  },
});

type LibraryThumbProps = {
  fileId: string;
  size?: number;
  selected?: boolean;
  /** Names the thumb's select button; it is only a button when `onSelect` is given. */
  selectLabel?: string;
  onSelect?: () => void;
  onRemove?: () => void;
  testId: string;
  badge?: ReactNode;
};

/** A square preview of a Library file by id: the picture, a video's first frame, or the file name. */
const LibraryThumb = ({
  fileId,
  size = 72,
  selected = false,
  selectLabel,
  onSelect,
  onRemove,
  testId,
  badge,
}: LibraryThumbProps) => {
  const { data, isError } = useQuery({
    queryKey: fabFileKeys.doc(fileId),
    queryFn: () => getFabFileByIdFromServer(fileId),
  });
  const url = data?.presignedUrl ?? data?.fileUrl;
  const kind = data ? studioFileMediaKind(data.mimeType) : undefined;

  return (
    <Frame
      style={{ width: size, height: size }}
      data-selected={selected}
      data-testid={testId}
      data-file-id={fileId}
      title={data?.fileName}
    >
      {url && kind === 'image' ? (
        <img src={url} alt={data?.fileName ?? ''} loading="lazy" />
      ) : url && kind === 'video' ? (
        <video src={url} muted preload="metadata" />
      ) : (
        <Typography level="body-xs" sx={{ p: 0.5, wordBreak: 'break-all', textAlign: 'center' }}>
          {isError ? 'Unavailable' : (data?.fileName ?? '...')}
        </Typography>
      )}
      {onSelect && (
        <button
          type="button"
          className="thumb-select"
          aria-label={selectLabel}
          aria-pressed={selected}
          onClick={onSelect}
          data-testid={`${testId}-select-btn`}
        />
      )}
      {badge}
      {onRemove && (
        <IconButton
          size="sm"
          variant="solid"
          color="neutral"
          aria-label="Remove"
          onClick={onRemove}
          data-testid={`${testId}-remove-btn`}
          sx={{ position: 'absolute', top: 2, right: 2, '--IconButton-size': '20px' }}
        >
          <CloseIcon sx={{ fontSize: 14 }} />
        </IconButton>
      )}
    </Frame>
  );
};

export default LibraryThumb;
