import { Box, Typography, Modal, ModalDialog, ModalClose, Divider, useTheme } from '@mui/joy';
import Bike4MindIcon from '../svgs/icons/Bike4MindIcon';
import dayjs from 'dayjs';
import { CREDIT_PACKAGES } from '@client/lib/credits/constants';
import PaymentButton from '../Credits/PaymentButton';
import { TransactionType } from '@client/lib/credits/types';
import { FC, useCallback } from 'react';
import { toast } from 'sonner';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import { useGetCreditTransactions } from '@client/app/hooks/data/credits';
import { ICreditTransaction } from '@bike4mind/common';
import { useTranslation } from 'react-i18next';
import { LOW_CREDITS_THRESHOLD } from '../Session/CreditButton';
import {
  brand,
  brandAlpha,
  gray,
  grayAlpha,
  orange,
  orangeAlpha,
  red,
  redAlpha,
  blackAlpha,
} from '@client/app/utils/themes/colors';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';

export interface CreditPackage {
  id: string;
  price: string;
  credits: number;
  description: string;
}

interface CreditsModalProps {
  open: boolean;
  onClose: () => void;
}

const creditPackages = Object.values(CREDIT_PACKAGES);

const CreditsModal = ({ open, onClose }: CreditsModalProps) => {
  const getTransactions = useGetCreditTransactions({ enabled: open });
  return (
    <Modal open={open} onClose={onClose} className="credits-modal">
      <ModalDialog
        className="credits-modal-dialog"
        sx={{
          maxWidth: '1472px',
          width: '90%',
          p: 3,
          overflow: 'auto',
          gap: '0',
        }}
      >
        <ModalClose className="credits-modal-close" />
        {open && <CreditsModalContent transactions={getTransactions.data || []} />}
      </ModalDialog>
    </Modal>
  );
};

