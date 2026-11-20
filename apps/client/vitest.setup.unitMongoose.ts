import { vi } from 'vitest';

// A model call that slips past a suite's mocks fails at once instead of buffering for
// bufferTimeoutMS (10s) waiting on a connection the unit lane never opens. Applied on first
// import, so files that never load mongoose do not pay for it.
vi.mock('mongoose', async importOriginal => {
  const actual = await importOriginal<typeof import('mongoose')>();
  actual.default.set('bufferCommands', false);
  return actual;
});
