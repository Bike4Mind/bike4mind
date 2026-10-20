import { Box, Chip, Link, Radio, RadioGroup, Sheet, Skeleton, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useCallback, useId, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { ICreditTransaction } from '@bike4mind/common';
import { CREDIT_PACKAGES } from '@client/lib/credits/constants';
import { CreditPackageId, TransactionType } from '@client/lib/credits/types';
import { formatCreditAmount, purchaseCreditsAriaLabel } from '@client/app/utils/formatCredits';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import CreditIcon from '@client/app/components/svgs/icons/CreditIcon';
import PaymentButton from '../Credits/PaymentButton';
import { formatPlanPrice, pricePerThousandCredits, sharedPackRate } from './billingFormat';

const creditPackages = Object.values(CREDIT_PACKAGES);
const packRate = sharedPackRate(creditPackages);
// The $20 pack starts selected: a neutral default, not a recommendation, so it carries no badge.
const DEFAULT_PACKAGE_ID: CreditPackageId = CreditPackageId.Usd20;

interface CreditsSectionProps {
  transactions: ICreditTransaction[];
  transactionsLoading?: boolean;
  /** Closes the Billing modal before navigating away (the usage link). */
  onClose: () => void;
}

type PurchaseTransaction = Extract<ICreditTransaction, { type: 'purchase' }>;

const isPurchase = (transaction: ICreditTransaction): transaction is PurchaseTransaction =>
  transaction.type === 'purchase';

const statusColor = (status: PurchaseTransaction['status']) =>
  status === 'completed' ? 'success' : status === 'pending' ? 'warning' : 'danger';

/** One-time credit packs and the purchase history, for the Billing modal. */
export const CreditsSection = ({ transactions, transactionsLoading, onClose }: CreditsSectionProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const historyHeadingId = useId();
  const [selectedId, setSelectedId] = useState<CreditPackageId>(DEFAULT_PACKAGE_ID);
  const selected = CREDIT_PACKAGES[selectedId];

  const handlePaymentComplete = useCallback(
    (credits: number) => {
      toast.success(t('credits_modal.purchase_success', { credits }));
    },
    [t]
  );

  const { selectedAccount } = useSelectedAccount();
  // Organization credits are bought by the org, so packs only show for the personal account.
  const canPurchaseCredits = !selectedAccount || selectedAccount.personal;
  const purchases = transactions.filter(isPurchase);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {canPurchaseCredits ? (
        <Box>
          <RadioGroup
            value={selectedId}
            onChange={event => setSelectedId(event.target.value as CreditPackageId)}
            aria-label={t('credits_modal.choose_pack', 'Choose a credit pack')}
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: `repeat(${creditPackages.length}, minmax(0, 1fr))` },
              gap: 1.5,
              m: 0,
            }}
          >
            {creditPackages.map(pkg => {
              const isSelected = pkg.id === selectedId;
              return (
                <Sheet
                  key={pkg.id}
                  variant="outlined"
                  data-testid={`credits-pack-${pkg.id}`}
                  sx={{
                    position: 'relative',
                    borderRadius: 'lg',
                    p: { xs: 2, sm: 2.5 },
                    bgcolor: 'background.surface',
                    transition: 'border-color 120ms ease, box-shadow 120ms ease',
                    '&:hover': { borderColor: isSelected ? 'primary.500' : 'neutral.400' },
                    ...(isSelected && {
                      borderColor: 'primary.500',
                      boxShadow: '0 0 0 1px var(--joy-palette-primary-500)',
                    }),
                  }}
                >
                  <Radio
                    value={pkg.id}
                    overlay
                    disableIcon
                    label={
                      <Box
                        component="span"
                        sx={{
                          display: 'flex',
                          flexDirection: { xs: 'row', sm: 'column' },
                          justifyContent: 'space-between',
                          alignItems: { xs: 'center', sm: 'stretch' },
                          gap: 2,
                        }}
                      >
                        <Box component="span" sx={{ display: 'flex', flexDirection: 'column' }}>
                          <Typography
                            component="span"
                            sx={{
                              fontSize: { xs: '1.375rem', sm: '1.625rem' },
                              lineHeight: 1.1,
                              fontWeight: 600,
                              letterSpacing: '-0.01em',
                              fontVariantNumeric: 'tabular-nums',
                              color: 'text.primary',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 0.75,
                            }}
                          >
                            <CreditIcon
                              aria-hidden
                              data-testid={`credits-pack-${pkg.id}-icon`}
                              sx={{ fontSize: '1.1em', color: 'subscription.creditsModal.iconFill' }}
                            />
                            {formatCreditAmount(pkg.credits)}
                          </Typography>
                          <Typography component="span" level="body-xs" sx={{ color: 'text.tertiary', mt: 0.25 }}>
                            {t('credits.unit', 'credits')}
                          </Typography>
                        </Box>
                        <Box
                          component="span"
                          sx={{ display: 'flex', flexDirection: 'column', textAlign: { xs: 'right', sm: 'left' } }}
                        >
                          <Typography component="span" level="title-md" sx={{ fontWeight: 600 }}>
                            {formatPlanPrice(pkg.price)}
                          </Typography>
                          <Typography
                            component="span"
                            level="body-xs"
                            sx={{ color: 'text.tertiary', mt: 0.25, display: { xs: 'none', sm: 'block' } }}
                          >
                            {packRate
                              ? pkg.description
                              : t('credits_modal.rate_per_thousand', {
                                  rate: pricePerThousandCredits(pkg.price, pkg.credits),
                                  defaultValue: '{{rate}} per 1,000 credits',
                                })}
                          </Typography>
                        </Box>
                      </Box>
                    }
                    slotProps={{
                      action: {
                        sx: {
                          borderRadius: 'lg',
                          '&:hover': { bgcolor: 'transparent' },
                          '&.Mui-focusVisible, &:focus-visible': {
                            outline: '2px solid var(--joy-palette-focusVisible)',
                            outlineOffset: '2px',
                          },
                        },
                      },
                      label: { sx: { width: '100%' } },
                    }}
                  />
                </Sheet>
              );
            })}
          </RadioGroup>
          <Box
            sx={{
              mt: 2,
              display: 'flex',
              alignItems: { xs: 'stretch', sm: 'center' },
              justifyContent: 'space-between',
              flexDirection: { xs: 'column-reverse', sm: 'row' },
              gap: 1.5,
            }}
          >
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid="credits-pack-rate">
              {packRate
                ? t('credits_modal.shared_rate', {
                    rate: packRate,
                    defaultValue: 'Every pack is the same rate: {{rate}} per 1,000 credits.',
                  })
                : null}
            </Typography>
            <PaymentButton
              transactionType={TransactionType.Package}
              packageId={selected.id}
              size="lg"
              label={t('credits_modal.buy_pack', {
                credits: formatCreditAmount(selected.credits),
                price: formatPlanPrice(selected.price),
                defaultValue: 'Buy {{credits}} credits for {{price}}',
              })}
              ariaLabel={purchaseCreditsAriaLabel(selected.credits, selected.price)}
              onPayment={handlePaymentComplete}
            />
          </Box>
        </Box>
      ) : (
        <Sheet
          variant="soft"
          className="credits-modal-organization-message"
          sx={{ borderRadius: 'lg', p: 3, bgcolor: 'background.level1' }}
        >
          <Typography level="title-sm" sx={{ mb: 0.5 }}>
            {t('credits_modal.organization_credits_active', 'Organization Credits Active')}
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
            {t(
              'credits_modal.switch_to_personal',
              'Switch to your personal account to purchase credits for personal use.'
            )}
          </Typography>
        </Sheet>
      )}

      <Box component="section" aria-labelledby={historyHeadingId}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 2, mb: 1 }}>
          <Typography id={historyHeadingId} level="title-sm" sx={{ fontWeight: 600 }}>
            {t('credits_modal.history_title')}
          </Typography>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {t('credits_modal.history_usage_hint', 'This lists purchases only.')}{' '}
            <Link
              component="button"
              type="button"
              level="body-xs"
              data-testid="credits-modal-see-usage-link"
              onClick={() => {
                onClose();
                void navigate({ to: '/profile', search: { tab: 'usage' } });
              }}
            >
              {t('credits_modal.see_usage', 'See usage')}
            </Link>
          </Typography>
        </Box>
        <Sheet variant="outlined" sx={{ borderRadius: 'lg', bgcolor: 'background.surface', overflow: 'hidden' }}>
          {transactionsLoading ? (
            [0, 1, 2].map(i => (
              <Box key={i} sx={{ px: 2, py: 1.5, borderTop: i ? '1px solid' : 'none', borderColor: 'divider' }}>
                <Skeleton variant="text" level="body-sm" sx={{ width: `${70 - i * 12}%` }} />
              </Box>
            ))
          ) : purchases.length > 0 ? (
            purchases.map((transaction, i) => (
              <Box
                key={transaction.id}
                className="credits-modal-transaction-item"
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr auto', sm: 'minmax(0, 1.3fr) minmax(0, 1fr) 80px 96px' },
                  alignItems: 'center',
                  columnGap: 2,
                  rowGap: 0.5,
                  px: 2,
                  py: 1.5,
                  borderTop: i ? '1px solid' : 'none',
                  borderColor: 'divider',
                }}
              >
                <Typography level="body-sm" sx={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                  {formatCreditAmount(transaction.credits)} {t('credits.unit', 'credits')}
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.tertiary', display: { xs: 'none', sm: 'block' } }}>
                  {dayjs(transaction.createdAt).format('MMM D, YYYY')}
                </Typography>
                <Typography
                  level="body-sm"
                  sx={{ fontVariantNumeric: 'tabular-nums', textAlign: { xs: 'right', sm: 'left' } }}
                >
                  ${(transaction.amount / 100).toFixed(2)}
                </Typography>
                <Box sx={{ textAlign: 'right', gridColumn: { xs: '1 / -1', sm: 'auto' } }}>
                  {/* Status is CreditTransactionStatus ('completed' | 'pending' | 'failed') from
                      b4m-core/common/src/types/entities/CreditTransactionTypes.ts. */}
                  <Chip size="sm" variant="soft" color={statusColor(transaction.status)}>
                    {transaction.status === 'completed'
                      ? t('credits_modal.status.completed')
                      : transaction.status === 'pending'
                        ? t('credits_modal.status.pending')
                        : transaction.status === 'failed'
                          ? t('credits_modal.status.failed')
                          : transaction.status}
                  </Chip>
                </Box>
              </Box>
            ))
          ) : (
            <Typography
              level="body-sm"
              className="credits-modal-no-transactions"
              sx={{ px: 2, py: 2.5, color: 'text.tertiary', textAlign: 'center' }}
            >
              {t('credits_modal.no_transactions')}
            </Typography>
          )}
        </Sheet>
      </Box>
    </Box>
  );
};
