import { Chess, Move } from 'chess.js';

// Define the structure for a finalized move block
export interface MoveBlock {
  previousBlockHash: string;
  moveUCI: string; // This will be the constructed UCI string (e.g., 'e2e4')
  fenBeforeMove: string;
  fenAfterMove: string;
  timestamp: number;
  broadcasterPeerId: string;
  blockHash: string; // SHA256 hash of all above fields
  turn: number; // To easily track game progress and identify forks
}

export interface ChessJsVerboseMove extends Move {
  from: any // Square;
  to: any // Square;
  promotion?: any // PieceSymbol;
}

// Helper to calculate SHA256 hash
export async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hexHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hexHash;
}

export function convertMoveToUCI(move: ChessJsVerboseMove): string {
  let uci = move.from + move.to;
  if (move.promotion) {
    uci += move.promotion;
  }
  return uci;
}

export class ChessGame {
  private game: Chess;
  public moveHistory: MoveBlock[];
  public currentTurn: number;

  constructor(initialFen?: string) {
    this.game = new Chess(initialFen);
    this.moveHistory = [];
    this.currentTurn = 0;
  }

  public getFen(): string {
    return this.game.fen();
  }

  public getAsciiBoard(): string {
    return this.game.ascii();
  }

  public isGameOver(): boolean {
    return this.game.isGameOver();
  }

  public getTurnColor(): 'w' | 'b' {
    return this.game.turn();
  }

  public getPossibleMoves(verbose: boolean = false): (string | ChessJsVerboseMove)[] {
    return this.game.moves({ verbose }) as (string | ChessJsVerboseMove)[];
  }

