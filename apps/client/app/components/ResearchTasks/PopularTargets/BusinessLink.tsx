import { useEffect, useMemo, useState } from 'react';
import { whiteAlpha, grayAlpha, blackAlpha, gray, cyan } from '@client/app/utils/themes/colors';
import { Box, Typography, Card, Chip, Tooltip, CircularProgress, IconButton, Button } from '@mui/joy';
import {
  Analytics,
  Edit,
  Delete,
  ContentCopy,
  CheckCircle,
  Add,
  AttachMoney,
  Business,
  TrendingUp,
} from '@mui/icons-material';
import { IResearchLinkDocument } from '@bike4mind/common';
import { useBusinessLinks, usePopularTargets, useDeleteBusinessLink } from './hooks';
import ConfirmModal from './ConfirmModal';
import BusinessLinkFormModal from './BusinessLinkFormModal';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { toast } from 'sonner';
import { IOnSelect } from '.';
import { PAGE_SIZE } from './utils';

const BusinessLink = ({ onSelect }: IOnSelect) => {
  const {
    state: { categoryId, searchTerm, categoryLoading, categoryAccentColor, fieldIndex },
    setState,
  } = usePopularTargets();
  const { data, isFetching } = useBusinessLinks(
    {
      pageSize: PAGE_SIZE,
      pageNumber: 1,
      filters: {
        search: searchTerm,
        categoryId,
      },
    },
    !!categoryId
  );

  useEffect(() => {
    setState({ businessLinksLoading: isFetching });
    if (!isFetching) {
      setState({ sources: data?.meta.pagination.total, total: data?.meta.overallTotal });
    }
  }, [isFetching, data, setState]);

  const isLoading = useMemo(() => categoryLoading || isFetching, [categoryLoading, isFetching]);
  const hasLinks = !!data?.data && data.data.length > 0;

  // Local state for modals and hover
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [editModal, setEditModal] = useState<{ open: boolean; link?: IResearchLinkDocument }>({
    open: false,
  });
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; link?: IResearchLinkDocument }>({
    open: false,
  });
  const { mutate: deleteBusinessLink, isPending: isDeleting } = useDeleteBusinessLink();
  const { copied, handleCopyToClipboard } = useCopyToClipboard();
  const [copiedId, setCopiedId] = useState<string | number | null>(null);

  const handleAdd = () => setEditModal({ open: true, link: undefined });

  const handleCopy = (url: string, id: string | number) => {
    handleCopyToClipboard(url);
    setCopiedId(id);
    toast.success('Copied to clipboard!');
    setTimeout(() => setCopiedId(null), 2000); // Reset after 2s
  };

  return (
    <Box
      sx={{
        flex: 1,
        overflowY: 'auto',
        px: 2,
        pb: 2,
        position: 'relative',
        '&::-webkit-scrollbar': {
          width: '8px',
        },
        '&::-webkit-scrollbar-track': {
          background: 'transparent',
        },
        '&::-webkit-scrollbar-thumb': {
          background: blackAlpha[0][20],
          borderRadius: '4px',
        },
        '&::-webkit-scrollbar-thumb:hover': {
          background: blackAlpha[0][30],
        },
      }}
    >
      {isLoading && <Loader />}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: 'repeat(3, 1fr)',
            sm: 'repeat(4, 1fr)',
            md: 'repeat(6, 1fr)',
            lg: 'repeat(8, 1fr)',
            xl: 'repeat(10, 1fr)',
          },
          gap: 2,
          alignItems: 'start',
          overflow: 'visible',
        }}
      >
        {/* Only show Add Company Card when not loading, not empty, and not searching */}
        {!isLoading && hasLinks && !searchTerm && <AddButton onClick={handleAdd} />}
        {/* Business Link Cards */}
        {!isLoading &&
          hasLinks &&
          data.data.map((item: IResearchLinkDocument, index: number) => (
            <Box
              key={index}
              sx={{ position: 'relative', transition: 'all 0.3s cubic-bezier(.4,2,.6,1)' }}
              onMouseEnter={() => setHoveredId(item.id || String(index))}
              onMouseLeave={() => setHoveredId(null)}
            >
              <Tooltip
                title={item.url}
                placement="top"
                arrow
                sx={{
                  '& .MuiTooltip-tooltip': {
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    maxWidth: '400px',
                    wordBreak: 'break-all',
                  },
                }}
              >
                <Card
                  variant="outlined"
                  sx={{
                    cursor: 'pointer',
                    position: 'relative',
                    zIndex: hoveredId === (item.id || String(index)) ? 2 : 1,
                    transition:
                      'box-shadow 0.25s cubic-bezier(.4,2,.6,1), border-color 0.22s, transform 0.22s cubic-bezier(.4,2,.6,1)',
                    border: '1.5px solid',
                    borderColor: hoveredId === (item.id || String(index)) ? categoryAccentColor : 'divider',
                    p: 2,
                    minHeight: '112px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center',
                    textAlign: 'center',
                    background: `linear-gradient(135deg, ${whiteAlpha[0][96]} 0%, ${grayAlpha[15][96]} 100%)`,
                    borderTop: `3px solid ${categoryAccentColor}`,
                    boxShadow:
                      hoveredId === (item.id || String(index))
                        ? `0 0 0 8px ${categoryAccentColor}22, 0 12px 48px 0 ${categoryAccentColor}33, 0 2px 12px 0 ${blackAlpha[0][6]}`
                        : `0 1px 4px 0 ${blackAlpha[0][6]}`,
                  }}
                  onClick={() => onSelect(item.url, item.name, fieldIndex)}
                >
                  {/* Top right edit/delete */}
                  {hoveredId === (item.id || String(index)) && (
                    <EditDeleteButton
                      onEdit={() => setEditModal({ open: true, link: { ...item, id: item.id } })}
                      onDelete={() => setDeleteModal({ open: true, link: { ...item, id: item.id } })}
                    />
                  )}
                  {/* Card content */}
                  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75 }}>
                    <Box sx={{ '& svg': { fontSize: '20px' } }}>{getCategoryIcon(item.type)}</Box>
                    <Typography level="body-sm" fontWeight={600} sx={{ fontSize: '15px', lineHeight: 1.2 }}>
                      {item.name}
                    </Typography>
                    <Chip
                      size="sm"
                      color={'primary'}
                      variant="soft"
                      sx={{ fontWeight: 600, fontSize: '13px', minHeight: '24px', px: 1 }}
                    >
                      {item.ticker}
                    </Chip>
                  </Box>
                  {/* Bottom right copy/checkmark */}
                  {hoveredId === (item.id || String(index)) && (
                    <Box sx={{ position: 'absolute', bottom: 8, right: 8, zIndex: 2 }}>
                      <Tooltip title={copied ? 'Copied to clipboard!' : 'Copy URL'} placement="left">
                        <IconButton
                          size="sm"
                          variant="soft"
                          color={copiedId === (item.id || index) ? 'success' : 'primary'}
                          sx={{ borderRadius: '8px', p: 0.5, minWidth: 28, minHeight: 28 }}
                          onClick={e => {
                            e.stopPropagation();
                            handleCopy(item.url, item.id || index);
                          }}
                        >
                          {copiedId === (item.id || index) ? (
                            <CheckCircle sx={{ fontSize: 18 }} />
                          ) : (
                            <ContentCopy sx={{ fontSize: 18 }} />
                          )}
                        </IconButton>
                      </Tooltip>
                    </Box>
                  )}
                </Card>
              </Tooltip>
            </Box>
          ))}
      </Box>
      {/* Empty State with Add Company CTA if not searching */}
      {!isLoading && !hasLinks && <EmptyState handleAdd={handleAdd} />}
      {/* Edit/Add Modal */}
      <BusinessLinkFormModal
        open={editModal.open}
        initialLink={editModal.link}
        onClose={() => setEditModal({ open: false, link: undefined })}
      />
      {/* Delete Modal */}
      <ConfirmModal
        open={deleteModal.open}
        title="Delete Company"
        description={
          <Typography>
            Are you sure you want to delete <b>{deleteModal.link?.name}</b>?
          </Typography>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        loading={isDeleting}
        onCancel={() => setDeleteModal({ open: false, link: undefined })}
        onConfirm={() => {
          if (deleteModal.link?.id) {
            deleteBusinessLink(deleteModal.link.id, {
              onSuccess: () => {
                setDeleteModal({ open: false, link: undefined });
              },
            });
          }
        }}
      />
    </Box>
  );
};

