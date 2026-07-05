import { Box } from '@mui/joy';
import { FC } from 'react';
import SwitchSelector from '../../common/fields/SwitchSelector';

export type ViewMode = 'home' | 'list' | 'grid' | 'tags';

interface FileBrowserViewActionsProps {
  value?: {
    order?: {
      by: 'fileName' | 'fileSize' | 'createdAt';
      direction: 'asc' | 'desc';
    };
    viewMode?: ViewMode;
  };
  onChange?: (value: {
    order?: {
      by: 'fileName' | 'fileSize' | 'createdAt';
      direction: 'asc' | 'desc';
    };
    viewMode?: ViewMode;
  }) => void;
}

const FileBrowserViewActions: FC<FileBrowserViewActionsProps> = ({ value, onChange }) => {
  return (
    <Box
      className="file-browser-view-actions-container"
      data-testid="file-browser-view-actions-container"
      sx={{
        display: 'flex',
        alignItems: 'center',
        width: { xs: '100%', sm: 'auto' },
        '& > div': {
          width: { xs: '100%', sm: '360px' },
        },
      }}
    >
      <SwitchSelector
        options={[
          { value: 'home', label: 'Overview' },
          { value: 'list', label: 'List' },
          { value: 'grid', label: 'Grid' },
          { value: 'tags', label: 'Tags' },
        ]}
        value={value?.viewMode || 'home'}
        onChange={v => onChange?.({ ...(value || {}), viewMode: v as ViewMode })}
      />
    </Box>
  );
};

export default FileBrowserViewActions;
