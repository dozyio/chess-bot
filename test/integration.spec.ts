// tests/integration.test.ts (Mocha/Chai)
import { ChessGame, P2PChessNode, sha256 } from '../src/lib/index.js';
import type { MoveBlock } from '../src/lib/index.js';
import { expect } from 'chai';
import sinon from 'sinon';

describe('P2P Chess Game Library Integration', () => {
  let chessGame: ChessGame;
  let p2pNodeA: P2PChessNode;
  let p2pNodeB: P2PChessNode;
  let logs: string[] = [];

  // Use Sinon.js for mocking/spying
  let mockCallbacksA: any;
  let mockCallbacksB: any;
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox(); // Create a new sandbox for each test
    logs = [];
    chessGame = new ChessGame();

    // Define mock callbacks with Sinon spies
    mockCallbacksA = {
      onPeerConnected: sandbox.spy(),
      onPeerDisconnected: sandbox.spy(),
      onMessageReceived: sandbox.spy(),
      onLog: sandbox.spy((msg: string) => logs.push(`NodeA: ${msg}`)),
    };

    mockCallbacksB = {
      onPeerConnected: sandbox.spy(),
      onPeerDisconnected: sandbox.spy(),
      onMessageReceived: sandbox.spy(),
      onLog: sandbox.spy((msg: string) => logs.push(`NodeB: ${msg}`)),
    };

    p2pNodeA = new P2PChessNode(mockCallbacksA);
    p2pNodeB = new P2PChessNode(mockCallbacksB);
  });

  afterEach(async () => {
    sandbox.restore(); // Restore all mocks/spies after each test
    if (p2pNodeA.peerId) await p2pNodeA.stop(); // Only stop if it started
    if (p2pNodeB.peerId) await p2pNodeB.stop(); // Only stop if it started
  });

  it('nodes can start, connect, and exchange basic messages', async function() { // Use 'function' for 'this.timeout'
    this.timeout(20000); // Set timeout for this specific test

    // Spy on the actual publishMessage method
    const publishSpyA = sandbox.spy(p2pNodeA, 'publishMessage');
    const publishSpyB = sandbox.spy(p2pNodeB, 'publishMessage');

    await p2pNodeA.start();
    await p2pNodeB.start();

    // Give some time for discovery and connection
    await new Promise(resolve => setTimeout(resolve, 5000)); // Adjust as needed

    expect(p2pNodeA.connectedPeers.size).to.be.greaterThan(0);
    expect(p2pNodeB.connectedPeers.size).to.be.greaterThan(0);

    // Node A sends a proposal
    const testProposal = { type: 'proposal', move: 'e2e4', turn: 0 };
    await p2pNodeA.publishMessage(testProposal as any); // Cast to any if types don't strictly match ChessMessage

    // Give time for message propagation
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Expect Node B to have received the message
    expect(mockCallbacksB.onMessageReceived.calledWith(testProposal, p2pNodeA.peerId)).to.be.true;
    // Alternative: expect(mockCallbacksB.onMessageReceived.args[0][0]).to.deep.equal(testProposal);

    // Node B sends a history request
    const historyRequest = { type: 'history_request', requesterId: p2pNodeB.peerId };
    await p2pNodeB.publishMessage(historyRequest as any);

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Expect Node A to have received the history request
    expect(mockCallbacksA.onMessageReceived.calledWith(historyRequest, p2pNodeB.peerId)).to.be.true;
  });

  it('ChessGame applies valid move blocks and handles history sync', async () => {
    const initialFen = chessGame.getFen();
    expect(initialFen).to.equal('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(chessGame.moveHistory.length).to.equal(0);
    expect(chessGame.currentTurn).to.equal(0);

    // Simulate a first move block
    const move1: MoveBlock = {
      previousBlockHash: 'GENESIS',
      moveUCI: 'e2e4',
      fenBeforeMove: initialFen,
      fenAfterMove: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      timestamp: Date.now(),
      broadcasterPeerId: 'peer1',
      blockHash: await sha256(`GENESIS_e2e4_${initialFen}_rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1_${Date.now()}_peer1_0`),
      turn: 0
    };

    let applied = await chessGame.applyFinalizedMoveBlock(move1);
    expect(applied).to.be.true;
    expect(chessGame.moveHistory.length).to.equal(1);
    expect(chessGame.getFen()).to.equal(move1.fenAfterMove);
    expect(chessGame.currentTurn).to.equal(1);

    // Simulate a second move block
    const fenAfterMove1 = chessGame.getFen();
    const move2: MoveBlock = {
      previousBlockHash: move1.blockHash,
      moveUCI: 'e7e5',
      fenBeforeMove: fenAfterMove1,
      fenAfterMove: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      timestamp: Date.now(),
      broadcasterPeerId: 'peer2',
      blockHash: await sha256(`${move1.blockHash}_e7e5_${fenAfterMove1}_rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2_${Date.now()}_peer2_1`),
      turn: 1
    };

    applied = await chessGame.applyFinalizedMoveBlock(move2);
    expect(applied).to.be.true;
    expect(chessGame.moveHistory.length).to.equal(2);
    expect(chessGame.getFen()).to.equal(move2.fenAfterMove);
    expect(chessGame.currentTurn).to.equal(2);

    // Simulate a full history sync with a longer chain
    const longerHistory: MoveBlock[] = [
      move1,
      move2,
      // Add a third valid move
      {
        previousBlockHash: move2.blockHash,
        moveUCI: 'd2d4',
        fenBeforeMove: move2.fenAfterMove,
        fenAfterMove: 'rnbqkbnr/pppp1ppp/8/4p3/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2',
        timestamp: Date.now(),
        broadcasterPeerId: 'peer3',
        blockHash: await sha256(`${move2.blockHash}_d2d4_${move2.fenAfterMove}_rnbqkbnr/pppp1ppp/8/4p3/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2_${Date.now()}_peer3_2`),
        turn: 2
      }
    ];

    const didSetHistory = await chessGame.setFullHistory(longerHistory);
    expect(didSetHistory).to.be.true;
    expect(chessGame.moveHistory.length).to.equal(3);
    expect(chessGame.getFen()).to.equal(longerHistory[2].fenAfterMove);
    expect(chessGame.currentTurn).to.equal(3);

    // Try setting an invalid history (e.g., FEN mismatch)
    const invalidHistory: MoveBlock[] = [
      {
        ...move1,
        fenAfterMove: 'invalid-fen' // Make it invalid
      }
    ];
    const didSetInvalidHistory = await chessGame.setFullHistory(invalidHistory);
    expect(didSetInvalidHistory).to.be.false;
    expect(chessGame.moveHistory.length).to.equal(3); // Should not have changed
  });
});
