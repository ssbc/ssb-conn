import z = require('ziii');
import {Msg, FeedId} from 'ssb-typescript';
import {plugin, muxrpc} from 'secret-stack-decorators';
import {AddressData as DBData} from 'ssb-conn-db/lib/types';
import {ListenEvent as HubEvent} from 'ssb-conn-hub/lib/types';
import {StagedData} from 'ssb-conn-staging/lib/types';
import {Discovery as LANDiscovery} from 'ssb-lan/lib/types';
import {Peer} from 'ssb-conn-query/lib/types';
import ConnQuery = require('ssb-conn-query');
const {hasNoAttempts, hasOnlyFailedAttempts} = ConnQuery;
const pull = require('pull-stream');
const Pausable = require('pull-pause');
const ip = require('ip');
const onWakeup = require('on-wakeup');
const onNetwork = require('on-change-network-strict');
const hasNetworkRightNow = require('has-network2');
const Ref = require('ssb-ref');
const debug = require('debug')('ssb:conn:scheduler');
import {Config, SSB} from './types';

const SECONDS = 1e3;
const MINUTES = 60e3;
const HOUR = 60 * 60e3;

let lastCheck = 0;
let lastValue: any = null;
function hasNetwork() {
  if (lastCheck + 1e3 < Date.now()) {
    lastCheck = Date.now();
    lastValue = hasNetworkRightNow();
  }
  return lastValue;
}

function take(n: number) {
  return <T>(arr: Array<T>) => arr.slice(0, Math.max(n, 0));
}

function filter(condition: (peer: Peer) => boolean) {
  return (arr: Array<Peer>) => arr.filter(condition);
}

type Type =
  | 'bt'
  | 'lan'
  | 'internet'
  | 'dht'
  | 'pub'
  | 'room'
  | 'room-attendant-alias'
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
  if (data.type === 'room-endpoint' || data.type === 'room-attendant') {
    if (data.alias) return 'room-attendant-alias';
    else return 'room-attendant'; // legacy
  }
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

const isNotLocalhost = (p: Peer) =>
  !ip.isLoopback(p[1].host) && p[1].host !== 'localhost';

function isNotRoom(peer: Peer): boolean {
  return peer[1].type !== 'room';
}

function isRoom(peer: Peer): boolean {
  return peer[1].type === 'room';
}

function isDefunct(peer: Peer | [string, DBData]): boolean {
  return peer[1].defunct === true;
}

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

function calculateCooldown(
  fullPercent: number,
  hops: Record<FeedId, number | undefined>,
) {
  return (peers: Array<Peer>) => {
    return peers.map((peer) => {
      const [, data] = peer;
      const peerType = detectType(peer);

      // 10% is considered the smallest measurement of full
      const normalizedFullPercent = Math.max(0.1, fullPercent);

      // The larger the hop, the longer the cooldown. Handle special cases too
      const hop = hops[data.key!];
      const hopsCooldown =
        peerType === 'room' // room is always considered at a constant distance
          ? 1 * SECONDS
          : hop === -1
          ? Infinity
          : hop === null || hop === void 0
          ? 30 * SECONDS
          : hop < 0
          ? -hop * 5 * SECONDS
          : hop * SECONDS;

      // The more connection failures happened, the longer the cooldown is
      const retryCooldown =
        4 * SECONDS + Math.min(64, data.failure || 0) ** 3 * 10 * SECONDS;

      // Sum the two together
      let cooldown = (hopsCooldown + retryCooldown) * normalizedFullPercent;

      // Make the cooldown shorter if the peer is new
      if (hasNoAttempts(peer)) cooldown *= 0.5;
      // Make the cooldown shorter randomly sometimes, to encourage exploration
      if (Math.random() < 0.3) cooldown *= 0.5;
      // Make the cooldown shorter for some special types of peers:
      if (peerType === 'lan') cooldown *= 0.7;
      if (peerType === 'room-attendant') cooldown *= 0.8;
      // Make the cooldown longer if the peer has problems
      if (hasOnlyFailedAttempts(peer)) cooldown *= 3;

      data.cooldown = cooldown;
      return peer;
    });
  };
}

