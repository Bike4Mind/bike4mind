import { LinearProgress, Typography } from '@mui/joy';
import prettyBytes from 'pretty-bytes';
import { FC } from 'react';

type FileStorageBarProps = {
  currentStorageInBytes: number;
  storageLimitInBytes: number;
};

const FileStorageBar: FC<FileStorageBarProps> = ({ currentStorageInBytes, storageLimitInBytes }) => {
  const currentStoragePercent = (currentStorageInBytes / storageLimitInBytes) * 100;

  // Determine color based on storage percentage
  const getProgressColor = (theme: any, percentage: number) => {
    if (percentage >= 90) {
      return theme.palette.fileBrowser.storage.dangerColor;
    } else if (percentage >= 75) {
      return theme.palette.fileBrowser.storage.warningColor;
    } else {
      return theme.palette.fileBrowser.storage.progressColor;
    }
  };

  return (
    <LinearProgress
      color={'primary'}
      determinate
      thickness={36}
      value={currentStoragePercent}
      sx={theme => ({
        '--LinearProgress-progressThickness': '29px',
        color: getProgressColor(theme, currentStoragePercent),
        borderRadius: '6px',
        border: '1px solid',
        borderColor: theme.palette.border.solid,
        height: '32px',
        backgroundColor: theme.palette.fileBrowser.storage.backgroundColor,
      })}
    >
      <Typography
        level="body-xs"
        sx={{
          mixBlendMode: 'normal',
          color: theme =>
            currentStoragePercent < 90
              ? theme.palette.fileBrowser.storage.textColor
              : theme.palette.fileBrowser.storage.textColorDanger,
          zIndex: 2,
        }}
      >
        {prettyBytes(currentStorageInBytes)} / {prettyBytes(storageLimitInBytes)}
      </Typography>
    </LinearProgress>
  );
};

export default FileStorageBar;
