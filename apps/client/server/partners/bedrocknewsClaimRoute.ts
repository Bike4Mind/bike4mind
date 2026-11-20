import type { Request, Response } from 'express';
import { currentBalance, findPayableUser } from './bedrocknewsPuzzleReward';
import type { ClaimResult } from './bedrocknewsTickets';

const TICKET_BODY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const ticketFromBody = (body: unknown): string | null => {
  const ticket = (body as { ticket?: unknown } | null | undefined)?.ticket;
  return typeof ticket === 'string' && TICKET_BODY_PATTERN.test(ticket) ? ticket : null;
};

export async function answerClaim<S extends { state: string }>(
  req: Request,
  res: Response,
  run: (ticket: string, user: { id: string; email: string }) => Promise<S>
) {
  res.setHeader('Cache-Control', 'no-store');
  const ticket = ticketFromBody(req.body);
  if (!ticket) return res.status(400).json({ state: 'not-found' });

  const user = await findPayableUser(req.user.id);
  return res
    .status(200)
    .json(user ? await run(ticket, { id: req.user.id, email: user.email }) : { state: 'verify-email' });
}

// A stored result may carry the balance of whichever account redeemed; show the session user's own.
export const withOwnBalance = async (result: ClaimResult, userId: string): Promise<ClaimResult> => ({
  ...result,
  balance: await currentBalance(userId),
});