function cooledDownEnough(peer: Peer) {
  const [, data] = peer;
  const lastAttempt =
    data.latestConnection ?? data.stateChange ?? data.hubUpdated ?? 0;
  if (data.cooldown === undefined) return true;
  return Date.now() > lastAttempt + data.cooldown;
}

function sortByCooldownAscending(peers: Array<Peer>) {
  return peers.sort((a, b) => {
    const [, aData] = a;
    const [, bData] = b;
    if (aData.cooldown === undefined) return 1;
    if (bData.cooldown === undefined) return -1;
    return aData.cooldown! - bData.cooldown!;
  });
}

@plugin('1.0.0')
export class ConnScheduler {
  private readonly ssb: SSB;
  private readonly config: Config;
  private pubDiscoveryPausable?: {
    pause: CallableFunction;
    resume: CallableFunction;
  };
  private intervalForUpdate?: NodeJS.Timeout;
  private ssbDB2Subscription?: CallableFunction | undefined;
  private closed: boolean;
  private loadedHops: boolean;
  private lastMessageAt: number;
  private hasScheduledAnUpdate: boolean;
  private hops: Record<FeedId, number>;

  constructor(ssb: any, config: any) {
    this.ssb = ssb;
    this.config = config;
    this.closed = true;
    this.lastMessageAt = 0;
    this.hasScheduledAnUpdate = false;
    this.loadedHops = false;
    this.hops = {};
  }

  private loadSocialGraph() {
    if (!this.ssb.friends?.hopStream) {
      debug('Warning: ssb-friends@5 is missing, scheduling is degraded');
      this.loadedHops = true;
      return;
    }

    pull(
      this.ssb.friends?.hopStream({live: true, old: true}),
      pull.drain((h: Record<FeedId, number>) => {
        this.hops = {...this.hops, ...h};
        this.loadedHops = true;
      }),
    );
  }

  private isCurrentlyDownloading() {
    // don't schedule new connections if currently downloading messages
    return this.lastMessageAt && this.lastMessageAt > Date.now() - 500;
  }

  private isBlocked = (peer: [Peer[0], Pick<Peer[1], 'key'>]) => {
    const [, data] = peer;
    if (!data?.key) return false;
    return this.hops[data.key] === -1;
  };

  private isNotBlocked = (peer: [Peer[0], Pick<Peer[1], 'key'>]) => {
    return !this.isBlocked(peer);
  };

