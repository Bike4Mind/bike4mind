import { useEffect, useRef, useState } from 'react';
import { Box, Stack, Button, Skeleton, Typography } from '@mui/joy';
import { IResearchLinkCategoryDocument } from '@bike4mind/common';
import { useBusinessLinkCategories, usePopularTargets, useDeleteBusinessLinkCategory } from './hooks';
import { getGradient, PAGE_SIZE } from './utils';
import AddIcon from '@mui/icons-material/Add';
import CategoryFormModal from './CategoryFormModal';
import IconButton from '@mui/joy/IconButton';
import Tooltip from '@mui/joy/Tooltip';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ConfirmModal from './ConfirmModal';
import { toast } from 'sonner';
import { purple, cyan, blackAlpha } from '@client/app/utils/themes/colors';

const BusinessLinkCategory = () => {
  const { setState, state } = usePopularTargets();
  const { data, isFetching } = useBusinessLinkCategories({
    pageSize: PAGE_SIZE,
    pageNumber: 1,
  });
  const stackRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; category?: IResearchLinkCategoryDocument }>({
    open: false,
  });
  const { mutate: deleteCategory, isPending: isDeleting } = useDeleteBusinessLinkCategory();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoverTimeout = useRef<NodeJS.Timeout | null>(null);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [categoryModalInitial, setCategoryModalInitial] = useState<IResearchLinkCategoryDocument | undefined>(
    undefined
  );

  useEffect(() => {
    setState({ categoryLoading: isFetching });
    if (!isFetching && data?.data.length) {
      const { id: categoryId, name: categoryName, description: categoryDescription } = data.data[0];
      const { gradient, accent } = getGradient(0, data?.data.length || 0);
      setState({
        categoryId,
        categoryName,
        categoryDescription,
        categoryGradient: gradient,
        categoryAccentColor: accent,
      });
    }
  }, [isFetching, data]);

  useEffect(() => {
    const checkOverflow = () => {
      const el = stackRef.current;
      if (el) {
        setIsOverflowing(el.scrollWidth > el.clientWidth);
      }
    };
    checkOverflow();
    window.addEventListener('resize', checkOverflow);
    return () => window.removeEventListener('resize', checkOverflow);
  }, [data, isFetching]);

  return (
    <Box sx={{ mb: 2, width: '100%' }}>
      <Stack
        ref={stackRef}
        direction="row"
        spacing={1}
        sx={{
          justifyContent: isOverflowing ? 'flex-start' : 'center',
          flexWrap: 'nowrap',
          gap: 1,
          overflowX: 'auto',
          py: 1,
          '&::-webkit-scrollbar': {
            height: '4px',
          },
          '&::-webkit-scrollbar-thumb': {
            background: blackAlpha[0][20],
            borderRadius: '2px',
          },
        }}
      >
        {isFetching && <SkeletonLoader />}
        {!isFetching &&
          data?.data.map((item: IResearchLinkCategoryDocument, idx: number) => {
            const { gradient, accent } = getGradient(idx, data?.data.length || 0);
            const selected = item.id === state.categoryId;
            return (
              <Button
                key={item.id}
                variant={'solid'}
                color={'primary'}
                onClick={() => {
                  setState({
                    categoryId: item.id,
                    categoryName: item.name,
                    categoryDescription: item.description,
                    categoryGradient: gradient,
                    categoryAccentColor: accent,
                  });
                }}
                onMouseEnter={() => {
                  if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
                  hoverTimeout.current = setTimeout(() => setHoveredId(item.id), 700);
                }}
                onMouseLeave={() => {
                  if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
                  setHoveredId(null);
                }}
                sx={{
                  transition: 'all 0.3s cubic-bezier(.4,2,.6,1)',
                  borderRadius: '12px',
                  px: 2,
                  py: 1,
                  fontWeight: 600,
                  textTransform: 'none',
                  fontSize: '12px',
                  minWidth: 'auto',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  background: gradient,
                  border: selected ? '2.5px solid white' : 'none',
                  boxShadow: selected ? `0 0 0 3px ${purple[300]}` : undefined,
                  color: 'white',
                  pr: hoveredId === item.id ? 10 : 2,
                  position: 'relative',
                  opacity: selected ? 1 : 0.85,
                }}
              >
                {selected && <CheckCircleIcon sx={{ fontSize: 16, mr: 0.5, color: 'white' }} />}
                <span>{item.name}</span>
                <EditDeleteButton
                  isHovered={hoveredId === item.id}
                  onEdit={() => {
                    setCategoryModalOpen(true);
                    setCategoryModalInitial(item);
                  }}
                  onDelete={() => {
                    setDeleteModal({ open: true, category: item });
                  }}
                />
              </Button>
            );
          })}
        {!isFetching && (
          <AddButton
            onClick={() => {
              setCategoryModalOpen(true);
              setCategoryModalInitial(undefined);
            }}
          />
        )}
      </Stack>
      <CategoryFormModal
        open={categoryModalOpen}
        initialCategory={categoryModalInitial}
        onClose={() => {
          setCategoryModalOpen(false);
          setCategoryModalInitial(undefined);
        }}
      />
      <ConfirmModal
        open={deleteModal.open}
        title="Delete Category"
        description={
          <Typography>
            Are you sure you want to delete the category <b>{deleteModal.category?.name}</b>?
          </Typography>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        loading={isDeleting}
        onCancel={() => setDeleteModal({ open: false })}
        onConfirm={() => {
          if (deleteModal.category) {
            deleteCategory(deleteModal.category.id, {
              onSuccess: () => {
                toast.success('Category deleted');
                setDeleteModal({ open: false });
              },
              onError: () => {
                toast.error('Failed to delete category');
              },
            });
          }
        }}
      />
    </Box>
  );
};

