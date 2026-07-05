import React, { useRef, useState } from 'react';
import { Select, Option, CircularProgress } from '@mui/joy';
import {
  FileUploadOutlined as FileUploadOutlinedIcon,
  InsertLink as InsertLinkIcon,
  AutoFixHigh as AutoFixHighIcon,
  KeyboardArrowDown as KeyboardArrowDownIcon,
  Storage as StorageIcon,
} from '@mui/icons-material';

interface UploadActionsSelectProps {
  onUploadFiles?: (files: File[]) => void;
  onAddFromUrl?: () => void;
  onCreateKnowledge?: () => void;
  onCreateDataLake?: () => void;
  isUploading?: boolean;
  /** Variant for mobile vs desktop styling */
  variant?: 'mobile' | 'desktop';
  /** Custom placeholder text */
  placeholder?: string;
}

export const UploadActionsSelect: React.FC<UploadActionsSelectProps> = ({
  onUploadFiles,
  onAddFromUrl,
  onCreateKnowledge,
  onCreateDataLake,
  isUploading = false,
  variant = 'mobile',
  placeholder = 'Upload Files',
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectOpen, setSelectOpen] = useState(false);
  const [selectValue, setSelectValue] = useState<string | null>(null);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && onUploadFiles) {
      const fileArray = Array.from(files);
      onUploadFiles(fileArray);
    }
    // Reset the input value so the same file can be selected again
    if (event.target) {
      event.target.value = '';
    }
  };

  const handleUploadAction = (value: string | null) => {
    if (!value) return;

    switch (value) {
      case 'upload':
        fileInputRef.current?.click();
        break;
      case 'url':
        onAddFromUrl?.();
        break;
      case 'knowledge':
        onCreateKnowledge?.();
        break;
      case 'datalake':
        onCreateDataLake?.();
        break;
    }
  };

  const isMobile = variant === 'mobile';

  return (
    <>
      <Select
        placeholder={isUploading ? 'Uploading...' : placeholder}
        value={selectValue}
        onChange={(_, newValue) => {
          if (typeof newValue === 'string') {
            handleUploadAction(newValue);
            // Reset value after action
            setSelectValue(null);
          }
        }}
        listboxOpen={selectOpen}
        onListboxOpenChange={setSelectOpen}
        disabled={isUploading}
        startDecorator={
          isUploading ? (
            <CircularProgress
              size="sm"
              sx={{
                '--CircularProgress-size': '16px',
                '--CircularProgress-trackThickness': '2px',
                '--CircularProgress-progressThickness': '2px',
              }}
            />
          ) : (
            <FileUploadOutlinedIcon
              sx={{
                color: 'text.primary',
                width: '16px',
                height: '16px',
                flex: 'none',
                margin: '0',
              }}
            />
          )
        }
        endDecorator={
          <KeyboardArrowDownIcon
            sx={{
              color: 'var(--joy-palette-text-primary)',
              width: '16px',
              height: '16px',
              strokeWidth: '3px',
              display: isMobile ? { xs: 'none', sm: 'block' } : 'block',
            }}
          />
        }
        sx={{
          minWidth: isMobile ? { xs: '32px', sm: '120px' } : '120px',
          width: isMobile ? { xs: '32px', sm: 'auto' } : 'auto',
          height: '32px !important',
          minHeight: '32px !important',
          maxHeight: '32px !important',
          background: theme => theme.palette.neutral.solidBg,
          border: '1px solid var(--joy-palette-divider)',
          borderRadius: '8px',
          justifyContent: 'center',
          boxShadow: 'none',
          py: 0,
          px: 1,
          opacity: isUploading ? 0.6 : 1,
          cursor: isUploading ? 'not-allowed' : 'pointer',
          '& .MuiSelect-button': {
            display: isMobile ? { xs: 'flex', sm: 'flex' } : 'flex',
            position: isMobile ? { xs: 'absolute', sm: 'relative' } : 'relative',
            top: isMobile ? { xs: 0, sm: 'auto' } : 'auto',
            left: isMobile ? { xs: 0, sm: 'auto' } : 'auto',
            zIndex: isMobile ? { xs: 100, sm: 'auto' } : 'auto',
            width: '100%',
            height: '100%',
            alignItems: 'center',
            justifyContent: isMobile ? { xs: 'center', sm: 'flex-start' } : 'flex-start',
            gap: 1,
            textAlign: 'left',
            fontSize: isMobile ? { xs: '0px', sm: '14px' } : '14px',
            lineHeight: isMobile ? { xs: 0, sm: 'normal' } : 'normal',
            color: isMobile ? { xs: 'transparent', sm: 'text.primary' } : 'text.primary',
            opacity: 1,
          },
          '& .MuiSelect-startDecorator': {
            mr: isMobile ? { xs: 0, sm: 1 } : 1,
            flex: 'none',
          },
          '& .MuiSelect-endDecorator': {
            display: isMobile ? { xs: 'none', sm: 'inline-flex' } : 'inline-flex',
            flex: 'none',
          },
          '& .MuiSelect-indicator': {
            display: 'none',
          },
          '&:focus-within': {
            borderColor: 'var(--joy-palette-primary-500)',
          },
        }}
        slotProps={{
          listbox: {
            sx: {
              minWidth: '200px',
              border: 'none !important',
              py: '4px !important',
              backgroundColor: 'var(--joy-palette-background-body)',
              '& .MuiOption-root': {
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                justifyContent: 'flex-start',
                color: 'text.primary',
                fontSize: '14px',
                fontWeight: '400',
                backgroundColor: 'var(--joy-palette-background-body)',
                transition: 'opacity 0.2s ease-in-out',
              },
              '& .MuiOption-highlighted': {
                backgroundColor: 'transparent !important',
              },
              '& .MuiOption-root:hover': {
                backgroundColor: 'transparent !important',
                color: 'text.primary',
                opacity: 0.8,
              },
            },
            placement: 'bottom-end',
            modifiers: [
              { name: 'offset', options: { offset: [-0, 4] } },
              { name: 'preventOverflow', options: { padding: 8 } },
            ],
          },
        }}
      >
        {onUploadFiles && (
          <Option value="upload">
            <FileUploadOutlinedIcon sx={{ fontSize: '18px', color: theme => `${theme.palette.text.primary}80` }} />
            From device
          </Option>
        )}
        {onAddFromUrl && (
          <Option value="url">
            <InsertLinkIcon sx={{ fontSize: '18px', color: theme => `${theme.palette.text.primary}80` }} />
            Add from URL
          </Option>
        )}
        {onCreateKnowledge && (
          <Option value="knowledge">
            <AutoFixHighIcon sx={{ fontSize: '18px', color: theme => `${theme.palette.text.primary}80` }} />
            Create Knowledge
          </Option>
        )}
        {onCreateDataLake && (
          // Opens the Data Lakes management panel (list + create + add files + lifecycle),
          // not the create wizard directly. Creation lives behind the panel's Create button.
          <Option value="datalake">
            <StorageIcon sx={{ fontSize: '18px', color: theme => `${theme.palette.text.primary}80` }} />
            Data Lakes
          </Option>
        )}
      </Select>

      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={handleFileSelect}
        multiple
        accept="*/*"
      />
    </>
  );
};