const EmptyState = ({ handleAdd }: { handleAdd: () => void }) => {
  const { state } = usePopularTargets();

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        py: 8,
        gap: 3,
      }}
    >
      <Box
        sx={{
          textAlign: 'center',
          py: 6,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          opacity: 0.85,
        }}
      >
        <Box
          sx={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            background: `linear-gradient(135deg, ${state.categoryAccentColor} 0%, ${gray[8]} 100%)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            mb: 2,
            boxShadow: `0 4px 24px ${blackAlpha[0][8]}`,
          }}
        >
          {getCategoryIcon('tech')}
        </Box>
        <Typography level="h4" sx={{ fontWeight: 700, color: state.categoryAccentColor, mb: 1 }}>
          No Companies Found
        </Typography>
        <Typography level="body-md" color="neutral" sx={{ maxWidth: 340, mx: 'auto', mb: 1 }}>
          {`We couldn't find any companies matching your search or selected category.`}
          <br />
          Try adjusting your search or picking a different category.
        </Typography>
      </Box>
      {!state.searchTerm && (
        <Button
          variant="solid"
          color="primary"
          size="lg"
          startDecorator={<Add />}
          sx={{
            background: `linear-gradient(135deg, ${state.categoryAccentColor} 0%, ${cyan[400]} 100%)`,
            borderRadius: '12px',
            px: 2,
            py: 1,
            fontWeight: 700,
            fontSize: '1rem',
            boxShadow: `0 4px 16px ${blackAlpha[0][8]}`,
            transition: 'all 0.2s cubic-bezier(.4,2,.6,1)',
            '&:hover': {
              background: `linear-gradient(135deg, ${cyan[400]} 0%, ${state.categoryAccentColor} 100%)`,
              transform: 'scale(1.04)',
            },
          }}
          onClick={handleAdd}
        >
          Add Company
        </Button>
      )}
    </Box>
  );
};

