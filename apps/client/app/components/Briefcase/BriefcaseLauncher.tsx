import { Button, Tooltip } from '@mui/joy';
import type { IBriefcasePromptDocument } from '@bike4mind/common';
import { useLaunchPrompt } from './useLaunchPrompt';

interface BriefcaseLauncherProps {
  prompt: IBriefcasePromptDocument;
  /** Called after a launch resolves (e.g. to close the toolbar popover). */
  onLaunched?: () => void;
}

/**
 * A single one-click launcher. Clicking resolves the prompt and dispatches it
 * into the chat send path. Disabled while a launch is in flight (single-flight).
 */
export function BriefcaseLauncher({ prompt, onLaunched }: BriefcaseLauncherProps) {
  const { launch, isLaunching } = useLaunchPrompt();

  const handleClick = async () => {
    const result = await launch(prompt.id);
    // Close the popover only on a real launch - keep it open on skip (in-flight)
    // or error so the user can retry. (launch() surfaces the error toast itself.)
    if (result.status === 'injected' || result.status === 'dispatched') onLaunched?.();
  };

  return (
    <Tooltip title={prompt.description ?? prompt.name} variant="soft" placement="top">
      <Button
        size="sm"
        variant="soft"
        color="neutral"
        loading={isLaunching}
        disabled={isLaunching}
        onClick={() => void handleClick()}
        data-testid={`briefcase-launcher-${prompt.id}`}
      >
        {prompt.name}
      </Button>
    </Tooltip>
  );
}
