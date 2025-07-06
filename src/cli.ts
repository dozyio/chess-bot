// src/cli.ts
import { ChessGame, P2PChessNode, convertMoveToUCI, sha256 } from './lib/index.js';
import type { ProposalMessage, FinalizedMoveMessage, HistoryRequestMessage, HistoryResponseMessage, CurrentStateMessage, MoveBlock, ChessJsVerboseMove} from './lib/index.js'

// --- Global State Variables ---
let chessGame: ChessGame | null = null;
let p2pNode: P2PChessNode | null = null;
let currentVotes: Map<string, number> = new Map();
let isVotingActive: boolean = false;
let votingTimer: NodeJS.Timeout | null = null;

// Add a game message to the CLI output
function addGameMessage(message: string) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// --- P2P Callbacks ---
const p2pCallbacks = {
  onPeerConnected: async (peerId: string) => {
    addGameMessage(`Connected to peer: ${peerId}`);
    // When connected to a new peer, request history if we are a new peer ourselves or want to sync
    if (chessGame && chessGame.moveHistory.length === 0 && p2pNode) {
      addGameMessage(`Requesting game history from new peer: ${peerId}`);
      await p2pNode.publishMessage({ type: 'history_request', requesterId: p2pNode.peerId } as HistoryRequestMessage);
    }
  },
  onPeerDisconnected: (peerId: string) => {
    addGameMessage(`Disconnected from peer: ${peerId}`);
  },
  onMessageReceived: async (message: any, fromPeer: string) => {
    if (!chessGame || !p2pNode) return;

    switch (message.type) {
      case 'proposal':
        await handleProposal(message as ProposalMessage, fromPeer);
        break;
      case 'finalized_move':
        await handleFinalizedMove(message as FinalizedMoveMessage, fromPeer);
        break;
      case 'history_request':
        await handleHistoryRequest(message as HistoryRequestMessage, fromPeer);
        break;
      case 'history_response':
        await handleFullHistory(message as HistoryResponseMessage, fromPeer);
        break;
      case 'current_state':
        // For now, we rely on full history for trust, but can log for debugging
        // addGameMessage(`Received current state from ${fromPeer}: ${message.fen}`);
        break;
      default:
        addGameMessage(`Received unknown message type: ${message.type} from ${fromPeer}`);
    }
  },
  onLog: addGameMessage, // Use the existing addGameMessage for logging
};

// --- Core Game Logic Functions (adapted to use ChessGame) ---

async function handleProposal(proposal: ProposalMessage, fromPeer: string) {
  if (!chessGame || !isVotingActive) {
    addGameMessage(`Ignoring proposal from ${fromPeer} for move ${proposal.move}: Game not initialized or not in active voting period.`);
    return;
  }
  if (proposal.turn !== chessGame.currentTurn) {
    addGameMessage(`Ignoring proposal from ${fromPeer} for move ${proposal.move}: Proposal turn (${proposal.turn}) does not match current voting turn (${chessGame.currentTurn}).`);
    return;
  }

  const newFen = chessGame.validateMove(chessGame.getFen(), proposal.move);
  if (newFen) {
    currentVotes.set(proposal.move, (currentVotes.get(proposal.move) || 0) + 1);
    addGameMessage(`Vote received for ${proposal.move} from ${fromPeer}. Total votes for ${proposal.move}: ${currentVotes.get(proposal.move)}`);
  } else {
    addGameMessage(`Invalid move proposal ignored from ${fromPeer}: ${proposal.move} (Chess validation failed). Current FEN: ${chessGame.getFen()}`);
  }
}

