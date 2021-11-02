import z = require('ziii');
import {Msg, FeedId} from 'ssb-typescript';
import {plugin, muxrpc} from 'secret-stack-decorators';
import {AddressData as DBData} from 'ssb-conn-db/lib/types';
import {ListenEvent as HubEvent} from 'ssb-conn-hub/lib/types';
import {StagedData} from 'ssb-conn-staging/lib/types';
import ConnQuery = require('ssb-conn-query');
import {Peer} from 'ssb-conn-query/lib/types';
import {Discovery as LANDiscovery} from 'ssb-lan/lib/types';
const pull = require('pull-stream');
const Pausable = require('pull-pause');
const ip = require('ip');
const onWakeup = require('on-wakeup');
const onNetwork = require('on-change-network-strict');
const hasNetwork = require('has-network2');
const Ref = require('ssb-ref');
const debug = require('debug')('ssb:conn:scheduler');
import {Config, SSB} from './types';

let lastCheck = 0;
let lastValue: any = null;
function hasNetworkDebounced() {
  if (lastCheck + 1e3 < Date.now()) {
    lastCheck = Date.now();
    lastValue = hasNetwork();
  }
  return lastValue;
}

//detect if not connected to wifi or other network
//(i.e. if there is only localhost)
function isOffline(p: Peer) {
  if (ip.isLoopback(p[1].host) || p[1].host == 'localhost') return false;
  else return !hasNetworkDebounced();
}

const canBeConnected = (p: Peer) => !isOffline(p);

//peers which we can connect to, but are not upgraded.
//select peers which we can connect to, but are not upgraded to LT.
//assume any peer is legacy, until we know otherwise...
function isLegacy(peer: Peer): boolean {
  return hasSuccessfulAttempts(peer) && !hasPinged(peer);
}

function notRoom(peer: Peer): boolean {
  return peer[1].type !== 'room';
}

function notPub(peer: Peer): boolean {
  return peer[1].type !== 'pub';
}

function isDefunct(peer: Peer | [string, DBData]): boolean {
  return peer[1].defunct === true;
}

function take(n: number) {
  return <T>(arr: Array<T>) => arr.slice(0, Math.max(n, 0));
}

type Type =
  | 'bt'
  | 'lan'
  | 'internet'
  | 'dht'
  | 'pub'
  | 'room'
  | 'room-attendant'
  | '?';

function detectType(peer: Peer): Type {
  const [addr, data] = peer;
  if (data.type === 'bt') return 'bt';
  if (data.type === 'lan') return 'lan';
  if (data.type === 'internet') return 'internet';
  if (data.type === 'dht') return 'dht';
  if (data.type === 'pub') return 'pub';
  if (data.type === 'room') return 'room';
  if (data.type === 'room-endpoint') return 'room-attendant'; // legacy
  if (data.type === 'room-attendant') return 'room-attendant';
  if (data.source === 'local') return 'lan';
  if (data.source === 'pub') return 'pub';
  if (data.source === 'internet') return 'internet';
  if (data.source === 'dht') return 'dht';
  if (data.inferredType === 'bt') return 'bt';
  if (data.inferredType === 'lan') return 'lan';
  if (data.inferredType === 'dht') return 'dht';
  if (data.inferredType === 'internet') return 'internet';
  if (addr.startsWith('bt:')) return 'bt';
  if (addr.startsWith('dht:')) return 'dht';
  return '?';
}

const {
  passesExpBackoff,
  passesGroupDebounce,
  hasNoAttempts,
  hasOnlyFailedAttempts,
  hasPinged,
  hasSuccessfulAttempts,
  sortByStateChange,
} = ConnQuery;

/**
 * Given an excess of connected peers, pick the ones that have been connected
 * long enough. "Long enough" is 2minutes divided by the excess, so that the
 * more excess we have, the quicker we trigger disconnections. The less excess,
 * the longer we wait to trigger a disconnection.
 */
