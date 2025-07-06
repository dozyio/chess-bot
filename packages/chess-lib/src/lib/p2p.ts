// src/lib/p2p-chess-node.ts
import { createLibp2p } from 'libp2p';
import type { Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { GossipSub, gossipsub } from '@chainsafe/libp2p-gossipsub';
import * as filters from "@libp2p/websockets/filters";
import { bootstrap } from "@libp2p/bootstrap";
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { createPeerScoreParams, createTopicScoreParams } from '@chainsafe/libp2p-gossipsub/score';
import { identify, identifyPush } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
import { webRTC } from "@libp2p/webrtc";
import { yamux } from "@chainsafe/libp2p-yamux";
import { ping } from '@libp2p/ping';
// import { PeerId } from '@libp2p/interface';
import type { MoveBlock } from './game-logic.js';

// Define common message types for the single topic
export interface BaseMessage {
  type: string;
}

export interface ProposalMessage extends BaseMessage {
  type: 'proposal';
  move: string;
  turn: number;
}

export interface FinalizedMoveMessage extends BaseMessage, MoveBlock {
  type: 'finalized_move';
}

export interface HistoryRequestMessage extends BaseMessage {
  type: 'history_request';
  requesterId: string;
}

export interface HistoryResponseMessage extends BaseMessage {
  type: 'history_response';
  history: MoveBlock[];
}

export interface CurrentStateMessage extends BaseMessage {
  type: 'current_state';
  fen: string;
  turn: number;
}

export type ChessMessage = ProposalMessage | FinalizedMoveMessage | HistoryRequestMessage | HistoryResponseMessage | CurrentStateMessage;

export interface P2PChessNodeCallbacks {
  onPeerConnected: (peerId: string) => void;
  onPeerDisconnected: (peerId: string) => void;
  onMessageReceived: (message: ChessMessage, fromPeer: string) => void;
  onLog: (message: string) => void;
}

const bootstrapMultiaddrs = [
  "/dns4/r1.dozy.io/tcp/443/tls/ws/p2p/12D3KooWHEXu2JRgq7BKa7x4ahmjhiG5XZ2bUHF1Dcy56ueCXw48",
  "/dns4/r2.dozy.io/tcp/443/tls/ws/p2p/12D3KooWLnnFfJxesZZN4wWKNxAudd9atnBnvWPhxg2LTWigExPP",
];

const MAIN_TOPIC = `pubXXX-dev`;

function passthroughMapper(info: any) {
  return info;
}

function applicationScore (p: string) {
  if (p === '12D3KooWLnnFfJxesZZN4wWKNxAudd9atnBnvWPhxg2LTWigExPP' || p ==='12D3KooWHEXu2JRgq7BKa7x4ahmjhiG5XZ2bUHF1Dcy56ueCXw48') {
    return 1200;
  }
  return 0;
}

export class P2PChessNode {
  private node: Libp2p | null = null;
  public peerId: string = '';
  public connectedPeers: Set<string> = new Set();
  private callbacks: P2PChessNodeCallbacks;

  constructor(callbacks: P2PChessNodeCallbacks) {
    this.callbacks = callbacks;
  }

  public async start(): Promise<void> {
    this.callbacks.onLog('Initializing libp2p node...');
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
          circuitRelayTransport({}),
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
            emitSelf: true,
            globalSignaturePolicy: 'StrictSign',
            allowPublishToZeroTopicPeers: true,
            pruneBackoff: 60 * 1000,
            scoreParams: createPeerScoreParams({
              appSpecificScore: applicationScore,
              IPColocationFactorWeight: 0,
              IPColocationFactorThreshold: 0,
              IPColocationFactorWhitelist: new Set<string>(),
              behaviourPenaltyWeight: 0,
              behaviourPenaltyThreshold: 0,
              behaviourPenaltyDecay: 0,
              topicScoreCap: 50,
              topics: {
                [MAIN_TOPIC]: createTopicScoreParams({
                  topicWeight: 1,
                  timeInMeshWeight: 0.1,
                  timeInMeshQuantum: 1 * 1000,
                  timeInMeshCap: 3,
                  firstMessageDeliveriesWeight: 1,
                  firstMessageDeliveriesDecay: 0.90,
                  firstMessageDeliveriesCap: 5,
                  meshMessageDeliveriesWeight: 0,
                  meshFailurePenaltyWeight: 0,
                  invalidMessageDeliveriesWeight: 0,
                })
              } as Record<string, ReturnType<typeof createTopicScoreParams>>,
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
      });

      await node.start();
      this.node = node;
      this.peerId = node.peerId.toString();
      this.callbacks.onLog(`Libp2p node started with ID: ${this.peerId}`);

      this.setupListeners();
      (this.node.services.pubsub as GossipSub).subscribe(MAIN_TOPIC);
      this.callbacks.onLog('Subscribed to gossipsub topic: ' + MAIN_TOPIC);

    } catch (error: any) {
      this.callbacks.onLog(`Error initializing libp2p: ${error.message}`);
      throw error;
    }
  }

  private setupListeners(): void {
    if (!this.node) return;

    this.node.addEventListener('self:peer:update', (evt) => {
      this.callbacks.onLog(`Multiaddrs updated: ${this.node?.getMultiaddrs()}`);
    });

    this.node.addEventListener('peer:discovery', (evt) => {
      const peer = evt.detail;
      this.callbacks.onLog(`Discovered peer: ${peer.toString()}`);
    });

    this.node.addEventListener('peer:connect', (evt) => {
      const peer = evt.detail;
      this.connectedPeers.add(peer.toString());
      this.callbacks.onLog(`Connected to peer: ${peer.toString()}. Total: ${this.connectedPeers.size}`);
      this.callbacks.onPeerConnected(peer.toString());
    });

    this.node.addEventListener('peer:disconnect', (evt) => {
      const peer = evt.detail;
      this.connectedPeers.delete(peer.toString());
      this.callbacks.onLog(`Disconnected from peer: ${peer.toString()}. Total: ${this.connectedPeers.size}`);
      this.callbacks.onPeerDisconnected(peer.toString());
    });

    (this.node.services.pubsub as GossipSub).addEventListener('message', async (evt: CustomEvent) => {
      const { topic, data, from } = evt.detail;
      if (topic !== MAIN_TOPIC) return;

      try {
        const parsedMessage = JSON.parse(new TextDecoder().decode(data));
        this.callbacks.onMessageReceived(parsedMessage as ChessMessage, from.toString());
      } catch (error: any) {
        this.callbacks.onLog(`Error parsing message from ${from.toString()} on topic ${topic}: ${error.message}`);
      }
    });
  }

  public async publishMessage(message: ChessMessage): Promise<void> {
    if (!this.node) {
      this.callbacks.onLog('Cannot publish: libp2p node not started.');
      return;
    }
    await (this.node.services.pubsub as GossipSub).publish(MAIN_TOPIC, new TextEncoder().encode(JSON.stringify(message)));
  }

  public async stop(): Promise<void> {
    if (this.node) {
      this.callbacks.onLog('Shutting down libp2p node...');
      await this.node.stop();
      this.callbacks.onLog('Libp2p node stopped.');
    }
  }
}