  /**
   * Attempts to apply a move (UCI string) to a temporary game state for validation.
   * Does NOT modify the main game state.
   * @returns The resulting FEN if valid, null otherwise.
   */
  public validateMove(fenBefore: string, moveUCI: string): string | null {
    const tempGame = new Chess(fenBefore);
    try {
      const moveResult = tempGame.move(moveUCI);
      if (moveResult) {
        return tempGame.fen();
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Attempts to apply a move (UCI string) to the *current* game state.
   * This is typically used after a move has been finalized by consensus.
   * @returns The resulting FEN if valid, null otherwise.
   */
  public applyMove(moveUCI: string): string | null {
    try {
      const moveResult = this.game.move(moveUCI);
      if (moveResult) {
        return this.game.fen();
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Applies a finalized move block to the game history and state.
   * Includes chain validation.
   * @returns True if the block was successfully applied and the chain is valid, false otherwise.
   */
  public async applyFinalizedMoveBlock(incomingBlock: MoveBlock): Promise<boolean> {
    // 1. Basic Validation of incoming block (hash, chess move legality)
    const expectedBlockHash = await sha256(`${incomingBlock.previousBlockHash}_${incomingBlock.moveUCI}_${incomingBlock.fenBeforeMove}_${incomingBlock.fenAfterMove}_${incomingBlock.timestamp}_${incomingBlock.broadcasterPeerId}_${incomingBlock.turn}`);
    if (expectedBlockHash !== incomingBlock.blockHash) {
      console.warn(`Invalid block hash received: ${incomingBlock.blockHash} vs expected ${expectedBlockHash}`);
      return false;
    }

    const tempGameForBlockValidation = new Chess(incomingBlock.fenBeforeMove);
    try {
      const moveResult = tempGameForBlockValidation.move(incomingBlock.moveUCI);
      if (!moveResult || tempGameForBlockValidation.fen() !== incomingBlock.fenAfterMove) {
        console.warn(`Invalid chess move in block: ${incomingBlock.moveUCI}. FEN mismatch.`);
        return false;
      }
    } catch (e: any) {
      console.warn(`Illegal chess move in block: ${incomingBlock.moveUCI}. Error: ${e.message}`);
      return false;
    }

    // Find the index of the previous block in our local history
    let prevBlockIndex = -1;
    if (incomingBlock.previousBlockHash === 'GENESIS') {
      prevBlockIndex = -1; // Special case for genesis block
    } else {
      prevBlockIndex = this.moveHistory.findIndex(b => b.blockHash === incomingBlock.previousBlockHash);
    }

    // Construct the candidate history by taking our current history up to the common ancestor
    // and then appending the incoming block.
    let candidateHistory: MoveBlock[] = [];
    if (prevBlockIndex >= 0) {
      candidateHistory = this.moveHistory.slice(0, prevBlockIndex + 1);
    }
    candidateHistory.push(incomingBlock);

    // Validate the entire candidate chain from the beginning (or from the common ancestor)
    const tempGameForChainValidation = new Chess();
    let isValidChain = true;
    for (const block of candidateHistory) {
      if (tempGameForChainValidation.fen() !== block.fenBeforeMove) {
        console.warn(`Chain validation failed (FEN mismatch): Block ${block.blockHash.substring(0, 8)}... Expected: ${tempGameForChainValidation.fen()}, Got: ${block.fenBeforeMove}`);
        isValidChain = false;
        break;
      }
      const moveResult = tempGameForChainValidation.move(block.moveUCI);
      if (!moveResult || tempGameForChainValidation.fen() !== block.fenAfterMove) {
        console.warn(`Chain validation failed (Invalid move): Block ${block.blockHash.substring(0, 8)}... Move: ${block.moveUCI}, Result FEN: ${tempGameForChainValidation.fen()}, Expected FEN: ${block.fenAfterMove}`);
        isValidChain = false;
        break;
      }
    }

    if (!isValidChain) {
      return false;
    }

    // Decision Logic: Adopt the longest valid chain, with hash tie-breaker for equal length
    const currentHistoryLength = this.moveHistory.length;
    const candidateHistoryLength = candidateHistory.length;

    let shouldUpdate = false;
    if (candidateHistoryLength > currentHistoryLength) {
      shouldUpdate = true;
    } else if (candidateHistoryLength === currentHistoryLength) {
      if (currentHistoryLength > 0) {
        const lastIncomingBlockHash = incomingBlock.blockHash;
        const lastPrevBlockHash = this.moveHistory[this.moveHistory.length - 1].blockHash;

        if (lastIncomingBlockHash < lastPrevBlockHash) {
          shouldUpdate = true;
        }
      } else if (incomingBlock.previousBlockHash === 'GENESIS' && currentHistoryLength === 0) {
        shouldUpdate = true;
      }
    }

    if (shouldUpdate) {
      this.moveHistory = candidateHistory;
      this.game = tempGameForChainValidation; // Update the main game state
      this.currentTurn = this.moveHistory.length;
      return true;
    }
    return false;
  }

  /**
   * Replaces the entire game history with a new one.
   * This is typically used after receiving a full history response from another peer.
   * Performs full chain validation before adoption.
   * @returns True if the history was adopted, false otherwise.
   */
  public async setFullHistory(newHistory: MoveBlock[]): Promise<boolean> {
    if (newHistory.length === 0) {
      // If new history is empty, maybe reset the game
      this.game = new Chess();
      this.moveHistory = [];
      this.currentTurn = 0;
      return true;
    }

    const tempGame = new Chess();
    let isValidChain = true;
    for (const block of newHistory) {
      const expectedBlockHash = await sha256(`${block.previousBlockHash}_${block.moveUCI}_${block.fenBeforeMove}_${block.fenAfterMove}_${block.timestamp}_${block.broadcasterPeerId}_${block.turn}`);
      if (expectedBlockHash !== block.blockHash) {
        console.warn(`Invalid block hash in received full history for turn ${block.turn}.`);
        isValidChain = false;
        break;
      }
      if (tempGame.fen() !== block.fenBeforeMove) {
        console.warn(`FEN mismatch in received full history for turn ${block.turn}.`);
        isValidChain = false;
        break;
      }
      const moveResult = tempGame.move(block.moveUCI);
      if (!moveResult || tempGame.fen() !== block.fenAfterMove) {
        isValidChain = false;
        console.warn(`Invalid move in received full history for turn ${block.turn}.`);
        break;
      }
    }

    if (!isValidChain) {
      console.warn(`Received full history is invalid. Ignoring.`);
      return false;
    }

    // Adopt the longest valid chain, or apply tie-breaker
    if (newHistory.length > this.moveHistory.length) {
      this.game = tempGame;
      this.moveHistory = newHistory;
      this.currentTurn = newHistory.length;
      return true;
    } else if (newHistory.length === this.moveHistory.length && newHistory.length > 0) {
      const lastIncomingBlockHash = newHistory[newHistory.length - 1].blockHash;
      const lastPrevBlockHash = this.moveHistory[this.moveHistory.length - 1].blockHash;

      if (lastIncomingBlockHash < lastPrevBlockHash) {
        this.game = tempGame;
        this.moveHistory = newHistory;
        this.currentTurn = newHistory.length;
        return true;
      }
    }
    return false;
  }
}
