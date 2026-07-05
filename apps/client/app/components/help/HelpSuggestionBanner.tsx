import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded';
import { Alert, IconButton, Link } from '@mui/joy';
import { openHelpPanel } from '@client/app/hooks/useHelpPanel';
import { useRouteHelpSuggestions } from '@client/app/hooks/useRouteHelpSuggestions';

interface DismissedSuggestionsState {
  dismissedPaths: string[];
  dismiss: (path: string) => void;
}

/** Cap the persisted dismissal list so it can't grow unbounded as ROUTE_HELP_SUGGESTIONS scales. */
const MAX_DISMISSED_PATHS = 50;

/**
 * Per-route dismissal, persisted to localStorage so a suggestion the user dismisses stays gone
 * across sessions. Suggestions must be dismissible and non-intrusive.
 */
export const useDismissedHelpSuggestions = create<DismissedSuggestionsState>()(
  persist(
    set => ({
      dismissedPaths: [],
      dismiss: path =>
        set(state =>
          state.dismissedPaths.includes(path)
            ? state
            : { dismissedPaths: [...state.dismissedPaths, path].slice(-MAX_DISMISSED_PATHS) }
        ),
    }),
    { name: 'help-suggestion-dismissed' }
  )
);

/**
 * Context-aware help suggestion surface.
 *
 * Surfaces the help article mapped to the current route as a subtle, dismissible bottom-center
 * banner OUTSIDE the help chat - never a popup. Renders nothing when the current route has no mapped
 * help content or the user has already dismissed the suggestion for this route.
 */
export default function HelpSuggestionBanner() {
  const suggestion = useRouteHelpSuggestions();
  const dismissedPaths = useDismissedHelpSuggestions(state => state.dismissedPaths);
  const dismiss = useDismissedHelpSuggestions(state => state.dismiss);

  if (!suggestion || dismissedPaths.includes(suggestion.path)) return null;

  const primaryHelpId = suggestion.helpIds[0];

  return (
    <Alert
      data-testid="help-suggestion-banner"
      variant="soft"
      color="neutral"
      size="sm"
      startDecorator={<HelpOutlineRoundedIcon />}
      endDecorator={
        <IconButton
          data-testid="help-suggestion-dismiss-btn"
          variant="plain"
          color="neutral"
          size="sm"
          aria-label="Dismiss help suggestion"
          onClick={() => dismiss(suggestion.path)}
        >
          <CloseRoundedIcon />
        </IconButton>
      }
      sx={{
        // Bottom-center: the left sidebar occludes bottom-left, and the DataLakeUploadIndicator
        // owns bottom-right (fixed, bottom/right 24). Center clears both. zIndex sits above page
        // content but well below modals/menus (~10000).
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1200,
        maxWidth: 320,
        boxShadow: 'sm',
        alignItems: 'center',
      }}
    >
      <Link
        component="button"
        data-testid="help-suggestion-link"
        level="body-sm"
        onClick={() => openHelpPanel(primaryHelpId)}
        sx={{ textAlign: 'left' }}
      >
        {suggestion.label}
      </Link>
    </Alert>
  );
}
