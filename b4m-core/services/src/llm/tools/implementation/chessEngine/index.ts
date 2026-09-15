import { Chess, Move } from 'chess.js';
import { ToolDefinition } from '../../base/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChessAction =
  | 'new_game'
  | 'play_turn'
  | 'get_legal_moves'
  | 'evaluate_position'
  | 'get_best_move'
  | 'get_game_status';

type Difficulty = 'beginner' | 'intermediate' | 'advanced';

interface ChessEngineParams {
  action: ChessAction;
  fen?: string;
  move?: string;
  difficulty?: Difficulty;
}

// ---------------------------------------------------------------------------
// Piece values for evaluation
// ---------------------------------------------------------------------------

const PIECE_VALUES: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
};

// Piece-square tables (from white's perspective, index 0 = a8)
const PST_PAWN = [
  0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0,
  0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0,
];

const PST_KNIGHT = [
  -50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15,
  20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];

const PST_BISHOP = [
  -20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10,
  5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10,
  -10, -10, -10, -10, -10, -20,
];

const PST_ROOK = [
  0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0,
  0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0,
];

const PST_QUEEN = [
  -20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0,
  -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10,
  -20,
];

const PST_KING_MIDDLEGAME = [
  -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40,
  -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20,
  -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20,
];

const PIECE_SQUARE_TABLES: Record<string, number[]> = {
  p: PST_PAWN,
  n: PST_KNIGHT,
  b: PST_BISHOP,
  r: PST_ROOK,
  q: PST_QUEEN,
  k: PST_KING_MIDDLEGAME,
};

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------

function evaluatePosition(game: Chess): number {
  if (game.isCheckmate()) {
    return game.turn() === 'w' ? -99999 : 99999;
  }
  if (game.isDraw() || game.isStalemate()) {
    return 0;
  }

  let score = 0;
  const board = game.board();

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = board[rank][file];
      if (!piece) continue;

      const tableIndex = rank * 8 + file;
      // For black pieces, mirror the table index vertically
      const pstIndex = piece.color === 'w' ? tableIndex : (7 - rank) * 8 + file;
      const pst = PIECE_SQUARE_TABLES[piece.type] || [];
      const positionalValue = pst[pstIndex] || 0;
      const materialValue = PIECE_VALUES[piece.type] || 0;

      if (piece.color === 'w') {
        score += materialValue + positionalValue;
      } else {
        score -= materialValue + positionalValue;
      }
    }
  }

  return score;
}

