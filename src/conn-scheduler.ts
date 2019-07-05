import ConnDB = require('ssb-conn-db');
import ConnHub = require('ssb-conn-hub');
import ConnQuery = require('ssb-conn-query');
import {ListenEvent as HubEvent} from 'ssb-conn-hub/lib/types';
import {Peer} from 'ssb-conn-query/lib/types';
import {Msg} from 'ssb-typescript';
import {plugin, muxrpc} from 'secret-stack-decorators';
const pull = require('pull-stream');
const ip = require('ip');
const onWakeup = require('on-wakeup');
const onNetwork = require('on-change-network');
const hasNetwork = require('has-network');
const ref = require('ssb-ref');
require('zii');

function noop() {}

function not(fn: Function) {
  return function(e: any) {
    return !fn(e);
  };
}

function and(...args: Array<any>) {
  return (value: any) => args.every((fn: Function) => fn.call(null, value));
}

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

function notBluetooth(p: Peer) {
  return !p[0].startsWith('bt:');
}

const canBeConnected = not(isOffline);

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

function isFriend(p: Peer): boolean {
  return p[1].source === 'friends';
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

  constructor(ssb: any, config: any) {
    this.ssb = ssb;
    this.config = config;
    this.db = this.ssb.conn.internalConnDb();
    this.hub = this.ssb.conn.internalConnHub();
    this.query = this.ssb.conn.internalConnQuery();
    this.closed = true;
    this.lastMessageAt = 0;
    this.hasScheduledAnUpdate = false;

    this.ssb.post((msg: Msg) => {
      if (msg.value.author != this.ssb.id) {
        this.lastMessageAt = Date.now();
      }
    });
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

  // Utility to connect to bunch of peers, or disconnect if over quota
  // opts: { quota, backoffStep, backoffMax, groupMin }
  private updateTheseConnections(test: (p: Peer) => boolean, opts: any) {
    const peersUp = this.query.peersInConnection().filter(test);
    const peersDown = this.query.peersConnectable('dbAndStaging').filter(test);
    const {quota, backoffStep, backoffMax, groupMin} = opts;
    const excess = peersUp.length > quota * 2 ? peersUp.length - quota : 0;
    const freeSlots = Math.max(quota - peersUp.length, 0);

    // Disconnect from excess
    peersUp
      .filter(notBluetooth)
      .z(sortByStateChange)
      .z(take(excess))
      .forEach(([addr]) => this.hub.disconnect(addr).then(noop, noop));

    // Connect to suitable candidates
    peersDown
      .filter(notBluetooth)
      .filter(canBeConnected)
      .z(passesGroupDebounce(groupMin))
      .filter(passesExpBackoff(backoffStep, backoffMax))
      .z(sortByStateChange)
      .z(take(freeSlots))
      .forEach(([addr, peer]) => this.hub.connect(addr, peer).then(noop, noop));
  }

  private updateConnectionsNow() {
    // Respect some limits: don't attempt to connect while migration is running
    if (!this.ssb.ready() || this.isCurrentlyDownloading()) return;

    const numOfConnectedRemoteNonFriends = this.query
      .peersInConnection()
      .filter(and(not(isLocal), not(isFriend))).length;

    const numOfConnectedFriends = this.query
      .peersInConnection()
      .filter(isFriend).length;

    if (this.conf('friends', true))
      this.updateTheseConnections(isFriend, {
        quota: 3,
        backoffStep: 2e3,
        backoffMax: 10 * minute,
        groupMin: 1e3,
      });

    if (this.conf('seed', true))
      this.updateTheseConnections(p => p[1].source === 'seed', {
        quota: 3,
        backoffStep: 2e3,
        backoffMax: 10 * minute,
        groupMin: 1e3,
      });

    if (this.conf('local', true))
      this.updateTheseConnections(isLocal, {
        quota: 3,
        backoffStep: 2e3,
        backoffMax: 10 * minute,
        groupMin: 1e3,
      });

    if (this.conf('global', true)) {
      // prioritize friends
      this.updateTheseConnections(and(isFriend, hasPinged), {
        quota: 2,
        backoffStep: 10e3,
        backoffMax: 10 * minute,
        groupMin: 5e3,
      });

      if (numOfConnectedFriends < 2) {
        this.updateTheseConnections(and(isFriend, hasNoAttempts), {
          quota: 1,
          backoffStep: 0,
          backoffMax: 0,
          groupMin: 0,
        });
      }

      this.updateTheseConnections(and(isFriend, hasOnlyFailedAttempts), {
        quota: 3,
        backoffStep: minute,
        backoffMax: 3 * hour,
        groupMin: 5 * minute,
      });

      // standard longterm peers
      this.updateTheseConnections(and(hasPinged, not(isFriend), not(isLocal)), {
        quota: 2,
        backoffStep: 10e3,
        backoffMax: 10 * minute,
        groupMin: 5e3,
      });

      if (numOfConnectedRemoteNonFriends === 0) {
        this.updateTheseConnections(hasNoAttempts, {
          quota: 1,
          backoffStep: 0,
          backoffMax: 0,
          groupMin: 0,
        });
      }

      //quota, groupMin, min, backoffStep, max
      this.updateTheseConnections(hasOnlyFailedAttempts, {
        quota: 3,
        backoffStep: 5 * minute,
        backoffMax: 3 * hour,
        groupMin: 5 * 50e3,
      });

      const longterm = this.query.peersInConnection().filter(hasPinged).length;

      this.updateTheseConnections(isLegacy, {
        quota: 3 - longterm,
        backoffStep: 5 * minute,
        backoffMax: 3 * hour,
        groupMin: 5 * minute,
      });
    }

    // Purge some ongoing frustrating connection attempts
    this.query
      .peersInConnection()
      .filter(peer => {
        const permanent = hasPinged(peer) || isLocal(peer);
        return !permanent || this.hub.getState(peer[0]) === 'connecting';
      })
      .filter(peer => peer[1].stateChange! + 10e3 < Date.now())
      .forEach(([addr]) => this.hub.disconnect(addr).then(noop, noop));
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

  @muxrpc('sync')
  public start = () => {
    if (!this.closed) return;
    this.closed = false;

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

    // Upon regular time intervals, attempt to make connections
    const int = setInterval(() => this.updateConnectionsSoon(), 2e3);
    if (int.unref) int.unref();

    // Upon init, attempt to make some connections
    this.updateConnectionsSoon();

    // Upon init, populate with seeds and pubs
    if (this.config.offline) {
      console.log('Running in offline mode: gossip disabled');
    } else {
      // Populate gossip table with configured seeds (mainly used in testing)
      const seeds = this.config.seeds;
      (Array.isArray(seeds) ? seeds : [seeds]).filter(Boolean).forEach(addr => {
        this.ssb.gossip.add(addr, 'seed');
      });

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

    // Upon init, populate gossip table from the database
    for (let [address, data] of this.db.entries()) {
      if (data.source === 'dht') {
        this.ssb.gossip.add(address, 'dht');
      } else if (data.source !== 'local' && data.source !== 'bt') {
        this.ssb.gossip.add(address, 'stored');
      }
    }
  };

  @muxrpc('sync')
  public stop = () => {
    this.hub.reset();
    this.closed = true;
  };
}
