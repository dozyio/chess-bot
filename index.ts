import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { Chess, Move } from 'chess.js'; // Added Square and PieceSymbol
// import { Chess, Move, Square, PieceSymbol } from 'chess.js'; // Added Square and PieceSymbol
import * as filters from "@libp2p/websockets/filters";
import { bootstrap } from "@libp2p/bootstrap";
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { createPeerScoreParams, createTopicScoreParams } from '@chainsafe/libp2p-gossipsub/score';
import { identify, identifyPush } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
import { webRTC } from "@libp2p/webrtc";
import { yamux } from "@chainsafe/libp2p-yamux";
import { ping } from '@libp2p/ping';

import { stdin, stdout } from 'process'; // For graceful shutdown

// Define the structure for a finalized move block
interface MoveBlock {
    previousBlockHash: string;
    moveUCI: string; // This will be the constructed UCI string (e.g., 'e2e4')
    fenBeforeMove: string;
    fenAfterMove: string;
    timestamp: number;
    broadcasterPeerId: string;
    blockHash: string; // SHA256 hash of all above fields
    turn: number; // To easily track game progress and identify forks
}

// Define common message types for the single topic
interface BaseMessage {
    type: string;
}

interface ProposalMessage extends BaseMessage {
    type: 'proposal';
    move: string; // This will now be the constructed UCI string
    turn: number;
}

interface FinalizedMoveMessage extends BaseMessage, MoveBlock {
    type: 'finalized_move';
    // All MoveBlock properties are inherited here
}

interface HistoryRequestMessage extends BaseMessage {
    type: 'history_request';
    requesterId: string;
}

interface HistoryResponseMessage extends BaseMessage {
    type: 'history_response';
    history: MoveBlock[];
}

interface CurrentStateMessage extends BaseMessage {
    type: 'current_state';
    fen: string;
    turn: number;
}

// The 'Move' type from chess.js already has 'from', 'to', 'promotion' when verbose is true.
// We just need to ensure we're accessing them correctly.
// No separate VerboseMove interface is strictly needed if we cast to 'any' or check properties.
// However, for clarity and type safety, let's define an interface that matches what
// game.moves({ verbose: true }) actually returns, including 'from', 'to', 'promotion'.
interface ChessJsVerboseMove extends Move {
    from: any // Square; // Changed from string to Square
    to: any // Square;   // Changed from string to Square
    promotion?: any // PieceSymbol; // Changed from string to PieceSymbol, kept optional
    // Other properties like color, piece, san, flags, etc., are also present
}

const bootstrapMultiaddrs = [
  "/dns4/r1.dozy.io/tcp/443/tls/ws/p2p/12D3KooWHEXu2JRgq7BKa7x4ahmjhiG5XZ2bUHF1Dcy56ueCXw48",
  "/dns4/r2.dozy.io/tcp/443/tls/ws/p2p/12D3KooWLnnFfJxesZZN4wWKNxAudd9atnBnvWPhxg2LTWigExPP",
]


// Helper to calculate SHA256 hash
async function sha256(message: string): Promise<string> {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hexHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hexHash;
}

// --- Global State Variables ---
let libp2pNode = null;
let peerId: string = '';
let connectedPeers: Set<string> = new Set();
let game: Chess| null = null;
let fen: string = '';
let moveHistory: MoveBlock[] = [];
let currentVotes: Map<string, number> = new Map();
let isVotingActive: boolean = false;
let currentTurn: number = 0;
let votingTimer: NodeJS.Timeout | null = null;
let currentMoveBlock: MoveBlock | null = null; // To store the last finalized block for new turns

// Single Gossipsub topic name
const MAIN_TOPIC = 'pubXXX-dev';

