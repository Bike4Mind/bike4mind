/**
 * manageKnowledge - the ONE core implementation of the "manage knowledge" capability
 * (#841).
 *
 * Before this, every surface that wanted a manage affordance re-derived the same three
 * things by hand: the access gate (`EnableDataLakes`, plus admin for curated surfaces),
 * the open-manager wiring (the `useDataLakeWizardStore` singleton), and the button
 * itself. Product overlays each grew their own copy, so they drifted - one had the
 * admin gate and the button, another had neither.
 *
 * Two pieces, so a surface can consume whichever altitude it needs:
 *  - `useManageKnowledge()` - the capability (gate + wiring). Returns an `onManage`
 *    that is `undefined` when the user may not manage, which drops straight into an
 *    `onManage`-style prop whose affordance is already hidden when unset (see
 *    `DataLakeExplorer`).
 *  - `ManageKnowledgeButton` - the affordance, gate folded in. Renders nothing when
 *    the user may not manage, so a nav can mount it unconditionally.
 *
 * Anything product-flavored (the label) stays a surface token, per surfaceTokens.tsx.
 */

import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { Button } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useUser } from '@client/app/contexts/UserContext';

export interface ManageKnowledgeOptions {
  /**
   * Require platform admin on top of the `EnableDataLakes` flag.
   *
   * `false` (default) suits a surface where the user manages their OWN lakes - the
   * standalone `/data-lakes` home. Curated, admin-managed knowledge surfaces (the
   * product overlays, whose lakes are seeded per environment) pass `true`; that was
   * the `isAdmin && EnableDataLakes` predicate each of them used to hand-roll.
   */
  requireAdmin?: boolean;
}

export interface ManageKnowledgeCapability {
  /** Whether this user may manage knowledge on this surface. */
  canManage: boolean;
  /**
   * Opens the lake management panel - the store-driven singleton already mounted
   * globally by ProviderBundle. `undefined` when `canManage` is false, so passing it
   * through hides the consuming affordance instead of offering a dead action.
   */
  onManage?: () => void;
}

/**
 * The manage-knowledge capability for the current user: the access gate and the
 * open-manager wiring in one place.
 *
 * The server gates every `/api/data-lakes` endpoint on `EnableDataLakes`, so without
 * the flag the management panel is a dead end whose every request 403s - hence the
 * gate here rather than in each caller.
 */
export function useManageKnowledge({ requireAdmin = false }: ManageKnowledgeOptions = {}): ManageKnowledgeCapability {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const isAdmin = useUser(s => s.isAdmin ?? false);
  const openManager = useDataLakeWizardStore(s => s.openManager);

  const canManage = isAdminFeatureEnabled('EnableDataLakes') && (!requireAdmin || isAdmin);

  // Bare call: `openManager` takes an optional tab, and an onClick handler would
  // otherwise hand it a MouseEvent as that argument.
  return { canManage, onManage: canManage ? () => openManager() : undefined };
}

export interface ManageKnowledgeButtonProps extends ManageKnowledgeOptions {
  /**
   * Handler override, for a surface that already has a manage handler in hand (the
   * Explorer passes the one it was given). Omit it to use the shared wiring.
   *
   * Note the override is used AS GIVEN - a caller holding its own handler has done
   * its own gating (typically with `useManageKnowledge`), and double-gating here
   * would silently drop a deliberately-granted affordance.
   */
  onManage?: () => void;
  /** Defaults to the surface's `manageLabel` token. */
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'plain' | 'outlined' | 'soft' | 'solid';
  color?: 'primary' | 'neutral' | 'danger' | 'success' | 'warning';
  sx?: SxProps;
  /** Overridable so a second placement on one screen keeps a unique hook for tests. */
  testId?: string;
}

/**
 * The shared manage-knowledge affordance. Renders nothing when the user may not
 * manage, so a product nav can mount it unconditionally and stop re-deriving the gate.
 */
export function ManageKnowledgeButton({
  onManage,
  requireAdmin,
  label,
  size = 'sm',
  variant = 'outlined',
  color = 'neutral',
  sx,
  testId = 'datalake-manage-btn',
}: ManageKnowledgeButtonProps) {
  const capability = useManageKnowledge({ requireAdmin });
  const { copy } = useDataLakeSurface();
  const handleManage = onManage ?? capability.onManage;
  if (!handleManage) return null;

  return (
    <Button
      data-testid={testId}
      size={size}
      variant={variant}
      color={color}
      startDecorator={<SettingsOutlinedIcon sx={{ fontSize: 16 }} />}
      onClick={handleManage}
      sx={sx}
    >
      {label ?? copy.manageLabel}
    </Button>
  );
}