function filterOldExcess(excess: number) {
  return (peers: Array<Peer>) =>
    peers.filter((p) => Date.now() > p[1].hubUpdated! + (2 * MINUTES) / excess);
}

function sortByOldestConnection(peers: Array<Peer>) {
  return peers.sort((a, b) => {
    return a[1].hubUpdated! - b[1].hubUpdated!;
  });
}

function shufflePeers(peers: Array<Peer>) {
  return peers.sort(() => Math.random() - 0.5);
}

function filter(condition: (peer: Peer) => boolean) {
  return (arr: Array<Peer>) => arr.filter(condition);
}

const MINUTES = 60e3;
const HOUR = 60 * 60e3;

interface BTPeer {
  remoteAddress: string;
  id: string;
  displayName: string;
}

interface Pausable {
  pause: CallableFunction;
  resume: CallableFunction;
}

@plugin('1.0.0')
export class ConnScheduler {
  private readonly ssb: SSB;
  private readonly config: Config;
  private pubDiscoveryPausable?: Pausable;
  private intervalForUpdate?: NodeJS.Timeout;
  private ssbDB2Subscription?: CallableFunction | undefined;
  private closed: boolean;
  private loadedSocialGraph: boolean;
  private lastMessageAt: number;
  private hasScheduledAnUpdate: boolean;
  private socialGraph: Record<FeedId, number>;

  constructor(ssb: any, config: any) {
    this.ssb = ssb;
    this.config = config;
    this.closed = true;
    this.lastMessageAt = 0;
    this.hasScheduledAnUpdate = false;
    this.loadedSocialGraph = false;
    this.socialGraph = {};
  }

  private loadSocialGraph() {
    if (!this.ssb.friends?.graphStream) {
      debug('Warning: ssb-friends@5 is missing, scheduling is degraded');
      this.loadedSocialGraph = true;
      return;
    }

    pull(
      this.ssb.friends?.graphStream({live: true, old: true}),
      pull.drain((g: Record<FeedId, Record<FeedId, number>>) => {
        if (g[this.ssb.id]) {
          const prev = this.socialGraph;
          const updates = g[this.ssb.id];
          this.socialGraph = {...prev, ...updates};
        }
        this.loadedSocialGraph = true;
      }),
    );
  }

  private isCurrentlyDownloading() {
    // don't schedule new connections if currently downloading messages
    return this.lastMessageAt && this.lastMessageAt > Date.now() - 500;
  }

  private weBlockThem = ([_addr, data]: [string, {key?: string}]) => {
    if (!data?.key) return false;
    return this.socialGraph[data.key] === -1;
  };

  private weFollowThem = ([_addr, data]: [string, {key?: string}]) => {
    if (!data?.key) return false;
    return this.socialGraph[data.key] > 0;
  };

  private maxWaitToConnect(peer: Peer): number {
    const type = detectType(peer);
    switch (type) {
      case 'lan':
        return 30e3;

      case 'bt':
        return 60e3;

      case 'dht':
        return 300e3;

      default:
        return 10e3;
    }
  }

  // Utility to connect to bunch of peers, or disconnect if over quota
  // opts: { quota, backoffStep, backoffMax, groupMin }
  private updateTheseConnections(test: (p: Peer) => boolean, opts: any) {
    const query = this.ssb.conn.query();
    const peersUp = query.peersConnected().filter(test);
    const peersDown = query.peersConnectable('db').filter(test);
    const {quota, backoffStep, backoffMax, groupMin} = opts;
    const excess = peersUp.length > quota * 2 ? peersUp.length - quota : 0;
    const freeSlots = Math.max(quota - peersUp.length, 0);

    // Disconnect from excess, after some long and random delay
    z(peersUp)
      .z(filterOldExcess(excess))
      .z(sortByOldestConnection)
      .z(take(excess))
      .forEach(([addr]) => {
        this.ssb.conn.disconnect(addr);
      });

    // Connect to suitable candidates
    z(peersDown)
      .z(filter((p) => !this.weBlockThem(p)))
      .z(filter(canBeConnected))
      .z(filter(([, data]) => data.autoconnect !== false))
      .z(passesGroupDebounce(groupMin))
      .z(filter(passesExpBackoff(backoffStep, backoffMax)))
      .z((peers) =>
        // with 30% chance, ignore 'bestness' and just choose randomly
        Math.random() <= 0.3 ? shufflePeers(peers) : sortByStateChange(peers),
      )
      .z(take(freeSlots))
      .forEach(([addr, data]) => this.ssb.conn.connect(addr, data));
  }