// Add a game message to the CLI output
function addGameMessage(message: string) {
    console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// --- Core Game Logic Functions ---

// Function to handle incoming move proposals
async function handleProposal(proposal: ProposalMessage, fromPeer: string) {
    // Ensure we only process the proposal payload, not the 'type' field
    const { move, turn } = proposal;

    if (!game || !isVotingActive || turn !== currentTurn || fromPeer === peerId) {
        console.log('ignoring proposal', isVotingActive, turn, currentTurn, fromPeer)
        return; // Ignore if not in voting phase, wrong turn, or self-proposal
    }

    // Validate the move using chess.js
    const tempGame = new Chess(fen); // Use current FEN to validate
    try {
        // The 'move' in proposal is now expected to be a UCI string
        const moveResult = tempGame.move(move, { strict: true });
        if (moveResult) {
            currentVotes.set(move, (currentVotes.get(move) || 0) + 1);
            addGameMessage(`Vote received for ${move} from ${fromPeer}. Total votes: ${currentVotes.get(move) || 1}`);
        } else {
            addGameMessage(`Invalid move proposal ignored from ${fromPeer}: ${move}`);
        }
    } catch (e: any) {
        addGameMessage(`Invalid move proposal ignored from ${fromPeer}: ${move} (Error: ${e.message})`);
    }
}

// Function to determine the winning move and finalize the block
async function finalizeMove() {
    isVotingActive = false;
    if (votingTimer) clearTimeout(votingTimer);

    if (currentVotes.size === 0) {
        addGameMessage('No valid votes received. Skipping turn.');
        currentTurn++;
        currentVotes = new Map(); // Clear votes for next round
        startVotingPeriod();
        return;
    }

    let winningMoveUCI: string | null = null; // Renamed to clarify it's UCI
    let maxVotes = 0;
    let tiedMoves: string[] = []; // These are UCI strings

    // Find max votes and identify ties
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
        // Apply deterministic hash-based tie-breaker
        addGameMessage(`Tie detected with ${maxVotes} votes for: ${tiedMoves.join(', ')}. Applying hash tie-breaker.`);
        let lowestHash = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'; // Max possible hash value
        let resolvedMoveUCI: string | null = null;

        for (const moveUCI of tiedMoves) {
            const combinedString = `${fen}_${moveUCI}`;
            const moveHash = await sha256(combinedString);
            if (moveHash < lowestHash) {
                lowestHash = moveHash;
                resolvedMoveUCI = moveUCI;
            }
        }
        winningMoveUCI = resolvedMoveUCI;
        addGameMessage(`Tie resolved. Winning move: ${winningMoveUCI} (Hash: ${lowestHash.substring(0, 8)}...)`);
    }

    if (winningMoveUCI && game) {
        const tempGame = new Chess(fen);
        // Use the winningMoveUCI directly
        const moveResult = tempGame.move(winningMoveUCI, { strict: true });

        if (moveResult) {
            const newFen = tempGame.fen();
            const previousBlockHash = moveHistory.length > 0 ? moveHistory[moveHistory.length - 1].blockHash : 'GENESIS';
            const timestamp = Date.now();

            const blockContent = `${previousBlockHash}_${winningMoveUCI}_${fen}_${newFen}_${timestamp}_${peerId}_${currentTurn}`;
            const blockHash = await sha256(blockContent);

            const newMoveBlock: MoveBlock = {
                previousBlockHash,
                moveUCI: winningMoveUCI,
                fenBeforeMove: fen,
                fenAfterMove: newFen,
                timestamp,
                broadcasterPeerId: peerId,
                blockHash,
                turn: currentTurn,
            };
            currentMoveBlock = newMoveBlock; // Store for immediate use by self

            addGameMessage(`Finalizing move: ${winningMoveUCI}. Broadcasting block ${newMoveBlock.blockHash.substring(0, 8)}...`);
            if (libp2pNode) {
                // Publish with the 'finalized_move' type
                await libp2pNode.services.pubsub.publish(MAIN_TOPIC, new TextEncoder().encode(JSON.stringify({ type: 'finalized_move', ...newMoveBlock } as FinalizedMoveMessage)));
            }
        } else {
            addGameMessage(`Error: Determined winning move ${winningMoveUCI} is invalid. This should not happen.`);
            currentTurn++;
            currentVotes = new Map();
            startVotingPeriod();
        }
    } else {
        addGameMessage('No winning move determined after voting. Skipping turn.');
        currentTurn++;
        currentVotes = new Map();
        startVotingPeriod();
    }
}