const CreditsModalContent: FC<{ transactions: ICreditTransaction[] }> = ({ transactions }) => {
  const { t } = useTranslation();
  const handlePaymentComplete = useCallback(
    (credits: number) => {
      toast.success(t('credits_modal.purchase_success', { credits }));
    },
    [t]
  );

  const { selectedAccount } = useSelectedAccount();
  const currentCredits = useEffectiveCredits();
  const theme = useTheme();
  const mode = theme.palette.mode;

  // Hide credit packages when selected account is an organization
  const canPurchaseCredits = !selectedAccount || selectedAccount.personal;
  const isLowCredits = currentCredits < LOW_CREDITS_THRESHOLD;
  const noCredits = currentCredits <= 0;
  const color = noCredits ? 'danger' : isLowCredits ? 'warning' : 'neutral';
  const safeMode = mode === 'dark' || mode === 'light' ? mode : 'light';
  const style = {
    dark: {
      borderColor: color === 'neutral' ? brandAlpha[100][15] : theme.palette[color][400],
      backgroundColor: color === 'neutral' ? gray[850] : theme.palette[color][800],
      color: color === 'neutral' ? brand[800] : theme.palette[color][400],
    },
    light: {
      borderColor: color === 'neutral' ? grayAlpha[150][50] : color === 'warning' ? orange[350] : red[600],
      ...(color === 'neutral'
        ? { backgroundColor: gray[10] }
        : {
            background:
              color === 'warning'
                ? `linear-gradient(${orangeAlpha[350][10]}, ${orangeAlpha[350][10]}), ${gray[10]}`
                : `linear-gradient(${redAlpha[600][10]}, ${redAlpha[600][10]}), ${gray[10]}`,
          }),
      color: color === 'neutral' ? brand[800] : color === 'warning' ? orange[350] : red[600],
    },
  };

  const filteredTransactions = transactions.filter(transaction => transaction.type === 'purchase');

  return (
    <>
      <Box
        className="credits-modal-header"
        sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: '32px' }}
      >
        <Typography
          className="credits-modal-title"
          sx={{ mb: '24px', fontSize: '24px', lineHeight: '24px', textAlign: 'center' }}
        >
          {t('credits_modal.title')}
        </Typography>
        <Typography
          className="credits-modal-description"
          sx={{
            mb: '24px',
            fontSize: '16px',
            lineHeight: '24px',
            textAlign: 'center',
            color: 'neutral.500',
            width: '700px',
          }}
        >
          {t('credits_modal.description')}
        </Typography>

        {(noCredits || isLowCredits) && (
          <Box
            className="credits-modal-warning"
            sx={{
              fontSize: '16px',
              mb: '32px',
            }}
          >
            <Typography
              className="credits-modal-warning-title"
              sx={{ textAlign: 'center', color: style[safeMode].borderColor, fontWeight: 500 }}
            >
              {noCredits ? t('credits_modal.no_credits') : t('credits_modal.low_credits')}
            </Typography>
            <Typography
              className="credits-modal-warning-subtitle"
              level="body-md"
              sx={{ textAlign: 'center', color: theme.palette.subscription?.creditsModal.subtitleColor }}
            >
              {noCredits ? t('credits_modal.no_credits_sub') : t('credits_modal.low_credits_sub')}
            </Typography>
          </Box>
        )}
        <Box
          className="credits-modal-current-balance"
          sx={{
            fontSize: '14px',
            border: '1px solid',
            borderRadius: '10px',
            py: '12px',
            px: '38px',
            display: 'flex',
            alignItems: 'center',
            flexDirection: 'column',
            fontWeight: '500',
            ...style[safeMode],
          }}
        >
          <Typography
            className="credits-modal-balance-label"
            level="body-md"
            sx={{
              textAlign: 'center',
              color: theme.palette.subscription?.creditsModal.subtitleColor,
              opacity: mode === 'dark' && color === 'neutral' ? 0.5 : 1,
            }}
          >
            {t('credits_modal.current_credits')}
          </Typography>
          <Typography
            className="credits-modal-balance-amount"
            sx={{
              display: 'flex',
              alignItems: 'center',
              color: style[safeMode].color,
              my: 1,
              fontSize: '16px',
              textAlign: 'center',
              gap: '8px',
            }}
          >
            <Bike4MindIcon size={'24'} fill={style[safeMode].color} />
            {currentCredits.toLocaleString()}
          </Typography>
        </Box>
      </Box>

      {canPurchaseCredits ? (
        <Box
          className="credits-modal-packages-grid"
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
            gap: 2,
          }}
        >
          {creditPackages.map(pkg => (
            <Box
              key={pkg.id}
              className={`credits-modal-package ${pkg.isBestValue ? 'credits-modal-package-best-value' : ''}`}
              sx={theme => ({
                width: '100%',
                border: '1px solid',
                borderColor: theme.palette.creditsModal.border,
                borderRadius: '10px',
                p: '24px',
                display: 'flex',
                position: 'relative',
                flexDirection: 'column',
                height: '100%',
                transition: 'all 0.2s ease-in-out',
                background: pkg.isBestValue ? theme.palette.creditsModal.gradient : theme.palette.primary.softBg,
                '&:hover': {
                  transform: 'translateY(-4px)',
                  boxShadow: `0 6px 20px ${blackAlpha[0][20]}`,
                  borderColor: pkg.isBestValue ? 'primary.500' : theme.palette.creditsModal.border,
                },
                ...(pkg.isBestValue
                  ? {
                      borderColor: 'primary.500',
                      boxShadow: '0 0 0 1px var(--joy-palette-primary-500)',
                    }
                  : {}),
              })}
            >
              {pkg.isBestValue && (
                <Box
                  className="credits-modal-package-badge"
                  sx={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    border: '1px solid',
                    borderColor: 'primary.500',
                    color: 'primary.500',
                    px: '10px',
                    py: '8px',
                    borderRadius: '60px',
                    fontSize: '14px',
                    lineHeight: '14px',
                  }}
                >
                  {t('credits_modal.best_value')}
                </Box>
              )}
              <Box
                className="credits-modal-package-credits"
                sx={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '24px' }}
              >
                <Bike4MindIcon size={'32'} fill={theme.palette.subscription?.creditsModal.iconFill} />
                {pkg.credits.toLocaleString()}
              </Box>
              <Typography
                className="credits-modal-package-description"
                level="body-sm"
                sx={{ mb: 2, mt: '10px', color: 'neutral.500', flexGrow: 1 }}
              >
                {pkg.description}
              </Typography>
              <Typography
                className="credits-modal-package-price"
                sx={{ fontWeight: '600', mb: 2, color: 'primary.500', fontSize: '32px' }}
              >
                ${pkg.price}
              </Typography>
              <PaymentButton
                transactionType={TransactionType.Package}
                packageId={pkg.id}
                onPayment={() => handlePaymentComplete(pkg.credits)}
              />
            </Box>
          ))}
        </Box>
      ) : (
        <Box
          className="credits-modal-organization-message"
          sx={{
            textAlign: 'center',
            py: 4,
            px: 3,
            border: '1px solid',
            borderColor: 'neutral.outlinedBorder',
            borderRadius: '10px',
            backgroundColor: 'background.surface',
          }}
        >
          <Typography level="body-lg" sx={{ mb: 1, fontWeight: 500 }}>
            {t('credits_modal.organization_credits_active', 'Organization Credits Active')}
          </Typography>
          <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
            {t(
              'credits_modal.switch_to_personal',
              'Switch to your personal account to purchase credits for personal use.'
            )}
          </Typography>
        </Box>
      )}

      <Divider
        sx={theme => ({
          my: '32px',
          ...(theme.palette.mode === 'dark' && {
            background: theme.palette.subscription?.creditsModal.dividerBackground,
          }),
        })}
      />

      <Box
        className="credits-modal-transactions"
        sx={theme => ({
          width: '100%',
          overflow: 'auto',
          maxHeight: '300px',
          bgcolor: theme.palette.primary.softBg,
          border: '1px solid',
          borderColor: theme.palette.creditsModal.border,
          borderRadius: '10px',
          p: '0 16px 16px',
        })}
      >
        <Box
          className="credits-modal-transactions-header"
          sx={theme => ({
            fontSize: '16px',
            lineHeight: '16px',
            fontWeight: '500',
            color: 'secondary',
            p: '32px 8px 24px',
            position: 'sticky',
            top: 0,
            backgroundColor: theme.palette.primary.softBg,
            zIndex: 1,
          })}
        >
          {t('credits_modal.history_title')}
        </Box>
        <Box
          className="credits-modal-transactions-list"
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          {filteredTransactions.length > 0 ? (
            filteredTransactions.map(transaction => (
              <Box
                key={transaction.id}
                className="credits-modal-transaction-item"
                sx={{
                  display: 'flex',
                  px: 2,
                  py: 1.5,
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: '6px',
                  bgcolor: 'background.surface',
                  alignItems: 'center',
                  '&:hover': {
                    backgroundColor: 'var(--joy-palette-background-level1)',
                  },
                }}
              >
                <Box
                  className="credits-modal-transaction-credits"
                  sx={{ width: '25%', display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <Bike4MindIcon size={'18'} />
                  {transaction.credits.toLocaleString()}
                </Box>
                <Box className="credits-modal-transaction-date" sx={{ width: '25%' }}>
                  {dayjs(new Date(transaction.createdAt).toLocaleDateString()).format('MMMM DD, YYYY')}
                </Box>
                <Box className="credits-modal-transaction-type" sx={{ width: '15%' }}>
                  {t('credits_modal.purchase')}
                </Box>
                <Box className="credits-modal-transaction-amount" sx={{ width: '15%' }}>
                  ${transaction.amount / 100}
                </Box>
                <Box className="credits-modal-transaction-status-container" sx={{ flexGrow: 1, textAlign: 'right' }}>
                  <Box
                    className={`credits-modal-transaction-status credits-modal-transaction-status-${transaction.status}`}
                    sx={{
                      display: 'inline-block',
                      px: 1,
                      py: 0.5,
                      borderRadius: 'sm',
                      color:
                        transaction.status === 'completed'
                          ? 'success.400'
                          : transaction.status === 'pending'
                            ? 'warning.400'
                            : 'danger.500',
                      fontSize: 'sm',
                      textTransform: 'capitalize',
                    }}
                  >
                    {/*
                      Transaction status comes from CreditTransactionStatus type in
                      b4m-core/common/src/types/entities/CreditTransactionTypes.ts
                      Possible values: 'completed' | 'pending' | 'failed'
                    */}
                    {transaction.status === 'completed'
                      ? t('credits_modal.status.completed')
                      : transaction.status === 'pending'
                        ? t('credits_modal.status.pending')
                        : transaction.status === 'failed'
                          ? t('credits_modal.status.failed')
                          : transaction.status}
                  </Box>
                </Box>
              </Box>
            ))
          ) : (
            <Box className="credits-modal-no-transactions" sx={{ p: 2, textAlign: 'center' }}>
              {t('credits_modal.no_transactions')}
            </Box>
          )}
        </Box>
      </Box>
    </>
  );
};

export default CreditsModal;