  private updateStagingNow() {
    // Stage all db peers with autoconnect=false
    this.ssb.conn
      .query()
      .peersConnectable('db')
      .filter((p) => !this.weBlockThem(p))
      .filter(([, data]) => data.autoconnect === false)
      .forEach(([addr, data]) => this.ssb.conn.stage(addr, data));

    // Purge staged peers that are now blocked
    this.ssb.conn
      .query()
      .peersConnectable('staging')
      .filter(this.weBlockThem)
      .forEach(([addr]) => this.ssb.conn.unstage(addr));

    // Purge some old staged LAN peers
    this.ssb.conn
      .query()
      .peersConnectable('staging')
      .filter(([, data]) => data.type === 'lan')
      .filter(([, data]) => data.stagingUpdated! + 10e3 < Date.now())
      .forEach(([addr]) => this.ssb.conn.unstage(addr));

    // Purge some old staged Bluetooth peers
    this.ssb.conn
      .query()
      .peersConnectable('staging')
      .filter(([, data]) => data.type === 'bt')
      .filter(([, data]) => data.stagingUpdated! + 30e3 < Date.now())
      .forEach(([addr]) => this.ssb.conn.unstage(addr));
  }

  private updateHubNow() {
    const conn = this.ssb.conn;

    // If there are no peers, then try *any* connection ASAP
    if (conn.query().peersInConnection().length === 0) {
      this.updateTheseConnections(() => true, {
        quota: 1,
        backoffStep: 1e3,
        backoffMax: 6e3,
        groupMin: 0,
      });
    }

    // Connect to rooms, up to 5 of them
    this.updateTheseConnections((p) => p[1].type === 'room', {
      quota: 5,
      backoffStep: 5e3,
      backoffMax: 5 * MINUTES,
      groupMin: 5e3,
    });

    this.updateTheseConnections((p) => notRoom(p) && hasPinged(p), {
      quota: 2,
      backoffStep: 10e3,
      backoffMax: 10 * MINUTES,
      groupMin: 5e3,
    });

    this.updateTheseConnections((p) => notRoom(p) && hasNoAttempts(p), {
      quota: 2,
      backoffStep: 30e3,
      backoffMax: 30 * MINUTES,
      groupMin: 15e3,
    });

    this.updateTheseConnections((p) => notRoom(p) && hasOnlyFailedAttempts(p), {
      quota: 3,
      backoffStep: 1 * MINUTES,
      backoffMax: 3 * HOUR,
      groupMin: 5 * MINUTES,
    });

    this.updateTheseConnections((p) => notRoom(p) && isLegacy(p), {
      quota: 1,
      backoffStep: 4 * MINUTES,
      backoffMax: 3 * HOUR,
      groupMin: 5 * MINUTES,
    });

    // Automatically connect to some (up to 3) non-pub staged peers we follow
    z(
      conn
        .query()
        .peersConnectable('staging')
        .filter(this.weFollowThem)
        .filter(notPub),
    )
      .z(
        take(
          3 -
            conn
              .query()
              .peersInConnection()
              .filter(this.weFollowThem)
              .filter(notPub).length,
        ),
      )
      .forEach(([addr, data]) => conn.connect(addr, data));

    // Purge connected peers that are now blocked
    conn
      .query()
      .peersInConnection()
      .filter(this.weBlockThem)
      .forEach(([addr]) => conn.disconnect(addr));

    // Purge some ongoing frustrating connection attempts
    conn
      .query()
      .peersInConnection()
      .filter((p) => conn.hub().getState(p[0]) === 'connecting')
      .filter((p) => p[1].stateChange! + this.maxWaitToConnect(p) < Date.now())
      .forEach(([addr]) => conn.disconnect(addr));

    // Purge an internet connection after it has been up for half an hour
    conn
      .query()
      .peersConnected()
      .filter((p) => p[1].type !== 'bt' && p[1].type !== 'lan')
      .filter((p) => p[1].stateChange! + 0.5 * HOUR < Date.now())
      .forEach(([addr]) => conn.disconnect(addr));
  }

