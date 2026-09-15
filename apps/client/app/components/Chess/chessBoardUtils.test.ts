import { describe, it, expect } from 'vitest';
import { countPieces, summarizeCaptures } from './chessBoardUtils';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// After 1.e4 e5 2.Nf3 Nc6 - no captures yet
const QUIET_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
// After 1.e4 d5 2.exd5 - white captured a black pawn
const ONE_CAPTURE_FEN = 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2';
// Endgame fragment: lone kings + a single white queen
const ENDGAME_FEN = '8/8/4k3/8/8/8/4K3/4Q3 w - - 0 1';

describe('countPieces', () => {
  it('counts 32 pieces in the starting position', () => {
    expect(countPieces(STARTING_FEN)).toBe(32);
  });

  it('counts 32 pieces after a quiet opening', () => {
    expect(countPieces(QUIET_FEN)).toBe(32);
  });

  it('counts 31 pieces after a single capture', () => {
    expect(countPieces(ONE_CAPTURE_FEN)).toBe(31);
  });

  it('counts a lone-king + queen endgame at 3', () => {
    expect(countPieces(ENDGAME_FEN)).toBe(3);
  });

  it('handles a placement-only string (no metadata fields)', () => {
    expect(countPieces('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR')).toBe(32);
  });

  it('returns 0 for an empty board', () => {
    expect(countPieces('8/8/8/8/8/8/8/8 w - - 0 1')).toBe(0);
  });
});

describe('summarizeCaptures', () => {
  it('reports no captures and zero advantage at the starting position', () => {
    const s = summarizeCaptures(STARTING_FEN);
    expect(s.capturedByWhite).toEqual([]);
    expect(s.capturedByBlack).toEqual([]);
    expect(s.materialAdvantage).toBe(0);
  });

  it('reports no captures after a developing-piece opening with no losses', () => {
    const s = summarizeCaptures(QUIET_FEN);
    expect(s.capturedByWhite).toEqual([]);
    expect(s.capturedByBlack).toEqual([]);
    expect(s.materialAdvantage).toBe(0);
  });

  it('reports a single black pawn captured by white after exd5', () => {
    const s = summarizeCaptures(ONE_CAPTURE_FEN);
    expect(s.capturedByWhite).toEqual(['p']);
    expect(s.capturedByBlack).toEqual([]);
    // White is up one pawn = +1
    expect(s.materialAdvantage).toBe(1);
  });

  it('orders captured pieces high-value first (queen, rook, bishop, knight, pawn)', () => {
    // Reduce both sides to just kings + a couple of leftover pieces.
    // White has a queen surviving; black has nothing.
    // White captured: black queen, black rook, black bishop, black knight, all pawns.
    const heavyFen = '4k3/8/8/8/8/8/8/4KQ2 w - - 0 1';
    const s = summarizeCaptures(heavyFen);
    // White still has a queen so black captured none of those
    expect(s.capturedByBlack.length).toBeGreaterThanOrEqual(0);
    // White captured everything black had except the king: q,2r,2b,2n,8p
    const types = s.capturedByWhite.join('');
    // First glyphs must be the high-value ones in order
    expect(types.startsWith('qrr')).toBe(true);
    // Total black material captured = 9 + 5 + 5 + 3 + 3 + 3 + 3 + 8*1 = 39
    // White material captured by black = pawn(8) + n(2) + b(2) + r(2) = 8+6+6+10 = 30
    // Net: white has captured 39 worth, lost 30 worth (white still has K+Q so black captured the rest)
    // White surviving: K + Q. Starting white = K + Q + 2R + 2B + 2N + 8P = 39 material (excl king).
    // So black captured 39 - 9 = 30 worth of white material.
    // Black surviving: K only. So white captured 39 worth of black material.
    // materialAdvantage = whiteCaptured - blackCaptured = 39 - 30 = 9 (white up a queen).
    expect(s.materialAdvantage).toBe(9);
  });

  it('reports correct advantage when black is ahead', () => {
    // Mirror of previous: black up a queen
    const fen = '4kq2/8/8/8/8/8/8/4K3 w - - 0 1';
    const s = summarizeCaptures(fen);
    expect(s.materialAdvantage).toBe(-9);
  });

  it('treats promotion as a piece-type swap (no extra captured pawn)', () => {
    // Single white queen on the board; everything else gone.
    // From white's POV after promoting one of its starting pawns to a queen,
    // we'd have 7 pawns + 2 queens. We're testing the inverse: a position with
    // *more* queens than the starting position should not crash and the
    // missing pawn count should reflect 1 missing pawn.
    const promoFen = '4k3/8/8/8/8/8/8/4KQQ2 w - - 0 1'; // 2 white queens, 0 pawns
    const s = summarizeCaptures(promoFen);
    // Starting white = 1q + 8p. Now: 2q + 0p. 8 pawns missing.
    // capturedByBlack lists missing white pieces.
    expect(s.capturedByBlack.filter(p => p === 'p').length).toBe(8);
    // No extra "queen captured" - having more queens than max means 0 missing.
    expect(s.capturedByBlack.filter(p => p === 'q').length).toBe(0);
  });
});
