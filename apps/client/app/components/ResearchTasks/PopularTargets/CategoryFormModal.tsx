import React, { useRef } from 'react';
import { Modal, ModalDialog, Typography, FormControl, FormLabel, Input, Button, Stack, Box } from '@mui/joy';
import { ModalClose } from '@mui/joy';
import Textarea from '@mui/joy/Textarea';
import { Controller, useForm } from 'react-hook-form';
import { IResearchLinkCategoryDocument } from '@bike4mind/common';
import { useCreateBusinessLinkCategory, useUpdateBusinessLinkCategory } from './hooks';
import { toast } from 'sonner';
import { purple, cyan, whiteAlpha, grayAlpha, blackAlpha } from '@client/app/utils/themes/colors';

interface CategoryFormValues {
  name: string;
  description: string;
}

const CategoryFormModal = ({
  open,
  onClose,
  initialCategory,
}: {
  open: boolean;
  onClose: () => void;
  initialCategory?: Partial<IResearchLinkCategoryDocument>;
}) => {
  const isEdit = !!initialCategory?.id;
  const { mutate: createCategory, isPending: isCreating } = useCreateBusinessLinkCategory();
  const { mutate: updateCategory, isPending: isUpdating } = useUpdateBusinessLinkCategory();
  const defaultValues = {
    name: initialCategory?.name || '',
    description: initialCategory?.description || '',
  };
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<CategoryFormValues>({
    mode: 'onChange',
    defaultValues,
  });
  // isSubmitting/isCreating/isUpdating alone can't stop a second submit fired before
  // React commits the re-render - this ref is checked synchronously so a rapid
  // double-click can't slip both calls past the disabled/loading button state.
  const submittingRef = useRef(false);

  React.useEffect(() => {
    reset(defaultValues);
  }, [open, initialCategory]);

  const onSubmit = async (data: CategoryFormValues) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    if (isEdit && initialCategory?.id) {
      updateCategory(
        { id: initialCategory.id, ...data },
        {
          onSuccess: () => {
            toast.success('Category updated successfully');
          },
          onError: () => {
            toast.error('Failed to update category');
          },
          onSettled: () => {
            submittingRef.current = false;
            onClose();
          },
        }
      );
    } else {
      createCategory(data, {
        onSuccess: () => {
          toast.success('Category created successfully');
        },
        onError: () => {
          toast.error('Failed to create category');
        },
        onSettled: () => {
          submittingRef.current = false;
          onClose();
        },
      });
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
            {isEdit ? 'Edit' : 'Add'} Category
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
          <FormControl error={!!errors.description} size="sm">
            <FormLabel>Description</FormLabel>
            <Controller
              control={control}
              name="description"
              rules={{ required: 'Description is required' }}
              render={({ field }) => (
                <Textarea
                  {...field}
                  minRows={3}
                  maxRows={6}
                  variant="outlined"
                  sx={{ borderRadius: '10px', width: '100%' }}
                />
              )}
            />
            {errors.description && (
              <Typography color="danger" level="body-xs">
                {errors.description.message}
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

export default CategoryFormModal;