  private updateNow() {
    if (this.closed) return;
    if (this.isCurrentlyDownloading()) return;
    if (!this.loadedSocialGraph) return;

    this.updateStagingNow();
    this.updateHubNow();
  }

  private updateSoon(period: number = 1000) {
    if (this.closed) return;
    if (this.hasScheduledAnUpdate) return;

    // Add some time randomization to avoid deadlocks with remote peers
    const fuzzyPeriod = period * 0.5 + period * Math.random();
    this.hasScheduledAnUpdate = true;
    const timer = setTimeout(() => {
      this.updateNow();
      this.hasScheduledAnUpdate = false;
    }, fuzzyPeriod);
    if (timer.unref) timer.unref();
  }

  private removeDefunct(addr: string) {
    this.ssb.conn.db().update(addr, {defunct: void 0, autoconnect: void 0});
  }

  private setupPubDiscovery() {
    if (this.config.conn?.populatePubs === false) return;

    if (!this.ssb.db?.operators) {
      debug('Warning: ssb-db2 is missing, scheduling is degraded');
      return;
    }

    setTimeout(() => {
      if (this.closed) return;
      if (!this.ssb.db?.operators) return;
      type PubContent = {address?: string};
      const MAX_STAGED_PUBS = 3;
      const {where, type, live, toPullStream} = this.ssb.db.operators;
      this.pubDiscoveryPausable = this.pubDiscoveryPausable ?? Pausable();

      pull(
        this.ssb.db!.query(
          where(type('pub')),
          live({old: true}),
          toPullStream(),
        ),
        pull.filter((msg: Msg<PubContent>) =>
          Ref.isAddress(msg.value.content?.address),
        ),
        // Don't drain that fast, so to give other DB draining tasks priority
        pull.asyncMap((x: any, cb: any) => setTimeout(() => cb(null, x), 250)),
        this.pubDiscoveryPausable,
        pull.drain((msg: Msg<PubContent>) => {
          try {
            const address = Ref.toMultiServerAddress(msg.value.content.address);
            const key = Ref.getKeyFromAddress(address);
            if (this.weBlockThem([address, {key}])) {
              this.ssb.conn.forget(address);
            } else if (!this.ssb.conn.db().has(address)) {
              this.ssb.conn.stage(address, {key, type: 'pub'});
              this.ssb.conn.remember(address, {
                key,
                type: 'pub',
                autoconnect: false,
              });
            }
          } catch (err) {
            debug('cannot process discovered pub because: %s', err);
          }
        }),
      );

      // Pause or resume the draining depending on the number of staged pubs
      pull(
        this.ssb.conn.staging().liveEntries(),
        pull.drain((staged: Array<any>) => {
          if (this.closed) return;

          const stagedPubs = staged.filter(([, data]) => data.type === 'pub');
          if (stagedPubs.length >= MAX_STAGED_PUBS) {
            this.pubDiscoveryPausable?.pause();
          } else {
            this.pubDiscoveryPausable?.resume();
          }
        }),
      );
    }, 1000);
  }

