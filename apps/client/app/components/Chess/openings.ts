// Common chess openings identified by their first few moves (SAN notation).
// Ported from erikbethke.com/apps/portfolio/app/projects/chess/lib/openings.ts.
const OPENINGS: [string, string][] = [
  // King's Pawn
  ['1.e4 e5 2.Nf3 Nc6 3.Bb5', 'Ruy Lopez'],
  ['1.e4 e5 2.Nf3 Nc6 3.Bc4', 'Italian Game'],
  ['1.e4 e5 2.Nf3 Nc6 3.d4', 'Scotch Game'],
  ['1.e4 e5 2.Nf3 Nf6', 'Petrov Defense'],
  ['1.e4 e5 2.Nf3 d6', 'Philidor Defense'],
  ['1.e4 e5 2.f4', 'King\u2019s Gambit'],
  ['1.e4 e5 2.Bc4', 'Bishop\u2019s Opening'],
  ['1.e4 e5 2.d4', 'Center Game'],
  ['1.e4 e5 2.Nc3', 'Vienna Game'],
  // Sicilian
  ['1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6', 'Sicilian Najdorf'],
  ['1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 g6', 'Sicilian Dragon'],
  ['1.e4 c5 2.Nf3 Nc6', 'Sicilian Defense'],
  ['1.e4 c5 2.Nf3 e6', 'Sicilian Kan/Taimanov'],
  ['1.e4 c5 2.Nf3 d6', 'Sicilian Defense'],
  ['1.e4 c5', 'Sicilian Defense'],
  // French, Caro-Kann, etc.
  ['1.e4 e6 2.d4 d5', 'French Defense'],
  ['1.e4 e6', 'French Defense'],
  ['1.e4 c6 2.d4 d5', 'Caro-Kann Defense'],
  ['1.e4 c6', 'Caro-Kann Defense'],
  ['1.e4 d6 2.d4 Nf6 3.Nc3 g6', 'Pirc Defense'],
  ['1.e4 d5', 'Scandinavian Defense'],
  ['1.e4 Nf6', 'Alekhine Defense'],
  ['1.e4 g6', 'Modern Defense'],
  // Queen's Pawn
  ['1.d4 d5 2.c4 e6 3.Nc3 Nf6', 'Queen\u2019s Gambit Declined'],
  ['1.d4 d5 2.c4 dxc4', 'Queen\u2019s Gambit Accepted'],
  ['1.d4 d5 2.c4 c6', 'Slav Defense'],
  ['1.d4 d5 2.c4', 'Queen\u2019s Gambit'],
  ['1.d4 Nf6 2.c4 g6 3.Nc3 Bg7 4.e4 d6', 'King\u2019s Indian Defense'],
  ['1.d4 Nf6 2.c4 g6 3.Nc3 d5', 'Gr\u00FCnfeld Defense'],
  ['1.d4 Nf6 2.c4 e6 3.Nc3 Bb4', 'Nimzo-Indian Defense'],
  ['1.d4 Nf6 2.c4 e6 3.Nf3 b6', 'Queen\u2019s Indian Defense'],
  ['1.d4 Nf6 2.c4 c5', 'Benoni Defense'],
  ['1.d4 f5', 'Dutch Defense'],
  // Flank
  ['1.c4 e5', 'English Opening'],
  ['1.c4', 'English Opening'],
  ['1.Nf3 d5 2.g3', 'King\u2019s Indian Attack'],
  ['1.Nf3', 'R\u00E9ti Opening'],
  ['1.g3', 'Hungarian Opening'],
  ['1.b3', 'Nimzo-Larsen Attack'],
  ['1.f4', 'Bird\u2019s Opening'],
  // Catch-alls
  ['1.e4 e5 2.Nf3', 'King\u2019s Knight Opening'],
  ['1.e4 e5', 'Open Game'],
  ['1.e4', 'King\u2019s Pawn Opening'],
  ['1.d4 d5', 'Queen\u2019s Pawn Game'],
  ['1.d4', 'Queen\u2019s Pawn Opening'],
];

// Pre-parse openings into move arrays for fast matching (longest-prefix wins).
const PARSED_OPENINGS = OPENINGS.map(([pattern, name]) => ({
  moves: pattern.replace(/\d+\./g, '').trim().split(/\s+/),
  name,
}));

/**
 * Identify the chess opening from a list of SAN moves.
 * Uses greedy longest-prefix matching against ~50 common openings.
 */
export function getOpeningName(moves: string[]): string {
  if (moves.length === 0) return 'Starting Position';

  let bestName = 'Unknown Opening';
  let bestLen = 0;

  for (const { moves: patternMoves, name } of PARSED_OPENINGS) {
    if (patternMoves.length > moves.length) continue;
    if (patternMoves.length <= bestLen) continue;

    let match = true;
    for (let i = 0; i < patternMoves.length; i++) {
      if (moves[i] !== patternMoves[i]) {
        match = false;
        break;
      }
    }

    if (match) {
      bestName = name;
      bestLen = patternMoves.length;
    }
  }

  return bestName;
}