const AddButton = ({ onClick }: { onClick: () => void }) => {
  const { state } = usePopularTargets();

  return (
    <Card
      variant="outlined"
      sx={{
        cursor: 'pointer',
        position: 'relative',
        zIndex: 1,
        transition:
          'box-shadow 0.25s cubic-bezier(.4,2,.6,1), border-color 0.22s, transform 0.22s cubic-bezier(.4,2,.6,1)',
        border: '1.5px solid',
        borderColor: 'divider',
        p: 2,
        minHeight: '112px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        textAlign: 'center',
        background: `linear-gradient(135deg, ${whiteAlpha[0][96]} 0%, ${grayAlpha[15][96]} 100%)`,
        borderTop: `3px solid ${state.categoryAccentColor}`,
        boxShadow: `0 1px 4px 0 ${blackAlpha[0][1]}`,
        '&:hover': {
          borderColor: state.categoryAccentColor,
          boxShadow: `0 0 0 8px ${state.categoryAccentColor}22, 0 12px 48px 0 ${state.categoryAccentColor}33, 0 2px 12px 0 ${blackAlpha[0][1]}`,
          background: `linear-gradient(135deg, ${cyan[100]} 0%, ${cyan[50]} 100%)`,
        },
      }}
      onClick={onClick}
    >
      <Add sx={{ fontSize: 32, color: state.categoryAccentColor, mb: 1 }} />
      <Typography level="body-md" fontWeight={600} sx={{ color: state.categoryAccentColor }}>
        Add Company
      </Typography>
    </Card>
  );
};

const EditDeleteButton = ({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) => {
  return (
    <Box
      sx={{
        position: 'absolute',
        top: 8,
        right: 8,
        display: 'flex',
        gap: 0.5,
        zIndex: 2,
        borderRadius: '12px',
        p: 0.5,
        boxShadow: `0 4px 16px ${blackAlpha[0][18]}`,
        alignItems: 'center',
        border: `1px solid ${whiteAlpha[0][12]}`,
        backdropFilter: 'blur(8px)',
        transition: 'opacity 0.18s cubic-bezier(.4,2,.6,1)',
        minWidth: 72,
        minHeight: 40,
        overflow: 'visible',
        '::before': {
          content: '""',
          position: 'absolute',
          inset: 0,
          borderRadius: '12px',
          background: grayAlpha[780][72],
          opacity: 0.3,
          zIndex: 0,
          pointerEvents: 'none',
        },
      }}
    >
      <Tooltip title="Edit" placement="top">
        <IconButton
          size="sm"
          variant="soft"
          color="neutral"
          sx={{ borderRadius: '8px', p: 0.5, minWidth: 28, minHeight: 28 }}
          onClick={e => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <Edit sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Delete" placement="top">
        <IconButton
          size="sm"
          variant="soft"
          color="danger"
          sx={{ borderRadius: '8px', p: 0.5, minWidth: 28, minHeight: 28 }}
          onClick={e => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Delete sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

const Loader = () => {
  return (
    <Box
      sx={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2,
      }}
    >
      <CircularProgress />
    </Box>
  );
};

const getCategoryIcon = (category: string) => {
  switch (category) {
    case 'tech':
      return <Analytics sx={{ fontSize: 16 }} />;
    case 'finance':
      return <AttachMoney sx={{ fontSize: 16 }} />;
    case 'healthcare':
      return <Business sx={{ fontSize: 16 }} />;
    default:
      return <TrendingUp sx={{ fontSize: 16 }} />;
  }
};

export default BusinessLink;