  private setupBluetoothDiscovery() {
    if (!this.ssb.bluetooth?.nearbyScuttlebuttDevices) {
      debug('Warning: ssb-bluetooth is missing, scheduling is degraded');
      return;
    }

    pull(
      this.ssb.bluetooth.nearbyScuttlebuttDevices(1000),
      pull.drain(({discovered}: {discovered: Array<BTPeer>}) => {
        if (this.closed) return;

        for (const btPeer of discovered) {
          const address =
            `bt:${btPeer.remoteAddress.split(':').join('')}` +
            '~' +
            `shs:${btPeer.id.replace(/^\@/, '').replace(/\.ed25519$/, '')}`;
          const data: Partial<StagedData> = {
            type: 'bt',
            note: btPeer.displayName,
            key: btPeer.id,
          };
          if (this.weFollowThem([address, data])) {
            this.ssb.conn.connect(address, data);
          } else {
            this.ssb.conn.stage(address, data);
          }
        }
      }),
    );
  }

  private setupLanDiscovery() {
    if (!this.ssb.lan?.start || !this.ssb.lan?.discoveredPeers) {
      debug('Warning: ssb-lan is missing, scheduling is degraded');
      return;
    }

    pull(
      this.ssb.lan.discoveredPeers(),
      pull.drain(({address, verified}: LANDiscovery) => {
        const key: FeedId | undefined = Ref.getKeyFromAddress(address);
        if (!key) return;
        const data: Partial<StagedData> = {
          type: 'lan',
          key,
          verified,
        };
        if (this.weFollowThem([address, data])) {
          this.ssb.conn.connect(address, data);
        } else {
          this.ssb.conn.stage(address, data);
        }
      }),
    );

    this.ssb.lan.start();
  }

  @muxrpc('sync')
  public start = () => {
    if (!this.closed) return;
    this.closed = false;

    // Upon init, purge some undesired DB entries
    for (let peer of this.ssb.conn.dbPeers()) {
      const [address, {source, type}] = peer;
      if (
        source === 'local' ||
        source === 'bt' ||
        type === 'lan' ||
        type === 'bt'
      ) {
        this.ssb.conn.forget(address);
      }
      if (isDefunct(peer)) {
        this.removeDefunct(address);
      }
    }

    this.ssbDB2Subscription = this.ssb.db?.post((msg: Msg) => {
      if (msg.value.author !== this.ssb.id) {
        this.lastMessageAt = Date.now();
      }
    });

    // Upon init, load some follow-and-blocks data
    this.loadSocialGraph();

    // Upon init, setup discovery via various modes
    this.setupPubDiscovery();
    this.setupLanDiscovery();
    this.setupBluetoothDiscovery();

    // Upon regular time intervals, attempt to make connections
    this.intervalForUpdate = setInterval(() => this.updateSoon(), 2e3);
    if (this.intervalForUpdate?.unref) this.intervalForUpdate.unref();

    // Upon wakeup, trigger hard reconnect
    onWakeup(() => {
      if (this.closed) return;
      this.ssb.conn.hub().reset();
    });

    // Upon network changes, trigger hard reconnect
    onNetwork(() => {
      if (this.closed) return;
      this.ssb.conn.hub().reset();
    });

    // Upon some disconnection, attempt to make connections
    pull(
      this.ssb.conn.hub().listen(),
      pull.filter((ev: HubEvent) => ev.type === 'disconnected'),
      pull.drain(() => this.updateSoon(200)),
    );

    // Upon init, attempt to make some connections
    this.updateNow();
  };

  @muxrpc('sync')
  public stop = () => {
    this.pubDiscoveryPausable?.pause();
    this.ssb.lan?.stop();
    this.ssbDB2Subscription?.();
    if (this.intervalForUpdate) {
      clearInterval(this.intervalForUpdate);
      this.intervalForUpdate = void 0;
    }
    this.ssb.conn.hub().reset();
    this.closed = true;
  };
}
