import React, { useRef } from 'react';
import {
  Modal,
  ModalDialog,
  Typography,
  FormControl,
  FormLabel,
  Input,
  Button,
  Select,
  Option,
  Stack,
  Box,
} from '@mui/joy';
import { ModalClose } from '@mui/joy';
import { whiteAlpha, blackAlpha, grayAlpha, cyan, purple } from '../../../utils/themes/colors';
import { Controller, useForm } from 'react-hook-form';
import { IResearchLink } from '@bike4mind/common';
import { useCreateBusinessLink, useUpdateBusinessLink, usePopularTargets } from './hooks';
import { toast } from 'sonner';

interface BusinessLinkFormValues {
  name: string;
  url: string;
  ticker: string;
  type: string;
}

interface TypeOption {
  value: string;
  label: string;
}

const DEFAULT_TYPE_OPTIONS: TypeOption[] = [
  { value: 'tech', label: 'Tech' },
  { value: 'finance', label: 'Finance' },
  { value: 'healthcare', label: 'Healthcare' },
  { value: 'others', label: 'Others' },
];

const BusinessLinkFormModal = ({
  open,
  onClose,
  initialLink,
  onTypeChange,
}: {
  open: boolean;
  onClose: () => void;
  initialLink?: Partial<IResearchLink & { id?: string }>;
  onTypeChange?: (type: string) => void;
}) => {
  const isEdit = !!initialLink?.id;
  const { state } = usePopularTargets();
  const { mutate: createBusinessLink, isPending: isCreating } = useCreateBusinessLink();
  const { mutate: updateBusinessLink, isPending: isUpdating } = useUpdateBusinessLink();
  const defaultValues = {
    name: initialLink?.name || '',
    url: initialLink?.url || '',
    ticker: initialLink?.ticker || '',
    type: initialLink?.type || DEFAULT_TYPE_OPTIONS[0]?.value || '',
  };
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<BusinessLinkFormValues>({
    mode: 'onChange',
    defaultValues,
  });
  // isSubmitting/isCreating/isUpdating alone can't stop a second submit fired before
  // React commits the re-render - this ref is checked synchronously so a rapid
  // double-click can't slip both calls past the disabled/loading button state.
  const submittingRef = useRef(false);

  React.useEffect(() => {
    reset(defaultValues);
  }, [open, initialLink]);

  const onSubmit = async (data: BusinessLinkFormValues) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    if (isEdit && initialLink?.id) {
      updateBusinessLink(
        { id: initialLink.id, ...data, categoryId: state.categoryId },
        {
          onSuccess: () => {
            toast.success('Company updated successfully');
          },
          onError: () => {
            toast.error('Failed to update company');
          },
          onSettled: () => {
            submittingRef.current = false;
            onClose();
          },
        }
      );
    } else {
      createBusinessLink(
        { ...data, categoryId: state.categoryId },
        {
          onSuccess: () => {
            toast.success('Company created successfully');
          },
          onError: () => {
            toast.error('Failed to create company');
          },
          onSettled: () => {
            submittingRef.current = false;
            onClose();
          },
        }
      );
    }
  };

  return (
    <Modal
      open={open}
      onClose={(_event, reason) => {
        if (reason !== 'backdropClick') onClose();
      }}
      sx={{ zIndex: 14001 }}
    >
      <ModalDialog
        sx={{
          minWidth: 400,
          maxWidth: 480,
          zIndex: 14001,
          p: 3,
          background: `linear-gradient(135deg, ${whiteAlpha[0][98]} 0%, ${grayAlpha[15][95]} 50%, ${grayAlpha[5][98]} 100%)`,
          boxShadow: `0 25px 50px -12px ${blackAlpha[0][30]}, 0 0 0 1px ${whiteAlpha[0][5]}`,
          borderRadius: '20px',
          border: `1px solid ${whiteAlpha[0][30]}`,
          overflow: 'hidden',
          backdropFilter: 'blur(20px)',
        }}
      >
        <ModalClose
          onClick={onClose}
          sx={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 10,
            borderRadius: '50%',
            transition: 'all 0.2s ease',
            '&:hover': {
              bgcolor: 'danger.softHoverBg',
              transform: 'scale(1.1)',
            },
          }}
        />
        <Stack component="form" gap={0.5} onSubmit={e => handleSubmit(onSubmit)(e)}>
          <Typography level="h4" mb={1}>
            {isEdit ? 'Edit' : 'Add'} Company
          </Typography>
          <FormControl error={!!errors.name} size="sm">
            <FormLabel>Name</FormLabel>
            <Controller
              control={control}
              name="name"
              rules={{ required: 'Name is required' }}
              render={({ field }) => <Input {...field} variant="outlined" fullWidth sx={{ borderRadius: '10px' }} />}
            />
            {errors.name && (
              <Typography color="danger" level="body-xs">
                {errors.name.message}
              </Typography>
            )}
          </FormControl>
          <FormControl error={!!errors.url} size="sm">
            <FormLabel>URL</FormLabel>
            <Controller
              control={control}
              name="url"
              rules={{
                required: 'URL is required',
                pattern: {
                  value: /^https?:\/\/[\w.-]+\.[a-z]{2,}(\/\S*)?$/i,
                  message: 'Please enter a valid URL',
                },
              }}
              render={({ field }) => <Input {...field} variant="outlined" fullWidth sx={{ borderRadius: '10px' }} />}
            />
            {errors.url && (
              <Typography color="danger" level="body-xs">
                {errors.url.message}
              </Typography>
            )}
          </FormControl>
          <FormControl error={!!errors.ticker} size="sm">
            <FormLabel>Ticker</FormLabel>
            <Controller
              control={control}
              name="ticker"
              rules={{ required: 'Ticker is required' }}
              render={({ field }) => <Input {...field} variant="outlined" fullWidth sx={{ borderRadius: '10px' }} />}
            />
            {errors.ticker && (
              <Typography color="danger" level="body-xs">
                {errors.ticker.message}
              </Typography>
            )}
          </FormControl>
          <FormControl error={!!errors.type} size="sm">
            <FormLabel>Type</FormLabel>
            <Controller
              control={control}
              name="type"
              rules={{ required: 'Type is required' }}
              render={({ field }) => (
                <Select
                  {...field}
                  variant="outlined"
                  sx={{ borderRadius: '10px' }}
                  slotProps={{
                    listbox: {
                      sx: { zIndex: 15000 },
                    },
                  }}
                  onChange={(_, value) => {
                    if (typeof value === 'string') {
                      field.onChange(value);
                      if (onTypeChange) onTypeChange(value);
                    }
                  }}
                >
                  {DEFAULT_TYPE_OPTIONS.map(opt => (
                    <Option key={opt.value} value={opt.value}>
                      {opt.label}
                    </Option>
                  ))}
                </Select>
              )}
            />
            {errors.type && (
              <Typography color="danger" level="body-xs">
                {errors.type.message}
              </Typography>
            )}
          </FormControl>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
            <Button
              type="button"
              variant="plain"
              color="neutral"
              onClick={onClose}
              disabled={isSubmitting || isCreating || isUpdating}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="solid"
              color="primary"
              loading={isSubmitting || isCreating || isUpdating}
              sx={{
                background: `linear-gradient(135deg, ${purple[300]} 0%, ${cyan[400]} 100%)`,
                borderRadius: '12px',
                px: 2,
                py: 1,
                fontWeight: 600,
              }}
            >
              {isEdit ? 'Update' : 'Create'}
            </Button>
          </Box>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default BusinessLinkFormModal;