async function finalizeMove() {
  isVotingActive = false;
  if (votingTimer) clearTimeout(votingTimer);

  addGameMessage(`Current votes before finalization for turn ${chessGame?.currentTurn}:`);
  currentVotes.forEach((count, move) => {
    addGameMessage(`  - ${move}: ${count} votes`);
  });

  if (currentVotes.size === 0) {
    addGameMessage('No valid votes received. Skipping turn. (Local decision)');
    if (chessGame) {
      chessGame.currentTurn++; // Advance turn even if no move
    }
    currentVotes = new Map();
    startVotingPeriod();
    return;
  }

  let winningMoveUCI: string | null = null;
  let maxVotes = 0;
  let tiedMoves: string[] = [];

  for (const [moveUCI, count] of currentVotes.entries()) {
    if (count > maxVotes) {
      maxVotes = count;
      winningMoveUCI = moveUCI;
      tiedMoves = [moveUCI];
    } else if (count === maxVotes) {
      tiedMoves.push(moveUCI);
    }
  }

  if (tiedMoves.length > 1) {
    addGameMessage(`Tie detected with ${maxVotes} votes for: ${tiedMoves.join(', ')}. Applying hash tie-breaker for move selection.`);
    let lowestHash = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    let resolvedMoveUCI: string | null = null;

    for (const moveUCI of tiedMoves) {
      const combinedString = `${chessGame?.getFen()}_${moveUCI}`;
      const moveHash = await sha256(combinedString);
      if (moveHash < lowestHash) {
        lowestHash = moveHash;
        resolvedMoveUCI = moveUCI;
      }
    }
    winningMoveUCI = resolvedMoveUCI;
    addGameMessage(`Tie resolved for move selection. Winning move: ${winningMoveUCI} (Hash: ${lowestHash.substring(0, 8)}...)`);
  }

  if (winningMoveUCI && chessGame && p2pNode) {
    const fenBeforeMove = chessGame.getFen();
    const newFen = chessGame.validateMove(fenBeforeMove, winningMoveUCI);

    if (newFen) {
      const previousBlockHash = chessGame.moveHistory.length > 0 ? chessGame.moveHistory[chessGame.moveHistory.length - 1].blockHash : 'GENESIS';
      const timestamp = Date.now();
      const currentTurn = chessGame.currentTurn;

      const blockContent = `${previousBlockHash}_${winningMoveUCI}_${fenBeforeMove}_${newFen}_${timestamp}_${p2pNode.peerId}_${currentTurn}`;
      const blockHash = await sha256(blockContent);

      const newMoveBlock: MoveBlock = {
        previousBlockHash,
        moveUCI: winningMoveUCI,
        fenBeforeMove,
        fenAfterMove: newFen,
        timestamp,
        broadcasterPeerId: p2pNode.peerId,
        blockHash,
        turn: currentTurn,
      };

      addGameMessage(`Broadcasting our proposed finalized block for turn ${newMoveBlock.turn}: ${newMoveBlock.moveUCI} (Hash: ${newMoveBlock.blockHash.substring(0, 8)}...)`);
      await p2pNode.publishMessage({ type: 'finalized_move', ...newMoveBlock } as FinalizedMoveMessage);
    } else {
      addGameMessage(`Error: Determined winning move ${winningMoveUCI} is invalid during finalization. Skipping turn. (Local decision)`);
      chessGame.currentTurn++;
      currentVotes = new Map();
      startVotingPeriod();
    }
  } else {
    addGameMessage('No winning move determined after voting or node/game not ready. Skipping turn. (Local decision)');
    if (chessGame) {
      chessGame.currentTurn++;
    }
    currentVotes = new Map();
    startVotingPeriod();
  }
}

async function handleFinalizedMove(incomingBlockMessage: FinalizedMoveMessage, fromPeer: string) {
  if (!chessGame) return;

  const didUpdate = await chessGame.applyFinalizedMoveBlock(incomingBlockMessage);

  if (didUpdate) {
    addGameMessage(`Game state updated to turn ${chessGame.currentTurn}. New FEN: ${chessGame.getFen()} (from peer ${fromPeer})`);
    console.log(chessGame.getAsciiBoard());
    currentVotes = new Map(); // Clear votes for next round
    startVotingPeriod(); // Start new voting period after state update
  } else {
    addGameMessage(`Ignoring finalized block from ${fromPeer} for turn ${incomingBlockMessage.turn}: Chain validation failed or shorter chain.`);
  }
}