// Function to handle incoming finalized move blocks
async function handleFinalizedMove(incomingBlockMessage: FinalizedMoveMessage, fromPeer: string) {
    if (!game || !peerId) return;

    // Destructure the actual MoveBlock from the message
    const incomingBlock: MoveBlock = incomingBlockMessage;

    // 1. Basic Validation of incoming block
    const expectedBlockHash = await sha256(`${incomingBlock.previousBlockHash}_${incomingBlock.moveUCI}_${incomingBlock.fenBeforeMove}_${incomingBlock.fenAfterMove}_${incomingBlock.timestamp}_${incomingBlock.broadcasterPeerId}_${incomingBlock.turn}`);
    if (expectedBlockHash !== incomingBlock.blockHash) {
        addGameMessage(`Received invalid block hash from ${fromPeer} for turn ${incomingBlock.turn}. Ignoring.`);
        return;
    }

    // 2. Validate move using chess.js
    const tempGame = new Chess(incomingBlock.fenBeforeMove);
    try {
        // Use the incomingBlock.moveUCI directly
        const moveResult = tempGame.move(incomingBlock.moveUCI, { strict: true });
        if (!moveResult || tempGame.fen() !== incomingBlock.fenAfterMove) {
            addGameMessage(`Received block with invalid chess move from ${fromPeer} for turn ${incomingBlock.turn}. Ignoring.`);
            return;
        }
    } catch (e: any) {
        addGameMessage(`Received block with illegal chess move from ${fromPeer} for turn ${incomingBlock.turn}. Ignoring. Error: ${e.message}`);
        return;
    }

    // 3. Fork Resolution (Longest Valid Chain & Hash Tie-breaker)
    let newHistory = [...moveHistory];

    // Case 1: Incoming block extends our current canonical chain
    const lastLocalBlock = newHistory.length > 0 ? newHistory[newHistory.length - 1] : null;

    // Check if the incoming block is for the current expected turn and extends the current chain
    if (incomingBlock.previousBlockHash === (lastLocalBlock?.blockHash || 'GENESIS') && incomingBlock.turn === currentTurn) {
        if (currentMoveBlock && currentMoveBlock.blockHash === incomingBlock.blockHash) {
            // This is our own block that we just broadcasted, accept it.
            addGameMessage(`Accepted our own finalized move for turn ${incomingBlock.turn}: ${incomingBlock.moveUCI}`);
            newHistory.push(incomingBlock);
        } else if (lastLocalBlock && incomingBlock.blockHash === lastLocalBlock.blockHash) {
            // This is a duplicate of the last block we already have. Ignore.
            return;
        } else if (lastLocalBlock && incomingBlock.previousBlockHash === lastLocalBlock.blockHash) {
            // This is a new block extending our chain. Accept it.
            addGameMessage(`Accepted finalized move for turn ${incomingBlock.turn} from ${fromPeer}: ${incomingBlock.moveUCI}`);
            newHistory.push(incomingBlock);
        } else if (incomingBlock.turn === currentTurn && incomingBlock.previousBlockHash === (lastLocalBlock?.blockHash || 'GENESIS')) {
            // This is a competing block for the current turn (a fork of equal length)
            // Apply hash tie-breaker
            if (!currentMoveBlock || incomingBlock.blockHash < currentMoveBlock.blockHash) {
                addGameMessage(`Fork detected for turn ${incomingBlock.turn}. Preferring block ${incomingBlock.blockHash.substring(0, 8)}... from ${fromPeer} over current.`);
                newHistory.pop(); // Remove our current block for this turn
                newHistory.push(incomingBlock);
                currentMoveBlock = incomingBlock; // Update our reference
            } else {
                addGameMessage(`Fork detected for turn ${incomingBlock.turn}. Keeping current block over ${incomingBlock.blockHash.substring(0, 8)}... from ${fromPeer}.`);
                return; // Keep current history
            }
        }
    } else if (incomingBlock.turn > currentTurn) {
        // Case 2: Incoming block is for a future turn, implying we are behind or on a shorter chain
        // We need to request full history or check if this block can extend a known shorter chain
        addGameMessage(`Received future block for turn ${incomingBlock.turn} from ${fromPeer}. Requesting full history to sync.`);
        if (libp2pNode) {
            // Publish with the 'history_request' type
            await libp2pNode.services.pubsub.publish(MAIN_TOPIC, new TextEncoder().encode(JSON.stringify({ type: 'history_request', requesterId: peerId } as HistoryRequestMessage)));
        }
        return; // Don't update yet, wait for full history
    } else if (incomingBlock.turn < currentTurn) {
        // Case 3: Incoming block is for a past turn, ignore (already processed)
        // addGameMessage(`Received old block for turn ${incomingBlock.turn} from ${fromPeer}. Ignoring.`);
        return;
    }

    // Update local game state if newHistory has changed
    if (newHistory.length !== moveHistory.length || (newHistory.length > 0 && newHistory[newHistory.length - 1].blockHash !== moveHistory[moveHistory.length - 1]?.blockHash)) {
        const tempGame = new Chess();
        let isValidChain = true;
        for (const block of newHistory) {
            if (tempGame.fen() !== block.fenBeforeMove) {
                isValidChain = false;
                addGameMessage(`Chain validation failed: FEN mismatch for block ${block.blockHash.substring(0, 8)}...`);
                break;
            }
            const moveResult = tempGame.move(block.moveUCI, { strict: true });
            if (!moveResult || tempGame.fen() !== block.fenAfterMove) {
                isValidChain = false;
                addGameMessage(`Chain validation failed: Invalid move in block ${block.blockHash.substring(0, 8)}...`);
                break;
            }
        }

        if (isValidChain) {
            game = tempGame;
            fen = tempGame.fen();
            moveHistory = newHistory;
            currentTurn = newHistory.length; // Turn number is history length (0-indexed)
            currentVotes = new Map(); // Clear votes for next round
            addGameMessage(`Game state updated to turn ${currentTurn}. New FEN: ${game.fen()}`);
            console.log(game.ascii()); // Print board to console
            startVotingPeriod(); // Start new voting period after state update
        } else {
            addGameMessage('Received history is invalid, reverting to previous state.');
            // Revert to previous state if the new chain is invalid
        }
    }
}

