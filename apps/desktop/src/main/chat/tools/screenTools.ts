import { showImage, TOOL_IMAGE_MAX_EDGE } from './toolImages';
import type { ApprovalPrompt, ScreenContext, ScreenSource, ToolContext, ToolDefinition } from './types';

export const SCREEN_CAPTURE_TOOL_NAME = 'screen_capture';

/** A desktop with more windows than this is listed in part; the model narrows by title instead. */
const MAX_LISTED_SOURCES = 80;

function requireScreen(context: ToolContext): ScreenContext {
  if (!context.screen) throw new Error('Screen capture is not available in this session.');
  return context.screen;
}

function targetOf(input: Record<string, unknown>): string | undefined {
  return typeof input.target === 'string' && input.target.trim() ? input.target.trim() : undefined;
}

/** Throws the capturer's own words for a denied or unsupported platform, which name where to change it. */
function assertUsable(screen: ScreenContext): void {
  const access = screen.capturer.access();
  if (access.state === 'denied' || access.state === 'unsupported') throw new Error(access.message);
}

function describeSource(source: ScreenSource): string {
  return source.kind === 'screen' ? `the screen "${source.name}"` : `the window "${source.name || 'untitled'}"`;
}

function listing(sources: readonly ScreenSource[]): string[] {
  const shown = sources.slice(0, MAX_LISTED_SOURCES).map(source => {
    const label = source.kind === 'screen' ? `screen: ${source.name}` : source.name || '(untitled)';
    return `  ${source.id}  ${label}`;
  });
  if (sources.length > MAX_LISTED_SOURCES) {
    shown.push(`  ... and ${sources.length - MAX_LISTED_SOURCES} more; pass part of a title to narrow it.`);
  }
  return shown;
}

/**
 * The one source `target` names: an id from the list, "screen" for the first display, or a title
 * matched exactly and then as a case-insensitive substring. More than one match is refused rather
 * than guessed, since a wrong window is a different person's screen as much as the right one.
 */
export function resolveScreenTarget(target: string, sources: readonly ScreenSource[]): ScreenSource {
  const byId = sources.find(source => source.id === target);
  if (byId) return byId;
  const needle = target.toLowerCase();
  if (needle === 'screen') {
    const screen = sources.find(source => source.kind === 'screen');
    if (screen) return screen;
  }
  const exact = sources.filter(source => source.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const partial = exact.length > 1 ? exact : sources.filter(source => source.name.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      [`${partial.length} windows match "${target}". Pass the id of the one you mean:`, ...listing(partial)].join('\n')
    );
  }
  throw new Error(
    [
      `Nothing open matches "${target}". A window that is still starting may not be listed yet.`,
      'Open now:',
      ...listing(sources),
    ].join('\n')
  );
}

function approvedSourceId(key: string | undefined): string | undefined {
  const prefix = `${SCREEN_CAPTURE_TOOL_NAME}\x00`;
  if (!key?.startsWith(prefix)) return undefined;
  const id = key.slice(prefix.length);
  return /^(window|screen):/.test(id) ? id : undefined;
}

const READ_AS_YOU = 'What it shows, from any app on screen, goes to the model.';

export const screenCapture: ToolDefinition = {
  schema: {
    name: SCREEN_CAPTURE_TOOL_NAME,
    description:
      "Look at a window of another app on this computer, or a whole screen. Without a target it lists the open windows and screens with their ids. With one it captures that window as an image you see (when the model accepts images) and the user sees in the conversation. Use it to check a desktop app's UI - an Electron or native build you started with bash_background, for example - after its window has opened. Each capture asks the user first. For a web page, use the browser tools instead.",
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'A window id from the list, part of a window title (case-insensitive, must match one window), or "screen" for the main display. Omit it to list what is open.',
        },
        caption: { type: 'string', description: 'What this capture shows, for the user.' },
      },
    },
  },
  async approval(input, context): Promise<ApprovalPrompt> {
    const screen = requireScreen(context);
    assertUsable(screen);
    const target = targetOf(input);
    if (!target) {
      return {
        detail: 'List the titles of the windows open on this computer',
        key: `${SCREEN_CAPTURE_TOOL_NAME}\x00list`,
        askInAuto: true,
      };
    }
    // Listing here before macOS has asked would raise its permission prompt behind the card.
    if (screen.capturer.access().state === 'not-determined') {
      return {
        detail: `Capture "${target}" on your screen\n\n${READ_AS_YOU} macOS asks for Screen Recording permission first.`,
        key: `${SCREEN_CAPTURE_TOOL_NAME}\x00${target}`,
        askInAuto: true,
      };
    }
    const source = resolveScreenTarget(target, await screen.capturer.list());
    return {
      detail: `Capture ${describeSource(source)}\n\n${READ_AS_YOU}`,
      key: `${SCREEN_CAPTURE_TOOL_NAME}\x00${source.id}`,
      askInAuto: true,
    };
  },
  async run(input, context) {
    const screen = requireScreen(context);
    assertUsable(screen);
    const target = targetOf(input);
    const sources = await screen.capturer.list();
    const blocked = screen.capturer.access();
    // Asked for the first time just now; macOS applies the answer only after a relaunch.
    if (blocked.state !== 'granted') {
      throw new Error(
        blocked.state === 'not-determined'
          ? 'macOS has not allowed Screen Recording for this app yet. Ask the user to allow it in the prompt, or in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen the app. Do not try to change the setting yourself.'
          : blocked.message
      );
    }

    if (!target) {
      context.report?.label('Listed open windows');
      if (sources.length === 0) return 'No windows or screens are open to capture.';
      return [`${sources.length} window(s) and screen(s) open:`, ...listing(sources)].join('\n');
    }

    const source = resolveScreenTarget(target, sources);
    // A title is matched again here, and the window it named may have closed since the card was
    // answered; only the window the user saw named is captured.
    const approvedId = approvedSourceId(context.approvedKey);
    if (approvedId && approvedId !== source.id) {
      throw new Error(
        `The windows changed after the user approved the capture: "${target}" now matches ${describeSource(source)}, which was not approved. Call screen_capture again.`
      );
    }
    context.report?.label(`Captured ${describeSource(source)}`);
    const bytes = await screen.capturer.capture(source.id, TOOL_IMAGE_MAX_EDGE);
    if (!bytes) {
      throw new Error(
        `Could not capture ${describeSource(source)}: it closed, or it is minimized or on another desktop. List the windows again and retry.`
      );
    }

    const caption = typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim() : source.name;
    const kept = await screen.keepScreenshot(bytes, caption);
    if (kept) context.report?.media(kept);
    const shown = showImage(context, bytes, 'image/png');
    if (!shown.ok)
      return `Captured ${describeSource(source)} and showed it to the user, but not to you: ${shown.reason}.`;
    const pixels = shown.pixels ? ` (${shown.pixels})` : '';
    return `Captured ${describeSource(source)}${pixels}. You see it below this result in this reply only; capture again to look at it later.`;
  },
};
