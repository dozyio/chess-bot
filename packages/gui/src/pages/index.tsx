import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Chessboard } from 'react-chessboard';
import { Box, Flex, Text, Heading, VStack } from '@chakra-ui/react'; // Import Chakra UI components

// --- Correctly importing P2PChessNode and ChessGame related types/helpers from the library ---
import { ChessGame, MoveBlock, sha256, ChessJsVerboseMove, convertMoveToUCI, P2PChessNode, ProposalMessage, FinalizedMoveMessage, HistoryRequestMessage, HistoryResponseMessage, CurrentStateMessage } from 'chess-lib';

// Define the common topic for Gossipsub
const MAIN_TOPIC = `pubXXX-dev`;
const VOTING_PERIOD_MS = 15000; // 5 seconds for voting


export default function App() {
  const [gameFen, setGameFen] = useState<string>('start'); // Initialized to 'start' FEN
  const [gameHistory, setGameHistory] = useState<MoveBlock[]>([]);
  const [currentTurn, setCurrentTurn] = useState<number>(0);
  const [peerId, setPeerId] = useState<string>('');
  const [connectedPeers, setConnectedPeers] = useState<Set<string>>(new Set());
  const [gameLogs, setGameLogs] = useState<string[]>([]);
  const [currentVotes, setCurrentVotes] = useState<Map<string, number>>(new Map());
  const [isVotingActive, setIsVotingActive] = useState<boolean>(false);
  const [timer, setTimer] = useState<number>(VOTING_PERIOD_MS / 1000); // Timer in seconds

  // Refs to hold instances of non-React classes
  const chessGameRef = useRef<ChessGame | null>(null);
  const p2pNodeRef = useRef<P2PChessNode | null>(null);
  const votingTimerRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);

  // Refs to hold the LATEST state values for callbacks that might capture old state
  const isVotingActiveRef = useRef(isVotingActive);
  const currentTurnRef = useRef(currentTurn);

  // Update refs whenever the state changes
  useEffect(() => {
    isVotingActiveRef.current = isVotingActive;
  }, [isVotingActive]);

  useEffect(() => {
    currentTurnRef.current = currentTurn;
  }, [currentTurn]);

  // --- Logging function for UI ---
  const addGameMessage = useCallback((message: string) => {
    setGameLogs(prevLogs => {
      const newLogs = [`[${new Date().toLocaleTimeString()}] ${message}`, ...prevLogs];
      return newLogs.slice(0, 50); // Keep last 50 logs
    });
  }, []);

  // --- P2P Callbacks for the P2PChessNode ---
  const p2pCallbacks = useRef({
    onPeerConnected: (peerId: string) => {
      setConnectedPeers(prev => {
        const newSet = new Set(prev).add(peerId);
        addGameMessage(`Connected to peer: ${peerId}. Total: ${newSet.size}`); // Log updated size
        return newSet;
      });
      // Request history from new peer if our history is empty
      if (chessGameRef.current && chessGameRef.current.moveHistory.length === 0 && p2pNodeRef.current) {
        addGameMessage(`Requesting game history from new peer: ${peerId}`);
        p2pNodeRef.current.publishMessage({ type: 'history_request', requesterId: p2pNodeRef.current.peerId } as HistoryRequestMessage);
      }
    },
    onPeerDisconnected: (peerId: string) => {
      setConnectedPeers(prev => {
        const newSet = new Set(prev);
        newSet.delete(peerId);
        addGameMessage(`Disconnected from peer: ${peerId}. Total: ${newSet.size}`); // Log updated size
        return newSet;
      });
    },
    onMessageReceived: async (message: any, fromPeer: string) => {
      addGameMessage(`[P2P Message Received] Type: ${message.type}, From: ${fromPeer}`); // Added log
      if (!chessGameRef.current || !p2pNodeRef.current) return;

      // FIX: Pass the latest state values to handleProposal/handleFinalizedMove
      // This is crucial because p2pCallbacks.current is stable, so its methods
      // would otherwise capture stale state.
      const latestIsVotingActive = isVotingActiveRef.current;
      const latestCurrentTurn = currentTurnRef.current;

      switch (message.type) {
        case 'proposal':
          // Pass latest state explicitly
          await handleProposal(message as ProposalMessage, fromPeer, latestIsVotingActive, latestCurrentTurn);
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
          // Optional: log or display current state for debugging
          // addGameMessage(`Received current state from ${fromPeer}: ${message.fen}`);
          break;
        default:
          addGameMessage(`Received unknown message type: ${message.type} from ${fromPeer}`);
      }
    },
    onLog: addGameMessage,
  });

  // --- Game Logic Functions (adapted for React state) ---

  // FIX: handleProposal now accepts isVotingActive and currentTurn as explicit arguments
  const handleProposal = useCallback(async (proposal: ProposalMessage, fromPeer: string, latestIsVotingActive: boolean, latestCurrentTurn: number) => {
    addGameMessage(`[Handle Proposal] Processing proposal from ${fromPeer} for move ${proposal.move} (Proposal Turn: ${proposal.turn})`); // Added log
    addGameMessage(`[Handle Proposal] Current state (from passed args): isVotingActive=${latestIsVotingActive}, currentTurn=${latestCurrentTurn}, gameRef.current=${!!chessGameRef.current}`); // Added log

    if (!chessGameRef.current) {
      addGameMessage(`[Handle Proposal] Ignoring: chessGameRef.current is null.`); // Added log
      return;
    }
    // FIX: Use the latestIsVotingActive passed as argument
    if (!latestIsVotingActive) {
      addGameMessage(`[Handle Proposal] Ignoring: Voting is not active (latestIsVotingActive=false).`); // Added log
      return;
    }
    // FIX: Use the latestCurrentTurn passed as argument
    if (proposal.turn !== latestCurrentTurn) {
      addGameMessage(`[Handle Proposal] Ignoring: Proposal turn (${proposal.turn}) does not match current voting turn (${latestCurrentTurn}).`); // Added log
      return;
    }

    const newFen = chessGameRef.current.validateMove(chessGameRef.current.getFen(), proposal.move);
    if (newFen) {
      addGameMessage(`[Handle Proposal] Move ${proposal.move} is valid. Adding vote.`); // Added log
      setCurrentVotes(prevVotes => {
        const newVotes = new Map(prevVotes); // FIX: Create a new Map instance
        newVotes.set(proposal.move, (newVotes.get(proposal.move) || 0) + 1);
        addGameMessage(`Vote received for ${proposal.move} from ${fromPeer}. Total votes for ${proposal.move}: ${newVotes.get(proposal.move)}`);
        addGameMessage(`[Handle Proposal] Votes after update (inside updater): ${JSON.stringify(Array.from(newVotes.entries()))}`); // Debug log
        return newVotes;
      });
    } else {
      addGameMessage(`[Handle Proposal] Invalid move proposal: ${proposal.move}.`); // Added log
    }
  }, [addGameMessage]); // Removed isVotingActive, currentTurn from dependencies as they are passed as args

  const finalizeMove = useCallback(async () => {
    setIsVotingActive(false);
    if (votingTimerRef.current) clearTimeout(votingTimerRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

    addGameMessage(`[Finalize Move] Starting for turn: ${currentTurn}, currentVotes size: ${currentVotes.size}`); // Added log
    currentVotes.forEach((count, move) => {
      addGameMessage(`  - ${move}: ${count} votes`);
    });

    if (currentVotes.size === 0) {
      addGameMessage('No valid votes received. Skipping turn. (Local decision)');
      // If no votes, we still need to advance our local turn and restart voting
      // to prevent getting stuck. This is a "no-op" move for this turn.
      if (chessGameRef.current) {
        setCurrentTurn(prev => prev + 1); // Advance turn
      }
      setCurrentVotes(new Map());
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
        const combinedString = `${chessGameRef.current?.getFen()}_${moveUCI}`;
        const moveHash = await sha256(combinedString);
        if (moveHash < lowestHash) {
          lowestHash = moveHash;
          resolvedMoveUCI = moveUCI;
        }
      }
      winningMoveUCI = resolvedMoveUCI;
      addGameMessage(`Tie resolved for move selection. Winning move: ${winningMoveUCI} (Hash: ${lowestHash.substring(0, 8)}...)`);
    }

    if (winningMoveUCI && chessGameRef.current && p2pNodeRef.current) {
      const fenBeforeMove = chessGameRef.current.getFen();
      const newFen = chessGameRef.current.validateMove(fenBeforeMove, winningMoveUCI);

      if (newFen) {
        const previousBlockHash = chessGameRef.current.moveHistory.length > 0 ? chessGameRef.current.moveHistory[chessGameRef.current.moveHistory.length - 1].blockHash : 'GENESIS';
        const timestamp = Date.now();
        const blockTurn = currentTurn; // Use the currentTurn from state

        const blockContent = `${previousBlockHash}_${winningMoveUCI}_${fenBeforeMove}_${newFen}_${timestamp}_${p2pNodeRef.current.peerId}_${blockTurn}`;
        const blockHash = await sha256(blockContent);

        const newMoveBlock: MoveBlock = {
          previousBlockHash,
          moveUCI: winningMoveUCI,
          fenBeforeMove,
          fenAfterMove: newFen,
          timestamp,
          broadcasterPeerId: p2pNodeRef.current.peerId,
          blockHash,
          turn: blockTurn,
        };

        addGameMessage(`[Finalize Move] Broadcasting finalized block for turn ${newMoveBlock.turn}`); // Added log
        await p2pNodeRef.current.publishMessage({ type: 'finalized_move', ...newMoveBlock } as FinalizedMoveMessage);
      } else {
        addGameMessage(`Error: Determined winning move ${winningMoveUCI} is invalid during finalization. Skipping turn. (Local decision)`);
        if (chessGameRef.current) {
          setCurrentTurn(prev => prev + 1); // Advance turn
        }
        setCurrentVotes(new Map());
        startVotingPeriod();
      }
    } else {
      addGameMessage('No winning move determined after voting or node/game not ready. Skipping turn. (Local decision)');
      if (chessGameRef.current) {
        setCurrentTurn(prev => prev + 1); // Advance turn
      }
      setCurrentVotes(new Map());
      startVotingPeriod();
    }
  }, [currentTurn, currentVotes, addGameMessage]);

  const handleFinalizedMove = useCallback(async (incomingBlockMessage: FinalizedMoveMessage, fromPeer: string) => {
    if (!chessGameRef.current) return;

    const didUpdate = await chessGameRef.current.applyFinalizedMoveBlock(incomingBlockMessage);

    if (didUpdate) {
      // Clear existing timers and votes as state has changed
      if (votingTimerRef.current) clearTimeout(votingTimerRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

      setGameFen(chessGameRef.current.getFen());
      setGameHistory([...chessGameRef.current.moveHistory]);
      setCurrentTurn(chessGameRef.current.currentTurn);
      setCurrentVotes(new Map()); // Clear votes for next round
      addGameMessage(`[Finalized Move Applied] New Turn: ${chessGameRef.current.currentTurn}, New FEN: ${chessGameRef.current.getFen()} (from peer ${fromPeer})`); // Added log
      startVotingPeriod(); // Start new voting period after state update
    } else {
      addGameMessage(`[Finalized Move Ignored] from ${fromPeer} for turn ${incomingBlockMessage.turn}: Chain validation failed or shorter chain.`); // Added log
    }
  }, [addGameMessage]);

  const handleHistoryRequest = useCallback(async (request: HistoryRequestMessage, fromPeer: string) => {
    if (!p2pNodeRef.current || !chessGameRef.current || fromPeer === p2pNodeRef.current.peerId) return;

    addGameMessage(`Received history request from ${fromPeer}. Sending our history.`);
    await p2pNodeRef.current.publishMessage({ type: 'history_response', history: chessGameRef.current.moveHistory } as HistoryResponseMessage);
  }, [addGameMessage]);

  const handleFullHistory = useCallback(async (incomingMessage: HistoryResponseMessage, fromPeer: string) => {
    if (!chessGameRef.current || !p2pNodeRef.current || incomingMessage.history.length === 0) return;

    const didUpdate = await chessGameRef.current.setFullHistory(incomingMessage.history);

    if (didUpdate) {
      // Clear existing timers and votes as state has changed
      if (votingTimerRef.current) clearTimeout(votingTimerRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

      setGameFen(chessGameRef.current.getFen());
      setGameHistory([...chessGameRef.current.moveHistory]);
      setCurrentTurn(chessGameRef.current.currentTurn);
      setCurrentVotes(new Map());
      addGameMessage(`Adopted full history from ${fromPeer} (length ${chessGameRef.current.moveHistory.length}).`);
      startVotingPeriod();
    } else {
      addGameMessage(`Ignoring full history from ${fromPeer}: Invalid chain or shorter/equal chain with higher hash.`);
    }
  }, [addGameMessage]);


  const startVotingPeriod = useCallback(() => {
    if (votingTimerRef.current) clearTimeout(votingTimerRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

    setCurrentVotes(new Map()); // Clear votes for the new round
    setIsVotingActive(true);
    setTimer(VOTING_PERIOD_MS / 1000); // Reset timer

    addGameMessage(`Voting for turn ${currentTurn + 1} (${chessGameRef.current?.getTurnColor() === 'w' ? 'White' : 'Black'}) started. ${VOTING_PERIOD_MS / 1000} seconds...`);

    // Start countdown interval
    countdownIntervalRef.current = setInterval(() => {
      setTimer(prev => {
        if (prev <= 1) {
          clearInterval(countdownIntervalRef.current!);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // Set timeout to finalize move
    votingTimerRef.current = setTimeout(() => {
      addGameMessage('Voting period ended. Finalizing move...');
      finalizeMove();
    }, VOTING_PERIOD_MS);
  }, [currentTurn, finalizeMove, addGameMessage]);

  // --- User Interaction and Game Board ---

  const onDrop = useCallback((sourceSquare: string, targetSquare: string, piece: string) => {
    // FIX: Use isVotingActiveRef.current and currentTurnRef.current for latest state
    if (!chessGameRef.current || !isVotingActiveRef.current || !p2pNodeRef.current) {
      addGameMessage("Cannot propose move: Voting not active or P2P node not ready.");
      return false;
    }

    const moveAttempt = {
      from: sourceSquare,
      to: targetSquare,
      // Handle promotion if applicable (react-chessboard handles the prompt)
      promotion: piece[1].toLowerCase() === 'p' && (targetSquare[1] === '8' || targetSquare[1] === '1') ? 'q' : undefined,
    };

    const tempGame = chessGameRef.current.validateMove(chessGameRef.current.getFen(), convertMoveToUCI(moveAttempt as ChessJsVerboseMove));

    if (tempGame) {
      const uciMove = convertMoveToUCI(moveAttempt as ChessJsVerboseMove);
      addGameMessage(`User proposing move: ${uciMove}`);
      // FIX: Removed await and added .catch() for fire-and-forget
      p2pNodeRef.current.publishMessage({ type: 'proposal', move: uciMove, turn: currentTurnRef.current } as ProposalMessage)
        .catch(error => addGameMessage(`Error publishing proposal: ${error.message}`));
      return true; // Indicate that the move was accepted by the local game instance (for visual feedback)
    } else {
      addGameMessage(`Invalid move: ${sourceSquare}-${targetSquare}`);
      return false; // Indicate that the move was not accepted
    }
  }, [addGameMessage]); // Dependencies updated to reflect use of refs

  // --- Add useEffect to observe currentVotes state changes ---
  useEffect(() => {
    addGameMessage(`[currentVotes State Changed] New value: ${JSON.stringify(Array.from(currentVotes.entries()))}`);
  }, [currentVotes, addGameMessage]);


  // --- P2P Node Lifecycle Management ---
  useEffect(() => {
    chessGameRef.current = new ChessGame();
    setGameFen(chessGameRef.current.getFen());
    addGameMessage('Chess game initialized.');

    // Instantiate P2PChessNode from the library
    p2pNodeRef.current = new P2PChessNode(p2pCallbacks.current);

    const startNode = async () => {
      try {
        await p2pNodeRef.current?.start();
        setPeerId(p2pNodeRef.current?.peerId || '');
        // Initial game start if no history
        if (chessGameRef.current?.moveHistory.length === 0) {
          startVotingPeriod();
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        addGameMessage(`Failed to start P2P node: ${error.message}`);
      }
    };

    startNode();

    // Periodically broadcast current FEN (for general awareness)
    const broadcastInterval = setInterval(async () => {
      if (chessGameRef.current && p2pNodeRef.current && p2pNodeRef.current.peerId) {
        await p2pNodeRef.current.publishMessage({ type: 'current_state', fen: chessGameRef.current.getFen(), turn: chessGameRef.current.currentTurn } as CurrentStateMessage);
      }
    }, 10000); // Every 10 seconds

    // Cleanup on component unmount
    return () => {
      if (votingTimerRef.current) clearTimeout(votingTimerRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      if (broadcastInterval) clearInterval(broadcastInterval);
      p2pNodeRef.current?.stop();
    };
  }, [addGameMessage, p2pCallbacks]);


  return (
    <Flex
      minH="100vh"
      bg="gray.900"
      color="white"
      direction="column"
      align="center"
      justify="center"
      p={4}
      fontFamily="Inter, sans-serif" // Direct font-family for Chakra
    >
      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
        body {
          font-family: 'Inter', sans-serif;
        }
      `}</style>

      <Heading as="h1" fontSize="4xl" fontWeight="bold" mb={6} color="yellow.400">
        P2P Consensus Chess
      </Heading>

      <Flex
        direction={{ base: 'column', lg: 'row' }}
        gap={8}
        w="full"
        maxW="6xl"
      >
        {/* Left Column: Game Info & Board */}
        <Flex
          flex={1}
          direction="column"
          align="center"
          bg="gray.800"
          p={6}
          rounded="lg"
          shadow="lg"
        >
          <Box mb={4} textAlign="center">
            <Text fontSize="lg">
              Connected Peers: <Text as="span" fontWeight="bold" color="green.400">{connectedPeers.size}</Text>
            </Text>
            <Text fontSize="xl" mt={2}>
              Current Turn: <Text as="span" fontWeight="bold">{currentTurn + 1}</Text> (<Text as="span" textTransform="capitalize">{chessGameRef.current?.getTurnColor() === 'w' ? 'White' : 'Black'}</Text> to move)
            </Text>
            <Text fontSize="xl">
              Time Remaining: <Text as="span" fontWeight="bold" color="red.400">{timer}s</Text>
            </Text>
          </Box>

          <Box width="500px">
            <Chessboard
              position={gameFen}
              onPieceDrop={onDrop}
              boardWidth={500} // Responsive sizing will be handled by parent container
              customBoardStyle={{
                borderRadius: '8px',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
              }}
            />
          </Box>
        </Flex>

        {/* Right Column: Voting & Logs */}
        <Flex flex={1} direction="column" gap={6}>
          {/* Voting Area */}
          <Box bg="gray.800" p={6} rounded="lg" shadow="lg" flexGrow={1}>
            <Heading as="h2" fontSize="2xl" fontWeight="semibold" mb={4} textAlign="center">
              Vote Tally
            </Heading>
            {isVotingActive ? (
              currentVotes.size > 0 ? (
                <VStack as="ul" spacing={2} align="stretch"> {/* Using VStack for ul */}
                  {[...currentVotes.entries()]
                    .sort(([, countA], [, countB]) => countB - countA) // Sort by votes (desc)
                    .map(([move, count]) => (
                      <Flex as="li" key={move} justify="space-between" align="center" bg="gray.700" p={3} rounded="md">
                        <Text fontFamily="mono" fontSize="lg" color="green.300">{move}</Text>
                        <Text fontWeight="bold" fontSize="xl" color="yellow.300">{count} votes</Text>
                      </Flex>
                    ))}
                </VStack>
              ) : (
                <Text textAlign="center" color="gray.400">No votes yet for this round.</Text>
              )
            ) : (
              <Text textAlign="center" color="gray.400">Voting is currently inactive.</Text>
            )}
          </Box>

          {/* Game Logs */}
          <Box bg="gray.800" p={6} rounded="lg" shadow="lg" flexGrow={1} h="64" overflowY="auto" maxWidth="100%" wordBreak="break-all">
            <Heading as="h2" fontSize="2xl" fontWeight="semibold" mb={4} textAlign="center">
              Game Logs
            </Heading>
            <VStack spacing={2} fontSize="sm" color="gray.300" align="stretch">
              {gameLogs.map((log, index) => (
                <Text key={index} borderBottom="1px" borderColor="gray.700" pb={1} _last={{ borderBottom: 'none' }}>
                  {log}
                </Text>
              ))}
            </VStack>
          </Box>
        </Flex>
      </Flex>

      {/* Footer / Debug Info */}
      <Box mt={8} textAlign="center" color="gray.500" fontSize="sm">
        <Text>
          Your Peer ID: <Text as="span" fontFamily="mono" wordBreak="break-all">{peerId || 'Connecting...'}</Text>
        </Text>
      </Box>
    </Flex>
  );
}