// Function to handle history requests
async function handleHistoryRequest(request: HistoryRequestMessage, fromPeer: string) {
    if (!libp2pNode || fromPeer === peerId) return;

    addGameMessage(`Received history request from ${fromPeer}. Sending our history.`);
    // Send history as a single message (or multiple if too large)
    // For simplicity, sending the whole array as a 'history_response' type message
    await libp2pNode.services.pubsub.publish(MAIN_TOPIC, new TextEncoder().encode(JSON.stringify({ type: 'history_response', history: moveHistory } as HistoryResponseMessage)));
}

// Function to handle incoming full history (for new peers or sync)
async function handleFullHistory(incomingMessage: HistoryResponseMessage, fromPeer: string) {
    if (!game || !peerId || incomingMessage.type !== 'history_response' || incomingMessage.history.length === 0) return;

    const incomingFullHistory = incomingMessage.history;

    // Validate each block in the incoming history
    const tempGame = new Chess();
    let isValidChain = true;
    for (const block of incomingFullHistory) {
        const expectedBlockHash = await sha256(`${block.previousBlockHash}_${block.moveUCI}_${block.fenBeforeMove}_${block.fenAfterMove}_${block.timestamp}_${block.broadcasterPeerId}_${block.turn}`);
        if (expectedBlockHash !== block.blockHash) {
            addGameMessage(`Invalid block hash in received history from ${fromPeer} for turn ${block.turn}.`);
            isValidChain = false;
            break;
        }
        if (tempGame.fen() !== block.fenBeforeMove) {
            addGameMessage(`FEN mismatch in received history from ${fromPeer} for turn ${block.turn}.`);
            isValidChain = false;
            break;
        }
        const moveResult = tempGame.move(block.moveUCI, { strict: true });
        if (!moveResult || tempGame.fen() !== block.fenAfterMove) {
            isValidChain = false;
            addGameMessage(`Invalid move in received history from ${fromPeer} for turn ${block.turn}.`);
            break;
        }
    }

    if (!isValidChain) {
        addGameMessage(`Received history from ${fromPeer} is invalid. Ignoring.`);
        return;
    }

    // Adopt the longest valid chain
    if (incomingFullHistory.length > moveHistory.length) {
        addGameMessage(`Adopting longer valid history from ${fromPeer} (length ${incomingFullHistory.length} vs ${moveHistory.length}).`);
        game = tempGame; // Apply the new game state
        fen = tempGame.fen();
        moveHistory = incomingFullHistory;
        currentTurn = incomingFullHistory.length;
        currentVotes = new Map();
        console.log(game.ascii()); // Print board to console
        startVotingPeriod(); // Start new voting period after syncing
    } else if (incomingFullHistory.length === moveHistory.length && incomingFullHistory.length > 0) {
        // Tie-breaker for equal length chains: choose based on the last block's hash
        const lastIncomingBlockHash = incomingFullHistory[incomingFullHistory.length - 1].blockHash;
        const lastPrevBlockHash = moveHistory[moveHistory.length - 1].blockHash;

        if (lastIncomingBlockHash < lastPrevBlockHash) {
            addGameMessage(`Adopting equally long history from ${fromPeer} due to lower hash.`);
            game = tempGame;
            fen = tempGame.fen();
            moveHistory = incomingFullHistory;
            currentTurn = incomingFullHistory.length;
            currentVotes = new Map();
            console.log(game.ascii()); // Print board to console
            startVotingPeriod();
        }
    }
}

