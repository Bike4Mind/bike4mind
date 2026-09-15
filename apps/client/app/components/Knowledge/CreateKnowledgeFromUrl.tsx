import { useUploadKnowledgeFromUrl } from '@client/app/hooks/data/fabFiles';
import { dexie } from '@client/app/utils/dexie';
import { Button, Input, Modal, ModalClose, ModalDialog, Stack, Tooltip, Typography } from '@mui/joy';
import InsertLinkIcon from '@mui/icons-material/InsertLink';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

interface CreateKnowledgeFromUrlProps {
  disabled?: boolean;
  variant?: 'solid' | 'outlined' | 'plain';
  color?: 'primary' | 'neutral' | 'danger' | 'success' | 'warning';
  size?: 'sm' | 'md' | 'lg';
  sx?: any;
  modalOnly?: boolean;
  openModal?: boolean;
  setOpenModal?: (open: boolean) => void;
  className?: string;
}

const CreateKnowledgeFromUrl: React.FC<CreateKnowledgeFromUrlProps> = ({
  disabled = false,
  variant = 'outlined',
  color = 'neutral',
  size = 'md',
  sx = {},
  openModal = false,
  setOpenModal = () => {},
  modalOnly = false,
}) => {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const uploadKnowledgeFromUrl = useUploadKnowledgeFromUrl();
  const [openLocalHandler, setOpenLocalHandler] = useState(false);

  const modalOpen = openModal || openLocalHandler;

  const modalHandler = (open: boolean) => {
    if (modalOnly) {
      setOpenModal(open);
      return;
    }

    setOpenLocalHandler(open);
  };

  const decodeHtmlEntities = (str: string) => {
    return str
      .replace(/&#x2F;/g, '/') // forward slash
      .replace(/&#x3A;/g, ':'); // colon
  };

  const handleSubmit = () => {
    if (!url.trim()) {
      toast.error(t('file_browser.url_required'));
      return;
    }

    // TODO: add URL validation (format, reachability via HEAD, supported content type,
    // rate limiting) before upload

    uploadKnowledgeFromUrl.mutate(url, {
      onSuccess: newFabFile => {
        dexie.fabfiles.put(newFabFile);
        // Decode the entire toast message after translation to avoid html entities
        const successMessage = decodeHtmlEntities(t('file_browser.url_success', { url }));
        toast.success(successMessage);
        modalHandler(false);
        setUrl('');
      },
      onError: error => {
        console.error(error);
        // Decode the entire toast message after translation to avoid html entities
        const errorMessage = decodeHtmlEntities(t('file_browser.url_error', { url }));
        toast.error(errorMessage);
      },
    });
  };

  return (
    <>
      {!modalOnly && (
        <Tooltip title={t('file_browser.create_from_url')} placement="top">
          <Button
            variant={variant}
            color={color}
            size={size}
            onClick={() => modalHandler(true)}
            disabled={disabled}
            startDecorator={<InsertLinkIcon />}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '6px 30px',
              '@media (max-width: 600px)': {
                width: '100%',
              },
              borderRadius: '6px',
              border: '1px solid',
              borderColor: 'fileBrowser.selectAll.borderColor',
              bgcolor: 'transparent',
              minHeight: '32px',
              height: '32px',

              // text style
              color: 'text.primary',
              fontSize: '14px',
              fontWeight: '400',
              lineHeight: '150%',
              letterSpacing: '1px',
              ...sx,
            }}
          >
            {t('file_browser.create_from_url')}
          </Button>
        </Tooltip>
      )}
      <Modal open={modalOpen} onClose={() => modalHandler(false)}>
        <ModalDialog
          sx={theme => ({
            width: { xs: '90%', sm: '80%', md: '60%', lg: '50%' },
            minWidth: { xs: '90%', sm: '35rem' },
            maxWidth: '42rem',
            minHeight: 'auto',
            maxHeight: '80vh',
            overflow: 'auto',
            p: 3,
            bgcolor: theme.palette.background.body,
          })}
        >
          <ModalClose />
          <Typography level="h4" fontWeight="lg" mb={2}>
            {t('file_browser.create_from_url')}
          </Typography>

          <Stack spacing={2}>
            <Input
              placeholder={t('file_browser.enter_url')}
              value={url}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />

            <Stack direction="row" spacing={2} justifyContent="flex-end">
              <Button
                variant="plain"
                color="neutral"
                onClick={() => {
                  modalHandler(false);
                  setUrl('');
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleSubmit}
                loading={uploadKnowledgeFromUrl.isPending}
                disabled={!url.trim() || uploadKnowledgeFromUrl.isPending}
              >
                {t('file_browser.create_file')}
              </Button>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default CreateKnowledgeFromUrl;
