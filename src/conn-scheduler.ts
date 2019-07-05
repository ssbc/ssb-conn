import ConnDB = require('ssb-conn-db');
import ConnHub = require('ssb-conn-hub');
import ConnQuery = require('ssb-conn-query');
import {ListenEvent as HubEvent} from 'ssb-conn-hub/lib/types';
import {Peer} from 'ssb-conn-query/lib/types';
import {Msg, FeedId} from 'ssb-typescript';
import {plugin, muxrpc} from 'secret-stack-decorators';
import {CONN} from './conn';
const pull = require('pull-stream');
const ip = require('ip');
const onWakeup = require('on-wakeup');
const onNetwork = require('on-change-network');
const hasNetwork = require('has-network');
const ref = require('ssb-ref');
const debug = require('debug')('ssb:conn:scheduler');
require('zii');

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

function isLocal(p: Peer): boolean {
  // don't rely on private ip address, because
  // cjdns creates fake private ip addresses.
  // ignore localhost addresses, because sometimes they get broadcast.
  return (
    !ip.isLoopback(p[1].host) &&
    ip.isPrivate(p[1].host) &&
    (p[1].source === 'local' || p[1].type === 'lan')
  );
}

//peers which we can connect to, but are not upgraded.
//select peers which we can connect to, but are not upgraded to LT.
//assume any peer is legacy, until we know otherwise...
function isLegacy(peer: Peer): boolean {
  return hasSuccessfulAttempts(peer) && !hasPinged(peer);
}