// Helper function to convert a verbose chess.js move object to UCI string
function convertMoveToUCI(move: ChessJsVerboseMove): string {
    let uci = move.from + move.to;
    if (move.promotion) {
        uci += move.promotion;
    }
    return uci;
}

// Bot logic to propose a random valid move
async function botProposeMove() {
    if (!game || !libp2pNode || !isVotingActive || game.isGameOver()) return;

    // game.moves({ verbose: true }) returns an array of Move objects with 'from', 'to', 'promotion' etc.
    const possibleMoves = game.moves({ verbose: true }) as ChessJsVerboseMove[];
    if (possibleMoves.length === 0) {
        addGameMessage('Bot: No possible moves.');
        return;
    }

    const randomMove = possibleMoves[Math.floor(Math.random() * possibleMoves.length)];
    const randomMoveUCI = convertMoveToUCI(randomMove); // Convert to UCI string

    const proposalPayload: ProposalMessage = { type: 'proposal', move: randomMoveUCI, turn: currentTurn };

    addGameMessage(`Bot proposing move: ${randomMoveUCI}`);
    await libp2pNode.services.pubsub.publish(MAIN_TOPIC, new TextEncoder().encode(JSON.stringify(proposalPayload)));
}

// Start the voting period
function startVotingPeriod() {
    if (votingTimer) clearTimeout(votingTimer);
    currentVotes = new Map(); // Clear votes for the new round
    isVotingActive = true;
    addGameMessage(`Voting for turn ${currentTurn + 1} (${game?.turn() === 'w' ? 'White' : 'Black'}) started. 5 seconds...`);

    // Bot proposes a move immediately
    botProposeMove();

    votingTimer = setTimeout(() => {
        addGameMessage('Voting period ended. Finalizing move...');
        finalizeMove();
    }, 5000); // 5 seconds voting period
}

