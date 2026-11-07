import { useState, type ReactElement } from 'react';
import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import Link from '@mui/joy/Link';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ChatApprovalMode } from '@shared/chat';
import { APPROVAL_MODE_FOOTNOTES, APPROVAL_MODE_OPTIONS, approvalModeOption } from './approvalModes';
import { CheckIcon, HandIcon, ShieldIcon, WarningIcon } from './icons';

const ICONS: Record<ChatApprovalMode, () => ReactElement> = {
  ask: HandIcon,
  auto: ShieldIcon,
  full: WarningIcon,
};

/**
 * How much this conversation may do without stopping to ask, changed without leaving it.
 *
 * Sits in the composer, beside the attach button, because the choice belongs to the next turn
 * the way the model does - and because a mode that only lived behind a popover would be a
 * standing permission the user had no way to notice. The two asking modes show only their icon
 * (named in the tooltip and aria-label) so the row stays quiet; "Full access" keeps its words
 * and its warning colour, because that is the one mode the user must never miss.
 *
 * This is the ONLY writer of the mode in the whole app. Nothing the model, a tool or an MCP
 * server produces reaches `onSelect`; see ChatService.setApprovalMode for the other half.
 */
export function ApprovalModePill({
  mode,
  disabled,
  onSelect,
}: {
  mode: ChatApprovalMode;
  disabled?: boolean;
  onSelect: (mode: ChatApprovalMode) => void;
}) {
  const [explained, setExplained] = useState(false);
  const current = approvalModeOption(mode);
  const CurrentIcon = ICONS[current.mode];
  const labelled = current.tone === 'warning';

  return (
    <Dropdown onOpenChange={(_event, open) => open && setExplained(false)}>
      <Tooltip title={`Approvals: ${current.label}`} size="sm" variant="soft" placement="top">
        <MenuButton
          size="sm"
          variant={current.mode === 'ask' ? 'plain' : 'soft'}
          color={current.tone === 'warning' ? 'warning' : current.mode === 'auto' ? 'primary' : 'neutral'}
          disabled={disabled}
          aria-label={`Approvals: ${current.label}`}
          sx={{
            fontWeight: 'normal',
            minWidth: 0,
            flexShrink: 0,
            borderRadius: 'xl',
            gap: 0.75,
            ...(labelled ? {} : { px: 0.75 }),
          }}
          slotProps={{ root: { 'data-testid': 'approval-mode-btn', 'data-mode': current.mode } }}
        >
          <CurrentIcon />
          {labelled && (
            <Typography level="body-xs" noWrap textColor="inherit">
              {current.label}
            </Typography>
          )}
        </MenuButton>
      </Tooltip>

      <Menu size="sm" placement="top-start" sx={{ maxWidth: 380, p: 1 }}>
        <Stack spacing={0.25} sx={{ px: 1, pb: 0.75 }}>
          <Typography level="title-sm">How should Bike4Mind actions be approved?</Typography>
          {/* Expands in place rather than opening a page: the app has no docs route, and a
              channel that opened an arbitrary URL would be a new hole beside the one this
              popover exists to close. */}
          <Link
            component="button"
            level="body-xs"
            underline="always"
            onClick={() => setExplained(value => !value)}
            data-testid="approval-mode-learn-more"
          >
            {explained ? 'Show less' : 'Learn more'}
          </Link>
        </Stack>

        {explained && (
          <Stack spacing={0.5} sx={{ px: 1, pb: 1 }} data-testid="approval-mode-explainer">
            {APPROVAL_MODE_FOOTNOTES.map(note => (
              <Typography key={note} level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'normal' }}>
                {note}
              </Typography>
            ))}
          </Stack>
        )}

        {APPROVAL_MODE_OPTIONS.map(option => {
          const Icon = ICONS[option.mode];
          // The one coloured row, and the only one: it is the option that removes the person
          // reading the command, so it must not look like the other two.
          const textColor = option.tone === 'warning' ? 'warning.plainColor' : undefined;
          return (
            <MenuItem
              key={option.mode}
              selected={option.mode === mode}
              onClick={() => onSelect(option.mode)}
              sx={{ alignItems: 'flex-start', gap: 1.25, py: 1 }}
              data-testid={`approval-mode-option-${option.mode}`}
            >
              <Box sx={{ pt: '2px', color: textColor ?? 'text.secondary' }}>
                <Icon />
              </Box>
              <Stack spacing={0.25} sx={{ minWidth: 0, flex: 1 }}>
                <Typography level="body-sm" textColor={textColor}>
                  {option.label}
                </Typography>
                <Typography level="body-xs" textColor={textColor ?? 'text.tertiary'} sx={{ whiteSpace: 'normal' }}>
                  {option.description}
                </Typography>
              </Stack>
              <Box sx={{ pt: '2px', color: 'text.secondary', visibility: option.mode === mode ? 'visible' : 'hidden' }}>
                <CheckIcon />
              </Box>
            </MenuItem>
          );
        })}
      </Menu>
    </Dropdown>
  );
}