  private maxWaitToConnect(peer: Peer): number {
    const type = detectType(peer);
    switch (type) {
      case 'lan':
        return 30e3;

      case 'room-attendant-alias':
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
  private updateTheseConnections(
    pool: Parameters<ConnQuery['peersConnectable']>[0],
    test: (p: Peer) => boolean,
    quota: number,
  ) {
    const query = this.ssb.conn.query();
    const peersUp = query.peersConnected().filter(test);
    const peersDown = query.peersConnectable(pool).filter(test);
    const excess = peersUp.length > quota * 2 ? peersUp.length - quota : 0;
    const freeSlots = Math.max(quota - peersUp.length, 0);
    const fullPercent = 1 - freeSlots / quota;

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
      .z(filter(this.isNotBlocked))
      .z(filter(isNotLocalhost))
      .z(filter(([, data]) => data.autoconnect !== false))
      .z(calculateCooldown(fullPercent, this.hops))
      .z(filter(cooledDownEnough))
      .z(sortByCooldownAscending)
      .z(take(freeSlots))
      .forEach(([addr, data]) => this.ssb.conn.connect(addr, data));
  }

  private updateStagingNow() {
    // Stage all db peers with autoconnect=false
    this.ssb.conn
      .query()
      .peersConnectable('db')
      .filter(this.isNotBlocked)
      .filter(([, data]) => data.autoconnect === false)
      .forEach(([addr, data]) => this.ssb.conn.stage(addr, data));

    // Purge staged peers that are now blocked
    this.ssb.conn
      .query()
      .peersConnectable('staging')
      .filter(this.isBlocked)
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

    this.updateTheseConnections('db', isRoom, 5);

    this.updateTheseConnections('dbAndStaging', isNotRoom, 4);

    // Purge connected peers that are now blocked
    conn
      .query()
      .peersInConnection()
      .filter(this.isBlocked)
      .forEach(([addr]) => conn.disconnect(addr));

    // Purge some ongoing frustrating connection attempts
    conn
      .query()
      .peersInConnection()
      .filter((p) => conn.hub().getState(p[0]) === 'connecting')
      .filter((p) => p[1].stateChange! + this.maxWaitToConnect(p) < Date.now())
      .forEach(([addr]) => conn.disconnect(addr));

    // Purge empty rooms if there are other rooms to try.
    // The more there are other rooms to try, the shorter the grace period.
    const otherRooms = conn.query().peersConnectable('db').filter(isRoom);
    if (otherRooms.length > 0) {
      const GRACE_PERIOD = (1.5 * MINUTES) / otherRooms.length;
      conn
        .query()
        .peersConnected()
        .filter(isRoom)
        .filter(
          ([, data]) =>
            data.onlineCount === 0 &&
            data.hubUpdated! + GRACE_PERIOD < Date.now(),
        )
        .forEach(([addr]) => conn.disconnect(addr));
    }

    // Purge non-room connections to create rotation for others.
    // The more staged peers there are available, the shorter the grace period.
    const staged = conn.query().peersConnectable('staging');
    if (staged.length > 0) {
      const GRACE_PERIOD = (3 * HOUR) / staged.length;
      conn
        .query()
        .peersConnected()
        .filter(isNotRoom)
        .filter((p) => p[1].stateChange! + GRACE_PERIOD < Date.now())
        .forEach(([addr]) => conn.disconnect(addr));
    }
  }

  private updateNow() {
    if (this.closed) return;
    if (this.isCurrentlyDownloading()) return;
    if (!this.loadedHops) return;
    if (!hasNetwork()) return;

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

    const timer = setTimeout(() => {
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
            if (this.isBlocked([address, {key}])) {
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
    timer?.unref?.();
  }

  private setupBluetoothDiscovery() {
    if (!this.ssb.bluetooth?.nearbyScuttlebuttDevices) {
      debug('Warning: ssb-bluetooth is missing, scheduling is degraded');
      return;
    }

    interface BTPeer {
      remoteAddress: string;
      id: string;
      displayName: string;
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
          if (this.isNotBlocked([address, data])) {
            this.ssb.conn.stage(address, data);
            this.updateSoon(100);
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
        if (this.isNotBlocked([address, data])) {
          this.ssb.conn.stage(address, data);
          this.updateSoon(100);
        }
      }),
    );

    this.ssb.lan.start();
  }

  private cleanUpDB() {
    const roomsWithMembership = new Set();

    for (let peer of this.ssb.conn.dbPeers()) {
      const [address, {source, type, membership}] = peer;
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
      if (type === 'room' && membership) {
        roomsWithMembership.add(address);
      }
    }

    // Remove "room attendant aliases" that are in rooms where I'm a member
    for (let [address, data] of this.ssb.conn.dbPeers()) {
      if (data.type === 'room-endpoint' || data.type === 'room-attendant') {
        if (
          data.alias &&
          data.roomAddress &&
          roomsWithMembership.has(data.roomAddress)
        ) {
          this.ssb.conn.forget(address);
        }
      }
    }
  }

  @muxrpc('sync')
  public start = () => {
    if (!this.closed) return;
    this.closed = false;

    // Upon init, purge some undesired DB entries
    this.cleanUpDB();

    this.ssbDB2Subscription = this.ssb.db?.post((msg: Msg) => {
      if (msg.value.author !== this.ssb.id) {
        this.lastMessageAt = Date.now();
      }
    });

    // Upon init, load some follow and block data
    this.loadSocialGraph();

    // Upon init, setup discovery via various modes
    this.setupPubDiscovery();
    this.setupLanDiscovery();
    this.setupBluetoothDiscovery();

    // Upon regular time intervals, attempt to make connections
    this.intervalForUpdate = setInterval(() => this.updateSoon(), 2e3);
    this.intervalForUpdate?.unref?.();

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