// --- Initialization and Main Execution ---

function passthroughMapper(info) {
    return info
}

function applicationScore (p: string) {
    if (p === '12D3KooWLnnFfJxesZZN4wWKNxAudd9atnBnvWPhxg2LTWigExPP' || p ==='12D3KooWHEXu2JRgq7BKa7x4ahmjhiG5XZ2bUHF1Dcy56ueCXw48') {
      return 1200
    }

    return 0
  }

async function main() {
    addGameMessage('Initializing Chess game...');
    game = new Chess();
    fen = game.fen();
    addGameMessage('Chess game initialized.');
    console.log(game.ascii()); // Initial board state

    addGameMessage('Initializing libp2p node...');
    try {
    const node = await createLibp2p({
      addresses: {
        listen: [
          '/p2p-circuit',
          `/webrtc`
        ]
      },
      peerDiscovery: [
        bootstrap({
          list: bootstrapMultiaddrs,
        })
      ],
      transports: [
        webSockets({
          filter: filters.all,
        }),
        webRTC(),
        circuitRelayTransport({ }),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        identifyPush: identifyPush(),
        ping: ping(),
        dht: kadDHT({
          protocol: `/pubxxx-dev/kad/1.0.0`,
          kBucketSize: 20,
          peerInfoMapper: passthroughMapper,
          clientMode: false,
        }),
        pubsub: gossipsub({
          D: 8,
          Dlo: 6,
          Dhi: 12,
          Dout: 2,
          doPX: false,
          emitSelf: false,
          globalSignaturePolicy: 'StrictSign',
          allowPublishToZeroTopicPeers: true,
          pruneBackoff: 60 * 1000,
          scoreParams: createPeerScoreParams({
            // P5
            appSpecificScore: applicationScore,

            // P6
            IPColocationFactorWeight: 0,
            IPColocationFactorThreshold: 0,
            IPColocationFactorWhitelist: new Set<string>(),

            // P7
            behaviourPenaltyWeight: 0,
            behaviourPenaltyThreshold: 0,
            behaviourPenaltyDecay: 0,

            topicScoreCap: 50,

            topics: {
                [MAIN_TOPIC]: createTopicScoreParams({ // Use MAIN_TOPIC here
                    topicWeight: 1,

                    // P1
                    timeInMeshWeight: 0.1,
                    timeInMeshQuantum: 1 * 1000,
                    timeInMeshCap: 3,

                    // P2
                    firstMessageDeliveriesWeight: 1,
                    firstMessageDeliveriesDecay: 0.90,
                    firstMessageDeliveriesCap: 5,

                    // P3
                    meshMessageDeliveriesWeight: 0,
                    // meshMessageDeliveriesDecay: 0,
                    // meshMessageDeliveriesCap: 0,
                    // meshMessageDeliveriesThreshold: 0,
                    // meshMessageDeliveriesWindow: 0,
                    // meshMessageDeliveriesActivation: 0,

                    // P3b
                    meshFailurePenaltyWeight: 0,
                    // meshFailurePenaltyDecay: 0,

                    // P4
                    invalidMessageDeliveriesWeight: 0,
                    // invalidMessageDeliveriesDecay: 0,
                })
            } as Record<string, ReturnType<typeof createTopicScoreParams>>, // Map topics to params
          }),
          scoreThresholds: {
            gossipThreshold: 500,
            publishThreshold: -1000,
            graylistThreshold: -2500,
            acceptPXThreshold: 1000,
            opportunisticGraftThreshold: 3.5,
          },

        }),
      },
    })


        await node.start();
        libp2pNode = node;
        peerId = node.peerId.toString();
        addGameMessage(`Libp2p node started with ID: ${peerId}`);

        // Set up event listeners
        node.addEventListener('peer:discovery', (evt) => {
            const peer = evt.detail;
            addGameMessage(`Discovered peer: ${peer.toString()}`);
        });

        node.addEventListener('peer:connect', async (evt) => {
            const peer = evt.detail;
            connectedPeers.add(peer.toString());
            addGameMessage(`Connected to peer: ${peer.toString()}. Total: ${connectedPeers.size}`);
            // When connected to a new peer, request history if we are a new peer ourselves or want to sync
            if (moveHistory.length === 0) {
                addGameMessage(`Requesting game history from new peer: ${peer.toString()}`);
                await node.services.pubsub.publish(MAIN_TOPIC, new TextEncoder().encode(JSON.stringify({ type: 'history_request', requesterId: peerId } as HistoryRequestMessage)));
            }
        });

        node.addEventListener('peer:disconnect', (evt) => {
            const peer = evt.detail;
            connectedPeers.delete(peer.toString());
            addGameMessage(`Disconnected from peer: ${peer.toString()}. Total: ${connectedPeers.size}`);
        });

        // Subscribe to the single main gossipsub topic
        node.services.pubsub.subscribe(MAIN_TOPIC);

        node.services.pubsub.addEventListener('message', async (evt) => {
            console.log('pubsub', evt)
            const { topic, data, from } = evt.detail;
            const message = new TextDecoder().decode(data);
            console.log('pubsub message', message)

            // Only process messages from the main topic
            if (topic !== MAIN_TOPIC) {
                return;
            }

            try {
                const parsedMessage = JSON.parse(message);
                const messageType = parsedMessage.type; // Extract the type

                switch (messageType) {
                    case 'proposal':
                        await handleProposal(parsedMessage as ProposalMessage, from.toString());
                        break;
                    case 'finalized_move':
                        await handleFinalizedMove(parsedMessage as FinalizedMoveMessage, from.toString());
                        break;
                    case 'history_request':
                        await handleHistoryRequest(parsedMessage as HistoryRequestMessage, from.toString());
                        break;
                    case 'history_response':
                        await handleFullHistory(parsedMessage as HistoryResponseMessage, from.toString());
                        break;
                    case 'current_state':
                        // For now, we rely on full history for trust, but can log for debugging
                        // addGameMessage(`Received current state from ${from.toString()}: ${parsedMessage.fen}`);
                        break;
                    default:
                        addGameMessage(`Received unknown message type: ${messageType} from ${from.toString()}`);
                }

            } catch (error: any) {
                console.error(`Error parsing message from ${from.toString()} on topic ${topic}:`, error);
                addGameMessage(`Error processing message from ${from.toString()} on topic ${topic}: ${error.message}`);
            }
        });

        addGameMessage('Subscribed to gossipsub topic: ' + MAIN_TOPIC);

        // Initial game start
        if (currentTurn === 0 && moveHistory.length === 0) {
            addGameMessage('Starting first voting period...');
            startVotingPeriod();
        }

        // Periodically broadcast current FEN (for general awareness, not critical for trust)
        setInterval(async () => {
            if (game && libp2pNode) {
                await libp2pNode.services.pubsub.publish(MAIN_TOPIC, new TextEncoder().encode(JSON.stringify({ type: 'current_state', fen: game.fen(), turn: currentTurn } as CurrentStateMessage)));
            }
        }, 10000); // Every 10 seconds

    } catch (error: any) {
        console.error('Failed to initialize libp2p:', error);
        addGameMessage(`Error initializing libp2p: ${error.message}`);
        process.exit(1); // Exit if libp2p fails to start
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    addGameMessage('Received SIGINT. Shutting down libp2p node...');
    if (libp2pNode) {
        await libp2pNode.stop();
        addGameMessage('Libp2p node stopped.');
    }
    if (votingTimer) clearTimeout(votingTimer);
    process.exit(0);
});

// Start the main application
main();
