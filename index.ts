import { multiaddr } from "@multiformats/multiaddr"
import * as filters from "@libp2p/websockets/filters"
import { GossipSub, gossipsub } from '@chainsafe/libp2p-gossipsub'
import { bootstrap } from "@libp2p/bootstrap"
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { createLibp2p } from "libp2p"
import { createPeerScoreParams, createTopicScoreParams } from '@chainsafe/libp2p-gossipsub/score'
import { identify, identifyPush } from '@libp2p/identify'
import { kadDHT } from '@libp2p/kad-dht'
import { noise } from "@chainsafe/libp2p-noise"
import { webRTC } from "@libp2p/webrtc"
import { webSockets } from "@libp2p/websockets"
import { yamux } from "@chainsafe/libp2p-yamux"
import { ping } from '@libp2p/ping'
import { Chess, Move } from "chess.js";


class HLC {
  private last: number;
  private logical: number;

  constructor() {
    this.last = Date.now();
    this.logical = 0;
  }

  now(): { physical: number; logical: number } {
    const phys = Date.now();
    if (phys > this.last) {
      this.last = phys;
      this.logical = 0;
    } else {
      this.logical += 1;
    }
    return { physical: this.last, logical: this.logical };
  }
}

const TURN_DURATION = 5000; // 15 seconds
const BUFFER = 500; // ms
const ALPHA = 0.2;        // clock smoothing factor
const topics = ['pubXXX-dev']
const votes = new Map<number, Map<string, Set<string>>>();
let offset = 0;
const chess = new Chess();
const hlc = new HLC();


const passthroughMapper = (info) => {
  return info
}

const applicationScore = (p: string) => {
  if (p === '12D3KooWLnnFfJxesZZN4wWKNxAudd9atnBnvWPhxg2LTWigExPP' || p ==='12D3KooWHEXu2JRgq7BKa7x4ahmjhiG5XZ2bUHF1Dcy56ueCXw48') {
    return 1200
  }

  return 0
}

async function main() {


    const bootstrapMultiaddrs = [
      "/dns4/r1.dozy.io/tcp/443/tls/ws/p2p/12D3KooWHEXu2JRgq7BKa7x4ahmjhiG5XZ2bUHF1Dcy56ueCXw48",
      "/dns4/r2.dozy.io/tcp/443/tls/ws/p2p/12D3KooWLnnFfJxesZZN4wWKNxAudd9atnBnvWPhxg2LTWigExPP",
    ]


  const node = await createLibp2p({
    addresses: {
      listen: [
        '/p2p-circuit',
        '/webrtc'
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
      circuitRelayTransport({
      }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: () => {
        return false
      }
    },
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

            topics: topics.reduce(
              (acc, topic) => {
                acc[topic] = createTopicScoreParams({
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
                return acc
              },
              {} as Record<string, ReturnType<typeof createTopicScoreParams>>,
            ), // Map topics to params
          }),
          scoreThresholds: {
            gossipThreshold: 500,
            publishThreshold: -1000,
            graylistThreshold: -2500,
            acceptPXThreshold: 1000,
            opportunisticGraftThreshold: 3.5,
          },
        }),
    }
  })

  function adjustedTime(): number {
    return Date.now() + offset;
  }

  function currentTurn(): number {
    return Math.floor(adjustedTime() / TURN_DURATION);
  }

  function botVote(): void {
    if (chess.isGameOver()) return;
    const turn = currentTurn();
    // ensure only one vote per turn
    if (turn <= chess.history().length) return;

    const legalMoves = chess.moves();
    const choice = legalMoves[Math.floor(Math.random() * legalMoves.length)];
    const voteMsg = {
      type: 'vote',
      turn,
      move: choice,
      voter: node.peerId.toString(),
      timestamp: hlc.now(),
    };
    node.services.pubsub.publish("pubXXX-dev", new TextEncoder().encode(JSON.stringify(voteMsg)));
  }

  // function handlePubsubMessageEvent(evt: CustomEvent<Message>) {
  function handlePubsubMessageEvent(evt) {
    try {
      const msg = JSON.parse(new TextDecoder().decode(evt.detail.data));
      console.log('pubsub message', msg)
      if (msg.type === 'vote') {
        const { turn, move, voter, timestamp } = msg;
        // Merge vote: get existing map or create
        let turnMap = votes.get(turn);
        if (!turnMap) {
          turnMap = new Map<string, Set<string>>();
        }
        // get existing voter set or create
        let voterSet = turnMap.get(move);
        if (!voterSet) {
          voterSet = new Set<string>();
        }
        voterSet.add(voter);
        turnMap.set(move, voterSet);
        votes.set(turn, turnMap);

        // Clock smoothing using HLC timestamp
        const nowLocal = Date.now();
        offset = (1 - ALPHA) * offset + ALPHA * (timestamp.physical - nowLocal);
      } else {
        console.error('Unknown message type', msg);
      }
    } catch (e) {
      console.error('Failed to parse vote message', e);
    }
  }

  await node.start()

  // Periodic bot voting
  setInterval(botVote, TURN_DURATION / 2);

  // Decide and apply move at end of each turn
  setInterval(() => {
    const turn = currentTurn() - 1;
    if (turn < 0) return;
    const moveMap = votes.get(turn);
    if (!moveMap) return;
    // skip if already applied
    if (chess.history().length > turn) return;

    // tally votes and break ties lexicographically
    let selected: string | null = null;
    let maxCount = -1;
    Array.from(moveMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([move, set]) => {
        if (set.size > maxCount) {
          maxCount = set.size;
          selected = move;
        }
      });

    try {
    if (selected) {
      chess.move(selected);
      console.log(`Turn ${turn + 1}: Played ${selected}`);
      console.log(chess.ascii())
      if (chess.isGameOver()) {
        console.log('Game over');
        votes.clear();
        chess.reset();
      }
    }
    } catch (e) {
      console.error('Failed to apply move', e);
    }
  }, TURN_DURATION + BUFFER);

  console.log(`Node started with id ${node.peerId.toString()}`)

  topics.forEach((t) => node.services.pubsub.subscribe(t));

  // add listener
  node.services.pubsub.addEventListener("message", handlePubsubMessageEvent);


  node.addEventListener('self:peer:update', (evt) => {
    console.log('multiaddrs', node.getMultiaddrs())
  })
}

await main()
