const TICKET_KEY = 'bedrocknews-claim-ticket';

// The ticket arrives as #ticket= (or ?ticket=) and moves into this tab's storage at once, so no
// address that logs, analytics, Referer or a login/consent redirect see ever carries it.
export function takeTicket(searchTicket: string | undefined): string | undefined {
  const fromUrl = new URLSearchParams(window.location.hash.slice(1)).get('ticket') ?? searchTicket;
  try {
    if (fromUrl) sessionStorage.setItem(TICKET_KEY, fromUrl);
    else return sessionStorage.getItem(TICKET_KEY) ?? undefined;
  } catch {
    // Storage blocked: the ticket lives only in this page's memory.
  }
  const query = new URLSearchParams(window.location.search);
  query.delete('ticket');
  const search = query.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
  return fromUrl;
}
