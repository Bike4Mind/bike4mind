import { useEffect } from 'react';
import { Modal, ModalClose, ModalDialog, Box } from '@mui/joy';
import Header from './Header';
import Search from './Search';
import BusinessLinkCategory from './BusinessLinkCategory';
import BusinessLink from './BusinessLink';
import ExportControls from './ExportControls';
import NoDataYet from './NoDataYet';
import { useBusinessLinkCategories, usePopularTargets } from './hooks';
import { whiteAlpha, grayAlpha, blackAlpha, gray } from '@client/app/utils/themes/colors';

interface IBaseProps {
  open: boolean;
  onClose: () => void;
}

export interface IOnSelect {
  onSelect: (url: string, company: string, fieldIndex: number) => void;
}

interface IPopularTargetsModal extends IBaseProps, IOnSelect {}

const PopularTargetsModal = ({ open, onClose, onSelect }: IPopularTargetsModal) => {
  const { setState } = usePopularTargets();
  const { data: categories, isLoading } = useBusinessLinkCategories({ pageSize: 1, pageNumber: 1 });

  useEffect(() => {
    if (!open) {
      setState({
        searchTerm: '',
      });
    }
  }, [open, setState]);

  return (
    <ModalContainer open={open} onClose={onClose}>
      {!isLoading && !categories?.data?.length ? (
        <NoDataYet />
      ) : (
        <>
          <Box sx={{ p: 2, pb: 1, position: 'relative' }}>
            <ExportControls />
            <Box sx={{ width: '100%', textAlign: 'center', mb: 1 }}>
              <Header />
            </Box>
            <BusinessLinkCategory />
            <Search />
          </Box>
          <BusinessLink onSelect={onSelect} />
        </>
      )}
    </ModalContainer>
  );
};

const ModalContainer = ({ open, onClose, children }: IBaseProps & { children: React.ReactNode }) => {
  return (
    <Modal
      open={open}
      onClose={onClose}
      sx={{
        position: 'fixed !important',
        inset: '0 !important',
        display: 'flex !important',
        justifyContent: 'center !important',
        alignItems: 'center !important',
        backdropFilter: 'blur(8px)',
        zIndex: 9999,
        m: '0 !important',
        p: '0 !important',
        '& .MuiModal-root': {
          position: 'fixed !important',
          inset: '0 !important',
        },
        '& > *': {
          position: 'relative !important',
        },
      }}
    >
      <ModalDialog
        sx={{
          position: 'fixed !important',
          top: '50% !important',
          left: '50% !important',
          transform: 'translate(-50%, -50%) !important',
          width: '90vw',
          height: '90vh',
          maxWidth: 'none',
          maxHeight: 'none',
          display: 'flex',
          flexDirection: 'column',
          background: `linear-gradient(135deg, ${whiteAlpha[0][98]} 0%, ${grayAlpha[15][95]} 50%, ${grayAlpha[5][98]} 100%)`,
          boxShadow: `0 25px 50px -12px ${blackAlpha[0][30]}, 0 0 0 1px ${whiteAlpha[0][5]}`,
          borderRadius: '20px',
          border: `1px solid ${whiteAlpha[0][30]}`,
          overflow: 'hidden',
          backdropFilter: 'blur(20px)',
          m: '0 !important',
          '&::before': {
            content: '""',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '4px',
            background: `linear-gradient(90deg, ${gray[780]} 0%, ${gray[750]} 25%, ${gray[680]} 50%, ${gray[750]} 75%, ${gray[780]} 100%)`,
            backgroundSize: '200% 100%',
            animation: 'corporate-shift 6s ease-in-out infinite',
          },
          '@keyframes corporate-shift': {
            '0%, 100%': {
              backgroundPosition: '0% 50%',
            },
            '50%': {
              backgroundPosition: '100% 50%',
            },
          },
        }}
      >
        <ModalClose
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
        {children}
      </ModalDialog>
    </Modal>
  );
};

export default PopularTargetsModal;
