import { useStarredFileIds, useToggleFileStar } from '@client/app/hooks/data/fileStars';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import { IconButton, Tooltip } from '@mui/joy';
import { FC, MouseEvent } from 'react';

/** Star toggle on a file tile. Stops the click so starring never also selects the tile. */
const FileStarButton: FC<{ fileId: string }> = ({ fileId }) => {
  const starredIds = useStarredFileIds();
  const { mutate: toggleStar } = useToggleFileStar();
  const starred = starredIds.has(fileId);
  const label = starred ? 'Unstar' : 'Star';

  const handleClick = (event: MouseEvent) => {
    event.stopPropagation();
    toggleStar({ fileId, starred: !starred });
  };

  return (
    <Tooltip title={label}>
      <IconButton
        data-testid="file-browser-item-star-btn"
        size="sm"
        variant="plain"
        color={starred ? 'warning' : 'neutral'}
        aria-label={label}
        aria-pressed={starred}
        onClick={handleClick}
      >
        {starred ? <StarIcon /> : <StarBorderIcon />}
      </IconButton>
    </Tooltip>
  );
};

export default FileStarButton;
