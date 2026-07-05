import React, { useMemo } from 'react';
import { Box, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';

// Unicode chess pieces
// Solid/filled symbols for white pieces, outlined/hollow for black pieces
const PIECE_UNICODE: Record<string, string> = {
  K: '\u265A', // ♚ (solid)
  Q: '\u265B', // ♛ (solid)
  R: '\u265C', // ♜ (solid)
  B: '\u265D', // ♝ (solid)
  N: '\u265E', // ♞ (solid)
  P: '\u265F', // ♟ (solid)
  k: '\u2654', // ♔ (outlined)
  q: '\u2655', // ♕ (outlined)
  r: '\u2656', // ♖ (outlined)
  b: '\u2657', // ♗ (outlined)
  n: '\u2658', // ♘ (outlined)
  p: '\u2659', // ♙ (outlined)
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];

interface ChessBoardProps {
  fen: string;
  lastMove?: { from: string; to: string };
  orientation?: 'w' | 'b';
  size?: number;
  // Interactive props (optional, backward-compatible)
  selectedSquare?: string | null;
  legalMoveSquares?: string[];
  onSquareClick?: (square: string) => void;
  interactive?: boolean;
}

/**
 * Parses a FEN string into an 8x8 board array.
 * Returns board[rank][file] where rank 0 = rank 8 (top), file 0 = a-file.
 */
function parseFen(fen: string): (string | null)[][] {
  const board: (string | null)[][] = [];
  const placement = fen.split(' ')[0];
  const ranks = placement.split('/');

  for (const rank of ranks) {
    const row: (string | null)[] = [];
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < parseInt(ch, 10); i++) {
          row.push(null);
        }
      } else {
        row.push(ch);
      }
    }
    board.push(row);
  }

  return board;
}

/**
 * Converts algebraic notation (e.g., "e4") to row/col indices.
 */
function algebraicToIndices(sq: string): { row: number; col: number } | null {
  if (!sq || sq.length < 2) return null;
  const col = sq.charCodeAt(0) - 'a'.charCodeAt(0);
  const row = 8 - parseInt(sq[1], 10);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return { row, col };
}

const ChessBoard: React.FC<ChessBoardProps> = ({
  fen,
  lastMove,
  orientation = 'w',
  size = 360,
  selectedSquare,
  legalMoveSquares,
  onSquareClick,
  interactive = false,
}) => {
  const theme = useTheme();
  const mode = theme.palette.mode;

  const board = useMemo(() => parseFen(fen), [fen]);

  const lastMoveSquares = useMemo(() => {
    if (!lastMove) return new Set<string>();
    const fromIdx = algebraicToIndices(lastMove.from);
    const toIdx = algebraicToIndices(lastMove.to);
    const keys = new Set<string>();
    if (fromIdx) keys.add(`${fromIdx.row}-${fromIdx.col}`);
    if (toIdx) keys.add(`${toIdx.row}-${toIdx.col}`);
    return keys;
  }, [lastMove]);

  const legalMoveSet = useMemo(() => new Set(legalMoveSquares || []), [legalMoveSquares]);

  const squareSize = size / 8;
  const isFlipped = orientation === 'b';

  // Theme-aware colors
  const lightSquare = mode === 'dark' ? '#779952' : '#EEEED2';
  const darkSquare = mode === 'dark' ? '#46632a' : '#769656';
  const highlightLight = mode === 'dark' ? '#b8a832' : '#F6F669';
  const highlightDark = mode === 'dark' ? '#8a8020' : '#BACA2B';

  const displayRanks = isFlipped ? [...RANKS].reverse() : RANKS;
  const displayFiles = isFlipped ? [...FILES].reverse() : FILES;

  return (
    <Box
      sx={{
        display: 'inline-block',
        borderRadius: '4px',
        overflow: 'hidden',
        boxShadow: mode === 'dark' ? '0 2px 8px rgba(0,0,0,0.4)' : '0 2px 8px rgba(0,0,0,0.15)',
        lineHeight: 0,
      }}
    >
      {displayRanks.map((rank, displayRow) => {
        const boardRow = isFlipped ? 7 - displayRow : displayRow;
        return (
          <Box key={rank} sx={{ display: 'flex' }}>
            {displayFiles.map((file, displayCol) => {
              const boardCol = isFlipped ? 7 - displayCol : displayCol;
              const piece = board[boardRow]?.[boardCol] ?? null;
              const isLight = (boardRow + boardCol) % 2 === 0;
              const isHighlighted = lastMoveSquares.has(`${boardRow}-${boardCol}`);
              const sq = FILES[boardCol] + RANKS[boardRow];
              const isSelected = sq === selectedSquare;
              const isLegalMove = legalMoveSet.has(sq);

              let bgColor: string;
              if (isSelected) {
                bgColor = mode === 'dark' ? '#2b7a78' : '#7ec8c8';
              } else if (isHighlighted) {
                bgColor = isLight ? highlightLight : highlightDark;
              } else {
                bgColor = isLight ? lightSquare : darkSquare;
              }

              const isClickable = interactive && onSquareClick;

              return (
                <Box
                  key={`${rank}${file}`}
                  onClick={isClickable ? () => onSquareClick(sq) : undefined}
                  sx={{
                    width: squareSize,
                    height: squareSize,
                    backgroundColor: bgColor,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    position: 'relative',
                    userSelect: 'none',
                    cursor: isClickable ? 'pointer' : 'default',
                  }}
                >
                  {/* Legal move indicator */}
                  {isLegalMove && (
                    <Box
                      sx={{
                        position: 'absolute',
                        zIndex: 1,
                        width: piece ? '85%' : '30%',
                        height: piece ? '85%' : '30%',
                        borderRadius: '50%',
                        ...(piece
                          ? {
                              border: `3px solid ${mode === 'dark' ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.25)'}`,
                              background: 'transparent',
                            }
                          : {
                              background: mode === 'dark' ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.2)',
                            }),
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                  {/* Rank label on leftmost column */}
                  {displayCol === 0 && (
                    <Typography
                      sx={{
                        position: 'absolute',
                        top: 1,
                        left: 2,
                        fontSize: squareSize * 0.22,
                        fontWeight: 700,
                        color: isLight
                          ? mode === 'dark'
                            ? '#46632a'
                            : '#769656'
                          : mode === 'dark'
                            ? '#779952'
                            : '#EEEED2',
                        lineHeight: 1,
                        pointerEvents: 'none',
                      }}
                    >
                      {rank}
                    </Typography>
                  )}
                  {/* File label on bottom row */}
                  {displayRow === 7 && (
                    <Typography
                      sx={{
                        position: 'absolute',
                        bottom: 1,
                        right: 2,
                        fontSize: squareSize * 0.22,
                        fontWeight: 700,
                        color: isLight
                          ? mode === 'dark'
                            ? '#46632a'
                            : '#769656'
                          : mode === 'dark'
                            ? '#779952'
                            : '#EEEED2',
                        lineHeight: 1,
                        pointerEvents: 'none',
                      }}
                    >
                      {file}
                    </Typography>
                  )}
                  {/* Chess piece */}
                  {piece && (
                    <Typography
                      sx={{
                        fontSize: squareSize * 0.75,
                        lineHeight: 1,
                        textShadow:
                          piece === piece.toUpperCase() ? '0 1px 2px rgba(0,0,0,0.3)' : '0 1px 2px rgba(0,0,0,0.3)',
                        pointerEvents: 'none',
                      }}
                    >
                      {PIECE_UNICODE[piece] || ''}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
};

export default ChessBoard;
