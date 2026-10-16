import { Modal, ModalClose, ModalDialog, Tab, TabList, TabPanel, Tabs } from '@mui/joy';
import { useTranslation } from 'react-i18next';
import { useGetCreditTransactions } from '@client/app/hooks/data/credits';
import { type BillingView, parseBillingView } from '@client/app/utils/billingDeepLink';
import { CreditsModalContent } from './CreditsModal';
import { SubscriptionModalContent } from './SubscriptionModal';

interface BillingModalProps {
  open: boolean;
  view: BillingView;
  onViewChange: (view: BillingView) => void;
  onClose: () => void;
}

/**
 * One Billing popup with Credits and Subscriptions tabs. Takes its tab as a prop (the app shell
 * derives it from `?billing=`) so it does not depend on BillingDeepLinkModals. Only the active
 * panel is mounted, so each panel's queries run when it is shown.
 */
const BillingModal = ({ open, view, onViewChange, onClose }: BillingModalProps) => {
  const { t } = useTranslation();
  const getTransactions = useGetCreditTransactions({ enabled: open && view === 'credits' });

  return (
    <Modal open={open} onClose={onClose} data-testid="billing-modal">
      <ModalDialog sx={{ maxWidth: '1472px', width: '90%', p: 3, overflow: 'auto', gap: 0 }}>
        <ModalClose />
        <Tabs
          value={view}
          onChange={(_, value) => {
            const next = parseBillingView(value);
            if (next) onViewChange(next);
          }}
          sx={{ backgroundColor: 'transparent' }}
        >
          <TabList disableUnderline sx={{ mb: 2, mr: 5 }}>
            <Tab disableIndicator value="credits" data-testid="billing-tab-credits">
              {t('credits.title', 'Credits')}
            </Tab>
            <Tab disableIndicator value="plans" data-testid="billing-tab-plans">
              {t('subscriptions.title', 'Subscriptions')}
            </Tab>
          </TabList>
          <TabPanel value="credits" sx={{ p: 0 }}>
            {open && view === 'credits' && (
              <CreditsModalContent transactions={getTransactions.data || []} onClose={onClose} />
            )}
          </TabPanel>
          <TabPanel value="plans" sx={{ p: 0 }}>
            {open && view === 'plans' && <SubscriptionModalContent />}
          </TabPanel>
        </Tabs>
      </ModalDialog>
    </Modal>
  );
};

export default BillingModal;
