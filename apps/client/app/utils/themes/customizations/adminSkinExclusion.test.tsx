import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Button, Drawer, IconButton, Option, Select, Sheet, Typography } from '@mui/joy';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import FloatingChatWindow from '@client/app/components/Session/FloatingChatWindow';
import AppTheme from '../AppTheme';

// The real control cluster reaches SessionsContext/react-query; the header slot below carries the
// same kinds of Joy controls (a Select, an icon button) instead.
vi.mock('@client/app/components/Session/ChatPanelControls', () => ({ default: () => null }));

// No border-color: jsdom cannot resolve the var()s in Joy's border shorthand, so it reports a
// serialisation difference that a browser does not render.
const PROPS = [
  'color',
  'background-color',
  'border-radius',
  'box-shadow',
  'font-family',
  'font-size',
  'font-weight',
  'min-height',
  'padding-inline',
] as const;
const PILL_PROPS = ['color', 'background-color'];
const TEST_IDS = ['chat-title', 'chat-select', 'chat-icon-btn', 'chat-btn', 'chat-body-text'];

const ChatPanel = () => (
  <FloatingChatWindow
    title={
      <Typography data-testid="chat-title" level="body-sm">
        AI Chat
      </Typography>
    }
    headerActions={
      <>
        <Select
          data-testid="chat-select"
          size="sm"
          defaultValue="float"
          slotProps={{ listbox: { 'data-testid': 'chat-listbox' } as object }}
        >
          <Option value="float">Float</Option>
          <Option value="dock">Dock</Option>
        </Select>
        <IconButton data-testid="chat-icon-btn" size="sm" variant="plain" color="neutral">
          P
        </IconButton>
      </>
    }
  >
    <Typography data-testid="chat-body-text" level="body-sm">
      Hello
    </Typography>
    <Button data-testid="chat-btn" size="sm">
      Send
    </Button>
  </FloatingChatWindow>
);

const stylesOf = (testIds: string[], props: readonly string[] = PROPS) =>
  Object.fromEntries(
    testIds.map(testId => {
      const style = getComputedStyle(screen.getByTestId(testId));
      return [testId, props.map(prop => style.getPropertyValue(prop))];
    })
  );

const renderChat = (inAdmin: boolean) =>
  render(
    <AppTheme>
      {inAdmin ? (
        <Sheet data-admin-surface="" data-testid="admin-root">
          <ChatPanel />
        </Sheet>
      ) : (
        <ChatPanel />
      )}
    </AppTheme>
  );

describe('admin skin exclusion', () => {
  beforeEach(() => setSessionLayout({ layout: 'floatingChat', floatingChatMinimized: false }));
  afterEach(cleanup);

  // The admin dashboard mounts the floating AI chat inside its `data-admin-surface` root.
  it('renders the AI chat panel inside the admin root exactly as it does outside', () => {
    renderChat(false);
    const outside = stylesOf(TEST_IDS);
    cleanup();
    renderChat(true);

    expect(stylesOf(TEST_IDS)).toEqual(outside);
  });

  // The pill is itself the excluded root, so its own solid colours must outrank the restored type.
  // (Colours only: outside, the pill inherits body type from CssBaseline, which this harness omits.)
  it('keeps the minimized chat pill colours inside the admin root', () => {
    setSessionLayout({ layout: 'floatingChat', floatingChatMinimized: true });
    renderChat(false);
    const outside = stylesOf(['floating-chat-minimized'], PILL_PROPS);
    cleanup();
    renderChat(true);

    expect(stylesOf(['floating-chat-minimized'], PILL_PROPS)).toEqual(outside);
  });

  // A portalled popup has no DOM link to the chat; its expanded trigger inside the chat is what marks it.
  // (Tooltips key off `:hover`, which jsdom cannot simulate.)
  it("leaves the chat's own portalled listbox unskinned", () => {
    renderChat(false);
    fireEvent.click(screen.getByRole('combobox'));
    const outside = stylesOf(['chat-listbox']);
    cleanup();
    renderChat(true);
    fireEvent.click(screen.getByRole('combobox'));

    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true');
    expect(stylesOf(['chat-listbox'])).toEqual(outside);
  });

  it('restores every variable the admin root redefines, so nested Joy components read the app palette', () => {
    renderChat(true);
    const chat = screen.getByTestId('floating-chat-window');
    const adminRoot = screen.getByTestId('admin-root');
    const style = getComputedStyle(chat);

    expect(getComputedStyle(adminRoot).getPropertyValue('--joy-palette-primary-solidBg').trim()).toBe(
      'var(--joy-palette-admin-ink)'
    );
    expect(style.getPropertyValue('--joy-palette-primary-solidBg').trim()).toBe(
      'var(--app-joy-palette-primary-solidBg)'
    );
    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--app-joy-palette-primary-solidBg').trim()
    ).toBe('var(--joy-palette-primary-solidBg)');
  });

  // A disclosure that stays expanded (a "Show more" button, an accordion) is not a popup trigger.
  it('keeps admin popups skinned while the chat holds an expanded disclosure', () => {
    const renderAdminSelect = (chatExpanded: boolean) =>
      render(
        <AppTheme>
          <Sheet data-admin-surface="">
            <Select
              data-testid="admin-select"
              defaultValue="a"
              slotProps={{ listbox: { 'data-testid': 'admin-listbox' } as object }}
            >
              <Option value="a">A</Option>
            </Select>
          </Sheet>
          <div data-admin-surface-exclude="">
            <Button aria-expanded={chatExpanded}>Show more</Button>
          </div>
        </AppTheme>
      );
    renderAdminSelect(false);
    fireEvent.click(screen.getByTestId('admin-select'));
    const skinned = stylesOf(['admin-listbox']);
    cleanup();
    renderAdminSelect(true);
    fireEvent.click(screen.getByTestId('admin-select'));

    expect(stylesOf(['admin-listbox'])).toEqual(skinned);
  });

  // The help panel is a portalled Drawer, so it reaches the marker through the portal scope, not the
  // `[surface] [exclude]` variable restore the chat relies on.
  describe('portalled drawer', () => {
    const renderDrawer = (adminRoot: boolean, marked: boolean) =>
      render(
        <AppTheme>
          {adminRoot && <Sheet data-admin-surface="" />}
          <Drawer open {...(marked ? { 'data-admin-surface-exclude': '' } : {})}>
            <Button data-testid="drawer-btn">Go</Button>
          </Drawer>
        </AppTheme>
      );
    const buttonStyle = () => stylesOf(['drawer-btn']);

    it('skins an unmarked drawer under the admin root and leaves a marked one as the app renders it', () => {
      renderDrawer(false, false);
      const app = buttonStyle();
      cleanup();
      renderDrawer(true, false);
      const unmarked = buttonStyle();
      cleanup();
      renderDrawer(true, true);

      expect(unmarked).not.toEqual(app);
      expect(buttonStyle()).toEqual(app);
    });
  });
});
