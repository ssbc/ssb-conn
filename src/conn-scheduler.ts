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
import {CONN} from './conn';
import {Config} from './types';

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
  | 'room-endpoint'
  | '?';

function detectType(peer: Peer): Type {
  const [addr, data] = peer;
  if (data.type === 'bt') return 'bt';
  if (data.type === 'lan') return 'lan';
  if (data.type === 'internet') return 'internet';
  if (data.type === 'dht') return 'dht';
  if (data.type === 'pub') return 'pub';
  if (data.type === 'room') return 'room';
  if (data.type === 'room-endpoint') return 'room-endpoint';
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

function shufflePeers(peers: Array<Peer>) {
  return peers.sort(() => Math.random() - 0.5);
}

const minute = 60e3;
const hour = 60 * 60e3;

type BTPeer = {remoteAddress: string; id: string; displayName: string};

type Pausable = {pause: CallableFunction; resume: CallableFunction};

@plugin('1.0.0')
export class ConnScheduler {
  private readonly ssb: {conn: CONN; [name: string]: any};
  private readonly config: Config;
  private readonly hasSsbDb2: boolean;
  private pubDiscoveryPausable?: Pausable;
  private intervalForUpdate?: NodeJS.Timeout;
  private closed: boolean;
  private isLoadingHops: boolean;
  private lastMessageAt: number;
  private hasScheduledAnUpdate: boolean;
  private hops: Record<FeedId, number>;

  constructor(ssb: any, config: any) {
    this.ssb = ssb;
    this.config = config;
    this.hasSsbDb2 = !!this.ssb.db?.post && !!this.ssb.db?.query;
    this.closed = true;
    this.lastMessageAt = 0;
    this.hasScheduledAnUpdate = false;
    this.isLoadingHops = false;
    this.hops = {};

    if (this.hasSsbDb2) {
      this.ssb.db.post((msg: Msg) => {
        if (msg.value.author !== this.ssb.id) {
          this.lastMessageAt = Date.now();
        }
        if (msg.value.content?.type === 'contact') {
          this.loadHops(() => this.updateNow());
        }
      });
    }
  }

  private loadHops(doneCallback?: () => void) {
    if (!this.ssb.friends?.hops) {
      debug('Warning: ssb-friends is missing, scheduling will miss some info');
      return;
    }

    this.isLoadingHops = true;
    this.ssb.friends.hops((err: any, hops: Record<FeedId, number>) => {
      if (err) {
        debug('unable to call ssb.friends.hops: %s', err);
        return;
      }
      this.hops = hops;
      this.isLoadingHops = false;
      if (doneCallback) doneCallback();
    });
  }

  private isCurrentlyDownloading() {
    // don't schedule new connections if currently downloading messages
    return this.lastMessageAt && this.lastMessageAt > Date.now() - 500;
  }

  private weBlockThem = ([_addr, data]: [string, {key?: string}]) => {
    if (!data?.key) return false;
    return this.hops[data.key] === -1;
  };

  private weFollowThem = ([_addr, data]: [string, {key?: string}]) => {
    if (!data?.key) return false;
    const h = this.hops[data.key];

    // Only connect to feeds we follow unless `config.conn.hops` is set.
    const maxHops = this.config.conn?.hops ?? 1;
    return h > 0 && h <= maxHops;
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
    const peersUp = query.peersInConnection().filter(test);
    const peersDown = query.peersConnectable('db').filter(test);
    const {quota, backoffStep, backoffMax, groupMin} = opts;
    const excess = peersUp.length > quota * 2 ? peersUp.length - quota : 0;
    const freeSlots = Math.max(quota - peersUp.length, 0);

    // Disconnect from excess, after some long and random delay
    z(peersUp)
      .z(sortByStateChange)
      .z(take(excess))
      .forEach(([addr]) => {
        // Wait 2min, with +-50% randomization, but the more excess peers
        // there are, the smaller wait we'll have
        const fuzzyPeriod = (120e3 * (0.5 + Math.random())) / excess;
        setTimeout(() => {
          this.ssb.conn.disconnect(addr);
        }, fuzzyPeriod);
      });

    // Connect to suitable candidates
    z(peersDown)
      .z(peers => peers.filter(p => !this.weBlockThem(p)))
      .z(peers => peers.filter(canBeConnected))
      .z(peers => peers.filter(([, data]) => data.autoconnect !== false))
      .z(passesGroupDebounce(groupMin))
      .z(peers => peers.filter(passesExpBackoff(backoffStep, backoffMax)))
      .z(peers =>
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
      .filter(p => !this.weBlockThem(p))
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

    if (this.config.seed ?? true) {
      this.updateTheseConnections(p => p[1].source === 'seed', {
        quota: 3,
        backoffStep: 2e3,
        backoffMax: 10 * minute,
        groupMin: 1e3,
      });
    }

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
    this.updateTheseConnections(p => p[1].type === 'room', {
      quota: 5,
      backoffStep: 5e3,
      backoffMax: 5 * minute,
      groupMin: 5e3,
    });

    this.updateTheseConnections(p => notRoom(p) && hasPinged(p), {
      quota: 2,
      backoffStep: 10e3,
      backoffMax: 10 * minute,
      groupMin: 5e3,
    });

    this.updateTheseConnections(p => notRoom(p) && hasNoAttempts(p), {
      quota: 2,
      backoffStep: 30e3,
      backoffMax: 30 * minute,
      groupMin: 15e3,
    });

    this.updateTheseConnections(p => notRoom(p) && hasOnlyFailedAttempts(p), {
      quota: 3,
      backoffStep: 1 * minute,
      backoffMax: 3 * hour,
      groupMin: 5 * minute,
    });

    this.updateTheseConnections(p => notRoom(p) && isLegacy(p), {
      quota: 1,
      backoffStep: 4 * minute,
      backoffMax: 3 * hour,
      groupMin: 5 * minute,
    });

    // Automatically connect to some (up to 3) staged peers we follow
    z(conn.query().peersConnectable('staging').filter(this.weFollowThem))
      .z(
        take(
          3 - conn.query().peersInConnection().filter(this.weFollowThem).length,
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
      .filter(p => conn.hub().getState(p[0]) === 'connecting')
      .filter(p => p[1].stateChange! + this.maxWaitToConnect(p) < Date.now())
      .forEach(([addr]) => conn.disconnect(addr));

    // Purge an internet connection after it has been up for half an hour
    conn
      .query()
      .peersConnected()
      .filter(p => p[1].type !== 'bt' && p[1].type !== 'lan')
      .filter(p => p[1].stateChange! + 0.5 * hour < Date.now())
      .forEach(([addr]) => conn.disconnect(addr));
  }

  private updateNow() {
    if (this.closed) return;
    if (this.isCurrentlyDownloading()) return;
    if (this.isLoadingHops) return;

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

  private populateWithSeeds() {
    // Populate connDB with configured seeds (mainly used in testing)
    const seeds = this.config.seeds ?? [];
    (Array.isArray(seeds) ? seeds : [seeds]).filter(Boolean).forEach(addr => {
      const key = Ref.getKeyFromAddress(addr);
      this.ssb.conn.remember(addr, {key, source: 'seed'});
    });
  }

  private setupPubDiscovery() {
    if (this.config.conn?.populatePubs === false) return;

    if (!this.hasSsbDb2) {
      debug('Warning: ssb-db2 is missing, scheduling will miss some info');
      return;
    }

    setTimeout(() => {
      if (this.closed) return;
      type PubContent = {address?: string};
      const MAX_STAGED_PUBS = 3;
      const {where, type, live, toPullStream} = this.ssb.db.operators;
      this.pubDiscoveryPausable = this.pubDiscoveryPausable ?? Pausable();

      pull(
        this.ssb.db.query(
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
      debug(
        'Warning: ssb-bluetooth is missing, scheduling will miss some info',
      );
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
      debug('Warning: ssb-lan is missing, scheduling will miss some info');
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

    // Upon init, load some follow-and-blocks data
    this.loadHops();

    // Upon init, populate with seeds
    this.populateWithSeeds();

    // Upon init, setup discovery via various modes
    this.setupPubDiscovery();
    this.pubDiscoveryPausable?.resume();
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
    this.updateSoon();
  };

  @muxrpc('sync')
  public stop = () => {
    this.pubDiscoveryPausable?.pause();
    this.ssb.lan?.stop?.();
    if (this.intervalForUpdate) {
      clearInterval(this.intervalForUpdate);
      this.intervalForUpdate = void 0;
    }
    this.ssb.conn.hub().reset();
    this.closed = true;
  };
}