function take(n: number) {
  return <T>(arr: Array<T>) => arr.slice(0, Math.max(n, 0));
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

const minute = 60e3;
const hour = 60 * 60e3;

type BTPeer = {remoteAddress: string; id: string; displayName: string};

@plugin('1.0.0')
export class ConnScheduler {
  private ssb: any;
  private config: any;
  private db: ConnDB;
  private hub: ConnHub;
  private query: ConnQuery;
  private closed: boolean;
  private lastMessageAt: number;
  private hasScheduledAnUpdate: boolean;
  private hops: Record<FeedId, number>;

  constructor(ssb: any, config: any) {
    this.ssb = ssb;
    this.config = config;
    this.db = this.ssb.conn.internalConnDb();
    this.hub = this.ssb.conn.internalConnHub();
    this.query = this.ssb.conn.internalConnQuery();
    this.closed = true;
    this.lastMessageAt = 0;
    this.hasScheduledAnUpdate = false;
    this.hops = {};

    this.ssb.post((msg: Msg) => {
      if (msg.value.author != this.ssb.id) {
        this.lastMessageAt = Date.now();
      }
      if (msg.value.content && msg.value.content.type === 'contact') {
        this.updateHops();
      }
    });
  }

  private updateHops() {
    if (this.ssb.friends && this.ssb.friends.hops) {
      this.ssb.friends.hops((err: any, hops: Record<FeedId, number>) => {
        if (err) {
          debug('unable to call ssb.friends.hops: %s', err);
          return;
        }
        this.hops = hops;
      });
    }
  }

  // Utility to pick from config, with some defaults
  private conf(name: any, def: any) {
    if (this.config.gossip == null) return def;
    const value = this.config.gossip[name];
    return value == null || value === '' ? def : value;
  }

  private isCurrentlyDownloading() {
    // don't schedule gossip if currently downloading messages
    return this.lastMessageAt && this.lastMessageAt > Date.now() - 500;
  }

  private weBlockThem([_addr, data]: Peer) {
    if (!data || !data.key) return false;
    return this.hops[data.key] === -1;
  }

  private weFollowThem([_addr, data]: Peer) {
    if (!data || !data.key) return false;
    return this.hops[data.key] > 0;
  }

  // Utility to connect to bunch of peers, or disconnect if over quota
  // opts: { quota, backoffStep, backoffMax, groupMin }
  private updateTheseConnections(test: (p: Peer) => boolean, opts: any) {
    const peersUp = this.query.peersInConnection().filter(test);
    const peersDown = this.query.peersConnectable('db').filter(test);
    const {quota, backoffStep, backoffMax, groupMin} = opts;
    const excess = peersUp.length > quota * 2 ? peersUp.length - quota : 0;
    const freeSlots = Math.max(quota - peersUp.length, 0);

    // Disconnect from excess
    peersUp
      .z(sortByStateChange)
      .z(take(excess))
      .forEach(([addr]) => this.hub.disconnect(addr));

    // Connect to suitable candidates
    peersDown
      .filter(p => !this.weBlockThem(p))
      .filter(canBeConnected)
      .z(passesGroupDebounce(groupMin))
      .filter(passesExpBackoff(backoffStep, backoffMax))
      .z(sortByStateChange)
      .z(take(freeSlots))
      .forEach(([addr, peer]) => this.hub.connect(addr, peer));
  }

  private updateConnectionsNow() {
    // Respect some limits: don't attempt to connect while migration is running
    if (!this.ssb.ready() || this.isCurrentlyDownloading()) return;

    if (this.conf('seed', true)) {
      this.updateTheseConnections(p => p[1].source === 'seed', {
        quota: 3,
        backoffStep: 2e3,
        backoffMax: 10 * minute,
        groupMin: 1e3,
      });
    }

    this.updateTheseConnections(hasPinged, {
      quota: 2,
      backoffStep: 10e3,
      backoffMax: 10 * minute,
      groupMin: 5e3,
    });

    this.updateTheseConnections(hasNoAttempts, {
      quota: 2,
      backoffStep: 30e3,
      backoffMax: 30 * minute,
      groupMin: 15e3,
    });

    this.updateTheseConnections(hasOnlyFailedAttempts, {
      quota: 3,
      backoffStep: 1 * minute,
      backoffMax: 3 * hour,
      groupMin: 5 * minute,
    });

    this.updateTheseConnections(isLegacy, {
      quota: 1,
      backoffStep: 4 * minute,
      backoffMax: 3 * hour,
      groupMin: 5 * minute,
    });

    // Automatically connect to (five) staged peers we follow
    this.query
      .peersConnectable('staging')
      .filter(p => this.weFollowThem(p))
      .z(take(5))
      .forEach(([addr, data]) => this.hub.connect(addr, data));

    // Purge connected peers that are now blocked
    this.query
      .peersInConnection()
      .filter(p => this.weBlockThem(p))
      .forEach(([addr]) => this.hub.disconnect(addr));

    // Purge some old staged LAN peers
    this.query
      .peersConnectable('staging')
      .filter(staged => staged[1].type === 'lan')
      .filter(staged => staged[1].stagingUpdated! + 20e3 < Date.now())
      .forEach(([addr]) => (this.ssb.conn as CONN).unstage(addr));

    // Purge some old staged Bluetooth peers
    this.query
      .peersConnectable('staging')
      .filter(staged => staged[1].type === 'bt')
      .filter(staged => staged[1].stagingUpdated! + 30e3 < Date.now())
      .forEach(([addr]) => (this.ssb.conn as CONN).unstage(addr));

    // Purge some ongoing frustrating connection attempts
    this.query
      .peersInConnection()
      .filter(peer => {
        const permanent = hasPinged(peer) || isLocal(peer);
        return !permanent || this.hub.getState(peer[0]) === 'connecting';
      })
      .filter(peer => peer[1].stateChange! + 10e3 < Date.now())
      .forEach(([addr]) => this.hub.disconnect(addr));
  }

  private updateConnectionsSoon() {
    if (this.closed) return;
    if (this.hasScheduledAnUpdate) return;
    this.hasScheduledAnUpdate = true;
    // Add some time randomization to avoid deadlocks with remote peers
    const timer = setTimeout(() => {
      this.updateConnectionsNow();
      this.hasScheduledAnUpdate = false;
    }, 1000 * Math.random());
    if (timer.unref) timer.unref();
  }

  private populateWithSeeds() {
    // Populate gossip table with configured seeds (mainly used in testing)
    const seeds = this.config.seeds;
    (Array.isArray(seeds) ? seeds : [seeds]).filter(Boolean).forEach(addr => {
      this.ssb.gossip.add(addr, 'seed');
    });
  }

  private setupPubDiscovery() {
    // Populate gossip table with pub announcements on the feed
    // (allow this to be disabled via config)
    if (
      !this.config.gossip ||
      (this.config.gossip.autoPopulate !== false &&
        this.config.gossip.pub !== false)
    ) {
      type PubContent = {address?: string};
      pull(
        this.ssb.messagesByType({type: 'pub', live: true, keys: false}),
        pull.filter((msg: any) => !msg.sync),
        pull.filter(
          (msg: Msg<PubContent>['value']) =>
            msg.content &&
            msg.content.address &&
            ref.isAddress(msg.content.address),
        ),
        pull.drain(
          (msg: Msg<PubContent>['value']) => {
            this.ssb.gossip.add(msg.content.address, 'pub');
          },
          (...args: Array<any>) => {
            console.warn(
              '[gossip] warning: this can happen if the database closes',
              args,
            );
          },
        ),
      );
    }
  }

  private setupBluetoothDiscovery() {
    if (this.ssb.bluetooth && this.ssb.bluetooth.nearbyScuttlebuttDevices) {
      pull(
        this.ssb.bluetooth.nearbyScuttlebuttDevices(1000),
        pull.drain(({discovered}: {discovered: Array<BTPeer>}) => {
          for (const btPeer of discovered) {
            const address =
              `bt:${btPeer.remoteAddress.split(':').join('')}` +
              '~' +
              `shs:${btPeer.id.replace(/^\@/, '').replace(/\.ed25519$/, '')}`;

            (this.ssb.conn as CONN).stage(address, {
              type: 'bt',
              note: btPeer.displayName,
              key: btPeer.id,
            });
          }
        }),
      );
    }
  }

  @muxrpc('sync')
  public start = () => {
    if (!this.closed) return;
    this.closed = false;

    // Upon init, load some follow-and-blocks data
    this.updateHops();

    // Upon init, purge some undesired DB entries
    for (let [address, {source, type}] of this.db.entries()) {
      if (
        source === 'local' ||
        source === 'bt' ||
        type === 'lan' ||
        type === 'bt'
      ) {
        (this.ssb.conn as CONN).forget(address);
      }
    }

    // Upon init, attempt to make some connections
    this.updateConnectionsSoon();

    // Upon regular time intervals, attempt to make connections
    const int = setInterval(() => this.updateConnectionsSoon(), 2e3);
    if (int.unref) int.unref();

    // Upon wakeup, trigger hard reconnect
    onWakeup(() => this.hub.reset());

    // Upon network changes, trigger hard reconnect
    onNetwork(() => this.hub.reset());

    // Upon some disconnection, attempt to make connections
    pull(
      this.hub.listen(),
      pull.filter((ev: HubEvent) => ev.type === 'disconnected'),
      pull.drain(
        () => this.updateConnectionsSoon(),
        (...args: Array<any>) =>
          console.warn(
            '[gossip/dc] warning: this can happen if the database closes',
            args,
          ),
      ),
    );

    // Upon init, populate with seeds
    this.populateWithSeeds();

    // Upon init, setup discovery via various modes
    this.setupPubDiscovery();
    this.setupBluetoothDiscovery();
  };

  @muxrpc('sync')
  public stop = () => {
    this.hub.reset();
    this.closed = true;
  };
}
