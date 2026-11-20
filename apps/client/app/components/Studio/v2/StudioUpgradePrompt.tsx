import { Typography } from '@mui/joy';
import type { StudioFeature } from '@bike4mind/common';
import { useBillingView } from '@client/app/components/subscription/BillingDeepLinkModals';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { StudioPanel } from '../design/StudioPanel';
import StudioPrimaryAction from '../design/StudioPrimaryAction';
import ProductionsShowcase from './ProductionsShowcase';
import StudioV2Frame from './StudioV2Frame';

const COPY: Partial<Record<StudioFeature, { title: string; body: string }>> = {
  productions: {
    title: 'Productions is a paid feature',
    body: 'Assemble your assets into ads and films on a timeline. Explore the sample below, then upgrade to create, edit and export your own.',
  },
};

/**
 * What a free user sees in place of a paid Studio feature, inside the Studio frame so the area tabs stay. The
 * Upgrade button opens the billing plans view; with billing off (`enforceCredits`) there is nothing to buy,
 * so the button is omitted, as ModelSelection does for its locked models.
 */
const StudioUpgradePrompt = ({ feature }: { feature: StudioFeature }) => {
  const { openView } = useBillingView();
  const isBillingEnabled = !!useGetSettingsValue('enforceCredits');
  const copy = COPY[feature] ?? { title: 'This is a paid feature', body: 'Upgrade your plan to open it.' };

  return (
    <StudioV2Frame area="productions" testId="studio-upgrade-page">
      <StudioPanel testId="studio-upgrade-prompt" aria-label={copy.title}>
        <Typography level="title-lg" component="h2">
          {copy.title}
        </Typography>
        <Typography level="body-md">{copy.body}</Typography>
        {isBillingEnabled && (
          <div>
            <StudioPrimaryAction testId="studio-upgrade-prompt-btn" onClick={() => openView('plans')}>
              Upgrade
            </StudioPrimaryAction>
          </div>
        )}
      </StudioPanel>
      {feature === 'productions' && <ProductionsShowcase />}
    </StudioV2Frame>
  );
};

export default StudioUpgradePrompt;