const AddButton = ({ onClick }: { onClick: () => void }) => {
  return (
    <Button
      variant={'solid'}
      color={'primary'}
      onClick={onClick}
      sx={{
        position: 'sticky',
        right: 0,
        zIndex: 2,
        background: `linear-gradient(135deg, ${purple[300]} 0%, ${cyan[400]} 100%)`,
        transition: 'all 0.3s ease',
        borderRadius: '12px',
        px: 2,
        py: 1,
        fontWeight: 600,
        textTransform: 'none',
        fontSize: '12px',
        minWidth: 'auto',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        border: 'none',
        color: 'white',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: `0 4px 12px ${blackAlpha[0][10]}`,
        },
        '&:active': {
          transform: 'translateY(0px)',
        },
      }}
    >
      <AddIcon sx={{ fontSize: 18, mr: 0.5 }} />
      Add More
    </Button>
  );
};

const EditDeleteButton = ({
  isHovered,
  onEdit,
  onDelete,
}: {
  isHovered: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) => {
  return (
    <Box
      sx={{
        position: 'absolute',
        right: 6,
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        gap: 0.5,
        opacity: { xs: 1, sm: isHovered ? 1 : 0 },
        transition: 'opacity 0.2s',
        pointerEvents: { xs: 'auto', sm: isHovered ? 'auto' : 'none' },
      }}
    >
      <Tooltip title="Edit" placement="top">
        <IconButton
          size="sm"
          variant="soft"
          color="neutral"
          sx={{
            borderRadius: '8px',
            p: 0.5,
            minWidth: 28,
            minHeight: 28,
          }}
          onClick={e => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <EditIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Delete" placement="top">
        <IconButton
          size="sm"
          variant="soft"
          color="danger"
          sx={{
            borderRadius: '8px',
            p: 0.5,
            minWidth: 28,
            minHeight: 28,
          }}
          onClick={e => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <DeleteIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

const SkeletonLoader = () => (
  <>
    {Array.from({ length: 8 }).map((_, idx) => (
      <Skeleton
        key={idx}
        variant="rectangular"
        width={90}
        height={36}
        sx={{
          borderRadius: '12px',
        }}
      />
    ))}
  </>
);

export default BusinessLinkCategory;