function getMaterialCount(game: Chess): Record<string, { w: number; b: number }> {
  const counts: Record<string, { w: number; b: number }> = {
    pawns: { w: 0, b: 0 },
    knights: { w: 0, b: 0 },
    bishops: { w: 0, b: 0 },
    rooks: { w: 0, b: 0 },
    queens: { w: 0, b: 0 },
  };

  const board = game.board();
  for (const row of board) {
    for (const piece of row) {
      if (!piece) continue;
      const color = piece.color as 'w' | 'b';
      switch (piece.type) {
        case 'p':
          counts.pawns[color]++;
          break;
        case 'n':
          counts.knights[color]++;
          break;
        case 'b':
          counts.bishops[color]++;
          break;
        case 'r':
          counts.rooks[color]++;
          break;
        case 'q':
          counts.queens[color]++;
          break;
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Minimax with alpha-beta pruning
// ---------------------------------------------------------------------------

function getSearchDepth(difficulty: Difficulty): number {
  switch (difficulty) {
    case 'beginner':
      return 2;
    case 'intermediate':
      return 3;
    case 'advanced':
      return 4;
  }
}

function orderMoves(game: Chess): Move[] {
  const moves = game.moves({ verbose: true });
  // Simple move ordering: captures first, then checks, then others
  return moves.sort((a: Move, b: Move) => {
    let scoreA = 0;
    let scoreB = 0;
    if (a.captured) scoreA += PIECE_VALUES[a.captured] || 0;
    if (b.captured) scoreB += PIECE_VALUES[b.captured] || 0;
    // Prefer center moves
    if (a.to === 'e4' || a.to === 'd4' || a.to === 'e5' || a.to === 'd5') scoreA += 10;
    if (b.to === 'e4' || b.to === 'd4' || b.to === 'e5' || b.to === 'd5') scoreB += 10;
    return scoreB - scoreA;
  });
}

function minimax(game: Chess, depth: number, alpha: number, beta: number, isMaximizing: boolean): number {
  if (depth === 0 || game.isGameOver()) {
    return evaluatePosition(game);
  }

  const moves = orderMoves(game);

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const move of moves) {
      game.move(move.san);
      const evalScore = minimax(game, depth - 1, alpha, beta, false);
      game.undo();
      maxEval = Math.max(maxEval, evalScore);
      alpha = Math.max(alpha, evalScore);
      if (beta <= alpha) break;
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for (const move of moves) {
      game.move(move.san);
      const evalScore = minimax(game, depth - 1, alpha, beta, true);
      game.undo();
      minEval = Math.min(minEval, evalScore);
      beta = Math.min(beta, evalScore);
      if (beta <= alpha) break;
    }
    return minEval;
  }
}

function findBestMove(game: Chess, difficulty: Difficulty): string | null {
  const depth = getSearchDepth(difficulty);
  const isWhite = game.turn() === 'w';
  const moves = orderMoves(game);

  if (moves.length === 0) return null;

  // For beginner, add some randomness
  if (difficulty === 'beginner') {
    // Evaluate all moves but sometimes pick a suboptimal one
    const evaluated = moves.map(move => {
      game.move(move.san);
      const score = minimax(game, depth - 1, -Infinity, Infinity, !isWhite);
      game.undo();
      return { move: move.san, score };
    });

    evaluated.sort((a, b) => (isWhite ? b.score - a.score : a.score - b.score));

    // 40% chance to pick from top 3 instead of the best move
    const topN = Math.min(3, evaluated.length);
    if (Math.random() < 0.4 && topN > 1) {
      const idx = Math.floor(Math.random() * topN);
      return evaluated[idx].move;
    }
    return evaluated[0].move;
  }

  let bestMove: string | null = null;
  let bestEval = isWhite ? -Infinity : Infinity;

  for (const move of moves) {
    game.move(move.san);
    const evalScore = minimax(game, depth - 1, -Infinity, Infinity, !isWhite);
    game.undo();

    if (isWhite ? evalScore > bestEval : evalScore < bestEval) {
      bestEval = evalScore;
      bestMove = move.san;
    }
  }

  return bestMove;
}

// ---------------------------------------------------------------------------
// Artifact wrapper
// ---------------------------------------------------------------------------

function wrapWithArtifact(data: Record<string, unknown>): string {
  const json = JSON.stringify(data);
  const identifier = `chess-${Date.now()}`;
  return `<artifact identifier="${identifier}" type="application/vnd.ant.chess" title="Chess Game">\n${json}\n</artifact>`;
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function handleNewGame(): string {
  const game = new Chess();
  const data = {
    success: true,
    fen: game.fen(),
    turn: 'w',
    legalMoves: game.moves(),
    message: 'New game started. White to move.',
  };
  return wrapWithArtifact(data);
}

function handlePlayTurn(fen?: string, moveStr?: string, difficulty: Difficulty = 'intermediate'): string {
  if (!fen) return JSON.stringify({ success: false, error: 'FEN string is required.' });
  if (!moveStr) return JSON.stringify({ success: false, error: 'Move is required.' });

  const game = new Chess(fen);

  // 1. Apply the player's move
  let playerMove;
  try {
    playerMove = game.move(moveStr);
  } catch {
    return JSON.stringify({
      success: false,
      error: `Invalid move: "${moveStr}". Legal moves: ${game.moves().join(', ')}`,
      legalMoves: game.moves(),
    });
  }

  // 2. Check if game is over after the player's move
  if (game.isGameOver()) {
    const status = getGameStatusInfo(game);
    return wrapWithArtifact({
      success: true,
      fen: game.fen(),
      playerMove: {
        from: playerMove.from,
        to: playerMove.to,
        san: playerMove.san,
        piece: playerMove.piece,
        captured: playerMove.captured || null,
      },
      aiMove: null,
      turn: game.turn(),
      legalMoves: [],
      ...status,
    });
  }

  // 3. Compute and apply the AI's best response
  const bestMove = findBestMove(game, difficulty);
  if (!bestMove) {
    const status = getGameStatusInfo(game);
    return wrapWithArtifact({
      success: true,
      fen: game.fen(),
      playerMove: {
        from: playerMove.from,
        to: playerMove.to,
        san: playerMove.san,
        piece: playerMove.piece,
        captured: playerMove.captured || null,
      },
      aiMove: null,
      turn: game.turn(),
      legalMoves: game.moves(),
      ...status,
    });
  }

  const aiResult = game.move(bestMove);
  const status = getGameStatusInfo(game);

  return wrapWithArtifact({
    success: true,
    fen: game.fen(),
    move: {
      from: aiResult.from,
      to: aiResult.to,
      san: aiResult.san,
      piece: aiResult.piece,
      captured: aiResult.captured || null,
    },
    playerMove: {
      from: playerMove.from,
      to: playerMove.to,
      san: playerMove.san,
      piece: playerMove.piece,
      captured: playerMove.captured || null,
    },
    aiMove: {
      from: aiResult.from,
      to: aiResult.to,
      san: aiResult.san,
      piece: aiResult.piece,
      captured: aiResult.captured || null,
    },
    turn: game.turn(),
    legalMoves: game.moves(),
    ...status,
    moveNumber: game.moveNumber(),
  });
}

function handleGetLegalMoves(fen?: string): string {
  if (!fen) return JSON.stringify({ success: false, error: 'FEN string is required.' });
  const game = new Chess(fen);
  const verbose = game.moves({ verbose: true });
  return JSON.stringify({
    success: true,
    fen,
    turn: game.turn(),
    moves: game.moves(),
    verboseMoves: verbose.map((m: Move) => ({
      from: m.from,
      to: m.to,
      san: m.san,
      piece: m.piece,
      captured: m.captured || null,
    })),
    count: verbose.length,
  });
}

function handleEvaluatePosition(fen?: string): string {
  if (!fen) return JSON.stringify({ success: false, error: 'FEN string is required.' });
  const game = new Chess(fen);
  const score = evaluatePosition(game);
  const material = getMaterialCount(game);
  const status = getGameStatusInfo(game);

  // Convert centipawn score to a human-readable advantage
  let advantage: string;
  const absScore = Math.abs(score);
  if (absScore < 50) advantage = 'Equal position';
  else if (absScore < 150) advantage = `Slight ${score > 0 ? 'white' : 'black'} advantage`;
  else if (absScore < 300) advantage = `Clear ${score > 0 ? 'white' : 'black'} advantage`;
  else if (absScore < 900) advantage = `Winning ${score > 0 ? 'white' : 'black'} advantage`;
  else if (absScore < 99999) advantage = `Decisive ${score > 0 ? 'white' : 'black'} advantage`;
  else advantage = `${score > 0 ? 'White' : 'Black'} has checkmate`;

  return JSON.stringify({
    success: true,
    fen,
    evaluation: { score, advantage },
    material,
    ...status,
  });
}

function handleGetBestMove(fen?: string, difficulty: Difficulty = 'intermediate'): string {
  if (!fen) return JSON.stringify({ success: false, error: 'FEN string is required.' });
  const game = new Chess(fen);

  if (game.isGameOver()) {
    return JSON.stringify({ success: false, error: 'Game is already over.', ...getGameStatusInfo(game) });
  }

  const bestMove = findBestMove(game, difficulty);
  if (!bestMove) {
    return JSON.stringify({ success: false, error: 'No legal moves available.' });
  }

  // Apply the move to get resulting position info
  game.move(bestMove);
  const status = getGameStatusInfo(game);

  const data = {
    success: true,
    bestMove,
    fen: game.fen(),
    resultingFen: game.fen(),
    difficulty,
    turn: game.turn(),
    ...status,
  };
  return wrapWithArtifact(data);
}

function handleGetGameStatus(fen?: string): string {
  if (!fen) return JSON.stringify({ success: false, error: 'FEN string is required.' });
  const game = new Chess(fen);
  return JSON.stringify({
    success: true,
    fen,
    turn: game.turn(),
    legalMoves: game.moves(),
    ...getGameStatusInfo(game),
  });
}

function getGameStatusInfo(game: Chess): Record<string, unknown> {
  return {
    isCheck: game.isCheck(),
    isCheckmate: game.isCheckmate(),
    isDraw: game.isDraw(),
    isStalemate: game.isStalemate(),
    isThreefoldRepetition: game.isThreefoldRepetition(),
    isInsufficientMaterial: game.isInsufficientMaterial(),
    isGameOver: game.isGameOver(),
    moveNumber: game.moveNumber(),
  };
}

// ---------------------------------------------------------------------------
// Main tool function
// ---------------------------------------------------------------------------

const chessEngine = async (parameters?: ChessEngineParams): Promise<string> => {
  if (!parameters?.action) {
    throw new Error('Chess engine: Missing required "action" parameter.');
  }

  switch (parameters.action) {
    case 'new_game':
      return handleNewGame();
    case 'play_turn':
      return handlePlayTurn(parameters.fen, parameters.move, parameters.difficulty || 'intermediate');
    case 'get_legal_moves':
      return handleGetLegalMoves(parameters.fen);
    case 'evaluate_position':
      return handleEvaluatePosition(parameters.fen);
    case 'get_best_move':
      return handleGetBestMove(parameters.fen, parameters.difficulty || 'intermediate');
    case 'get_game_status':
      return handleGetGameStatus(parameters.fen);
    default:
      return JSON.stringify({ success: false, error: `Unknown action: "${parameters.action}"` });
  }
};

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const chessEngineTool: ToolDefinition = {
  name: 'chess_engine',
  implementation: () => ({
    toolFn: value => chessEngine(value as ChessEngineParams),
    toolSchema: {
      name: 'chess_engine',
      description:
        'A chess engine tool for managing chess games. Validates moves, evaluates positions, and suggests best moves. ' +
        'Use "new_game" to start a game. Use "play_turn" when the player makes a move — it applies the player\'s move, ' +
        "computes the AI's best response, applies it, and returns the resulting board position after BOTH moves. " +
        '"get_best_move" suggests a move, "evaluate_position" analyzes the board. ' +
        'All positions use FEN (Forsyth-Edwards Notation) and moves use SAN (Standard Algebraic Notation) e.g. "e4", "Nf3", "O-O".',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description:
              'The action to perform. "new_game" starts a fresh game. ' +
              '"play_turn" applies the player\'s move AND the AI\'s counter-move in one call — always use this for interactive games. ' +
              '"get_legal_moves" lists all legal moves. "evaluate_position" gives material and positional analysis. ' +
              '"get_best_move" suggests the best move at the given difficulty. "get_game_status" checks check/checkmate/draw.',
            enum: ['new_game', 'play_turn', 'get_legal_moves', 'evaluate_position', 'get_best_move', 'get_game_status'],
          },
          fen: {
            type: 'string',
            description:
              'FEN string representing the current board position. Required for all actions except "new_game". ' +
              'Example starting position: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"',
          },
          move: {
            type: 'string',
            description:
              'The player\'s move in SAN (Standard Algebraic Notation). Required for "play_turn". ' +
              'Examples: "e4", "Nf3", "Bxc6", "O-O" (kingside castle), "O-O-O" (queenside castle), "e8=Q" (promotion).',
          },
          difficulty: {
            type: 'string',
            description:
              'Difficulty level for "get_best_move". Controls search depth: beginner (depth 2, some randomness), ' +
              'intermediate (depth 3), advanced (depth 4). Defaults to "intermediate".',
            enum: ['beginner', 'intermediate', 'advanced'],
          },
        },
        required: ['action'],
      },
    },
  }),
};
