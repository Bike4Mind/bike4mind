// Pure helpers for chess board UI rendering. Kept in their own file so they
// can be unit-tested without spinning up the full React component.

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

export const STARTING_PIECES: Record<PieceType, number> = {
  p: 8,
  n: 2,
  b: 2,
  r: 2,
  q: 1,
  k: 1,
};

export const PIECE_VALUES: Record<PieceType, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

// Order pieces high-value first when rendering captured strips
export const PIECE_ORDER: PieceType[] = ['q', 'r', 'b', 'n', 'p'];

// Outlined unicode glyphs (used to render captured pieces in the strip).
export const PIECE_GLYPH: Record<PieceType, string> = {
  k: '\u2654',
  q: '\u2655',
  r: '\u2656',
  b: '\u2657',
  n: '\u2658',
  p: '\u2659',
};

export interface CapturedSummary {
  capturedByWhite: PieceType[]; // black pieces white has taken
  capturedByBlack: PieceType[]; // white pieces black has taken
  materialAdvantage: number; // positive = white ahead
}

/**
 * Total number of pieces (both colors) on the board encoded by a FEN string.
 * Used to detect captures by comparing successive FENs.
 */
export function countPieces(fen: string): number {
  const placement = fen.split(' ')[0] || '';
  let n = 0;
  for (const ch of placement) if (/[a-zA-Z]/.test(ch)) n++;
  return n;
}

/**
 * Derive captured pieces and material balance from a FEN by counting surviving
 * pieces and comparing to the starting-position counts.
 *
 * Captured-by-white = black pieces missing from the board.
 * Captured-by-black = white pieces missing from the board.
 * materialAdvantage is positive when white is ahead.
 *
 * Note: this counts piece *type*, so a promoted pawn shows as a queen with no
 * extra pawn. That's the standard chess UI convention.
 */
export function summarizeCaptures(fen: string): CapturedSummary {
  const placement = fen.split(' ')[0] || '';
  const counts: Record<'w' | 'b', Record<PieceType, number>> = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };
  for (const ch of placement) {
    if (ch >= 'A' && ch <= 'Z') {
      const t = ch.toLowerCase() as PieceType;
      if (t in counts.w) counts.w[t]++;
    } else if (ch >= 'a' && ch <= 'z') {
      const t = ch as PieceType;
      if (t in counts.b) counts.b[t]++;
    }
  }
  const capturedByWhite: PieceType[] = [];
  const capturedByBlack: PieceType[] = [];
  let materialAdvantage = 0;
  for (const t of PIECE_ORDER) {
    const max = STARTING_PIECES[t];
    const wMissing = max - counts.w[t];
    const bMissing = max - counts.b[t];
    for (let i = 0; i < bMissing; i++) capturedByWhite.push(t);
    for (let i = 0; i < wMissing; i++) capturedByBlack.push(t);
    materialAdvantage += bMissing * PIECE_VALUES[t] - wMissing * PIECE_VALUES[t];
  }
  return { capturedByWhite, capturedByBlack, materialAdvantage };
}
