import { useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import ButtonGroup from '@mui/joy/ButtonGroup';
import Checkbox from '@mui/joy/Checkbox';
import FormControl from '@mui/joy/FormControl';
import FormLabel from '@mui/joy/FormLabel';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Menu from '@mui/joy/Menu';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatApprovalAnswer, ChatApprovalChoice, ChatApprovalOption } from '@shared/chat';
import { CaretDownIcon } from './icons';

/**
 * The buttons on an approval card that can be answered in more than one way.
 *
 * A split button rather than three buttons in a row, because the options are not equals: one of
 * them is what the user almost always wants, and the card has to say so without hiding the
 * others. The primary face is the first option; the caret opens the rest, each with the line
 * that says what it actually does - the labels differ on two axes at once (whether a session is
 * started at all, and whose files it touches) and no label of a sensible length carries both.
 *
 * Built out of Joy's ButtonGroup and Menu because Joy has no split button and this feature is
 * not worth a dependency.
 */
export function ApprovalChoiceButtons({
  choice,
  onAnswer,
  onDeny,
  denyLabel,
  alwaysLabel,
  testPrefix,
}: {
  choice: ChatApprovalChoice;
  onAnswer: (answer: ChatApprovalAnswer) => void;
  onDeny: () => void;
  denyLabel: string;
  alwaysLabel: string;
  /** Distinguishes the transcript card's controls from the cross-session bar's. */
  testPrefix: string;
}) {
  const [primary, ...alternatives] = choice.options;
  const [open, setOpen] = useState(false);
  const [always, setAlways] = useState(false);
  // Keyed by option id rather than held as one value: each option has at most one field, and a
  // user who edits the branch, opens the menu and comes back should find their edit still there.
  const [values, setValues] = useState<Record<string, string>>({});
  const caret = useRef<HTMLButtonElement>(null);

  if (!primary) return null;

  const answer = (option: ChatApprovalOption) => {
    setOpen(false);
    if (option.redirect) {
      // Never 'always'. This is an instruction about THIS call - "do it here" cannot sensibly
      // stand for every later spawn - so the checkbox does not apply to it and nothing is
      // recorded; main refuses to record one for a redirect either.
      onAnswer({ decision: 'redirect', optionId: option.id });
      return;
    }
    onAnswer({
      decision: always ? 'always' : 'once',
      optionId: option.id,
      ...(option.field ? { value: values[option.id] ?? option.field.value } : {}),
    });
  };

  return (
    <Box data-testid={`${testPrefix}-choice`}>
      {choice.options.map(option =>
        option.field ? (
          <FormControl key={option.id} size="sm" sx={{ mt: 1 }}>
            <FormLabel sx={{ fontSize: 'xs' }}>{option.field.label}</FormLabel>
            <Input
              size="sm"
              value={values[option.id] ?? option.field.value}
              onChange={event => setValues(current => ({ ...current, [option.id]: event.target.value }))}
              slotProps={{ input: { 'data-testid': `${testPrefix}-field-${option.field.name}` } }}
            />
          </FormControl>
        ) : null
      )}

      <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <ButtonGroup size="sm" variant="solid" color="primary">
          <Button onClick={() => answer(primary)} data-testid={`${testPrefix}-option-${primary.id}`}>
            {primary.label}
          </Button>
          {alternatives.length > 0 && (
            <IconButton
              ref={caret}
              onClick={() => setOpen(value => !value)}
              aria-label="Other ways to start this"
              data-testid={`${testPrefix}-choice-more`}
            >
              <CaretDownIcon />
            </IconButton>
          )}
        </ButtonGroup>

        <Menu
          open={open}
          anchorEl={caret.current}
          onClose={() => setOpen(false)}
          placement="bottom-start"
          size="sm"
          sx={{ maxWidth: 320 }}
        >
          {alternatives.map(option => (
            <MenuItem
              key={option.id}
              onClick={() => answer(option)}
              data-testid={`${testPrefix}-option-${option.id}`}
              sx={{ flexDirection: 'column', alignItems: 'flex-start', gap: 0.25 }}
            >
              <Typography level="body-sm" fontWeight="lg">
                {option.label}
              </Typography>
              <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'normal' }}>
                {option.description}
              </Typography>
            </MenuItem>
          ))}
        </Menu>

        <Button size="sm" variant="plain" color="neutral" onClick={onDeny} data-testid={`${testPrefix}-deny`}>
          {denyLabel}
        </Button>
      </Stack>

      {/* A checkbox rather than a second button, because "always" has to name WHICH way: with
          three actions on the split button, an "always" button of its own could only ever have
          meant the primary one. Ticked, it rides along with whichever option is then clicked. */}
      <Checkbox
        size="sm"
        checked={always}
        onChange={event => setAlways(event.target.checked)}
        label={alwaysLabel}
        sx={{ mt: 1, '--Checkbox-size': '14px', fontSize: 'xs' }}
        slotProps={{ input: { 'data-testid': `${testPrefix}-always` } }}
      />

      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
        {primary.description}
      </Typography>
    </Box>
  );
}