async function handleHistoryRequest(request: HistoryRequestMessage, fromPeer: string) {
  if (!p2pNode || !chessGame || fromPeer === p2pNode.peerId) return;

  addGameMessage(`Received history request from ${fromPeer}. Sending our history.`);
  await p2pNode.publishMessage({ type: 'history_response', history: chessGame.moveHistory } as HistoryResponseMessage);
}

async function handleFullHistory(incomingMessage: HistoryResponseMessage, fromPeer: string) {
  if (!chessGame || !p2pNode || incomingMessage.history.length === 0) return;

  const didUpdate = await chessGame.setFullHistory(incomingMessage.history);

  if (didUpdate) {
    addGameMessage(`Adopted full history from ${fromPeer} (length ${chessGame.moveHistory.length}).`);
    console.log(chessGame.getAsciiBoard());
    currentVotes = new Map();
    startVotingPeriod();
  } else {
    addGameMessage(`Ignoring full history from ${fromPeer}: Invalid chain or shorter/equal chain with higher hash.`);
  }
}

async function botProposeMove() {
  if (!chessGame || !p2pNode || !isVotingActive || chessGame.isGameOver()) {
    addGameMessage(`Bot not proposing: P2P node ready=${!!p2pNode}, Voting active=${isVotingActive}, Game Over=${chessGame?.isGameOver()}`);
    return;
  }

  const possibleMoves = chessGame.getPossibleMoves(true) as ChessJsVerboseMove[];
  if (possibleMoves.length === 0) {
    addGameMessage('Bot: No possible moves.');
    return;
  }

  const randomMove = possibleMoves[Math.floor(Math.random() * possibleMoves.length)];
  const randomMoveUCI = convertMoveToUCI(randomMove);

  const proposalPayload: ProposalMessage = { type: 'proposal', move: randomMoveUCI, turn: chessGame.currentTurn };

  addGameMessage(`Bot proposing move: ${randomMoveUCI} for turn ${chessGame.currentTurn}`);
  await p2pNode.publishMessage(proposalPayload);
}

function startVotingPeriod() {
  if (votingTimer) clearTimeout(votingTimer);
  currentVotes = new Map();
  isVotingActive = true;
  if (!chessGame) {
    addGameMessage(`no chessGame, skipping vote`)
    return
  }
  addGameMessage(`Voting for turn ${chessGame?.currentTurn + 1} (${chessGame?.getTurnColor() === 'w' ? 'White' : 'Black'}) started. 5 seconds... Current local turn: ${chessGame?.currentTurn}`);

  setTimeout(() => {
    botProposeMove();
  }, 250);

  votingTimer = setTimeout(() => {
    addGameMessage('Voting period ended. Finalizing move...');
    finalizeMove();
  }, 5000); // 5 seconds voting period
}

async function main() {
  addGameMessage('Initializing Chess game...');
  chessGame = new ChessGame();
  addGameMessage('Chess game initialized.');
  console.log(chessGame.getAsciiBoard());

  p2pNode = new P2PChessNode(p2pCallbacks);
  try {
    await p2pNode.start();

    // Initial game start
    if (chessGame.currentTurn === 0 && chessGame.moveHistory.length === 0) {
      addGameMessage('Starting first voting period...');
      startVotingPeriod();
    }

    // Periodically broadcast current FEN (for general awareness, not critical for trust)
    setInterval(async () => {
      if (chessGame && p2pNode && p2pNode.peerId) {
        await p2pNode.publishMessage({ type: 'current_state', fen: chessGame.getFen(), turn: chessGame.currentTurn } as CurrentStateMessage);
      }
    }, 10000);

  } catch (error: any) {
    console.error('Failed to start P2P node:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  addGameMessage('Received SIGINT. Shutting down...');
  if (p2pNode) {
    await p2pNode.stop();
  }
  if (votingTimer) clearTimeout(votingTimer);
  process.exit(0);
});

// Start the main application
main();
