import { useNavigate } from '@tanstack/react-router';
import { api } from '@client/app/contexts/ApiContext';
import { useFileBrowser } from '@client/app/components/Files/Browser';
import { openInNewTab } from '@client/app/utils/externalLinks';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';

/** Runs a gear's ctaAction - see lib/gears/presentation.ts for the grammar. */
export function useGearCta(onStamped?: () => void) {
  const navigate = useNavigate();
  const { setOpen: setFileBrowserOpen } = useFileBrowser();

  return (gear: Pick<GearStatus, 'ctaAction'>) => {
    const [action, stampDirective] = gear.ctaAction.split('#');
    const stampKey = stampDirective?.startsWith('stamp:') ? stampDirective.slice('stamp:'.length) : null;
    const claimStamp = () => {
      if (!stampKey) return;
      void api
        .post('/api/gears/stamp', { key: stampKey })
        .then(() => onStamped?.())
        .catch(() => undefined);
    };

    if (action === 'files') {
      setFileBrowserOpen(true);
      claimStamp();
      return;
    }
    if (action.startsWith('external:')) {
      openInNewTab(action.slice('external:'.length));
      claimStamp();
      return;
    }
    if (action.startsWith('navigate:')) {
      const target = action.slice('navigate:'.length);
      const [pathname, query] = target.split('?');
      const search = query ? Object.fromEntries(new URLSearchParams(query).entries()) : undefined;
      claimStamp();
      // Admin-authored paths aren't in TanStack's static route union.
      void navigate({ to: pathname, search } as never);
    }
  };
}
