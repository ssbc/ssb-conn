import ConnDB = require('ssb-conn-db');
import ConnHub = require('ssb-conn-hub');
import ConnStaging = require('ssb-conn-staging');
import {ListenEvent as HubEvent} from 'ssb-conn-hub/lib/types';
import {Callback, Peer} from './types';
import {plugin, muxrpc} from 'secret-stack-decorators';
import {CONN} from './conn';
const pull = require('pull-stream');
const Notify = require('pull-notify');
const ref = require('ssb-ref');

function isPeerObject(o: any): o is Peer {
  return o && 'object' == typeof o;
}

function toBase64(s: any): string {
  if (typeof s === 'string') return s.substring(1, s.indexOf('.'));
  else return s.toString('base64'); //assume a buffer
}

function toAddressString(address: Peer | string): string {
  if (isPeerObject(address)) {
    if (ref.isAddress(address.address)) return address.address!;
    if (address.source === 'dht') {
      return (
        ['dht', address.host].join(':') + '~' + 'noauth'
        // ['shs', toBase64(address.key)].join(':')
      );
    }
    let protocol = 'net';
    if (address.host && address.host.endsWith('.onion')) protocol = 'onion';
    return (
      [protocol, address.host, address.port].join(':') +
      '~' +
      ['shs', toBase64(address.key)].join(':')
    );
  }
  return address;
}

function isDhtAddress(addr: any) {
  return typeof addr === 'string' && addr.substr(0, 4) === 'dht:';
}

function parseDhtAddress(addr: string): Peer {
  const [transport /*, transform */] = addr.split('~');
  const [dhtTag, seed, remoteId] = transport.split(':');
  if (dhtTag !== 'dht') throw new Error('Invalid DHT address ' + addr);
  return {
    host: seed + ':' + remoteId,
    port: 0,
    key: remoteId[0] === '@' ? remoteId : '@' + remoteId,
    source: 'dht',
  };
}

function parseAddress(address: string) {
  if (isDhtAddress(address)) {
    return parseDhtAddress(address);
  }
  const legacyParsing = ref.parseAddress(address);
  if (legacyParsing) {
    return legacyParsing;
  } else if (ref.isAddress(address)) {
    return {key: ref.getKeyFromAddress(address)};
  }
}

function validateAddr(addr: Peer | string): [string, any] {
  if (!addr || (typeof addr !== 'object' && typeof addr !== 'string')) {
    throw new Error('address should be an object or string');
  }
  const addressString = typeof addr === 'string' ? addr : toAddressString(addr);
  const parsed = typeof addr === 'object' ? addr : parseAddress(addressString);
  if (!parsed.key) throw new Error('address must have ed25519 key');
  if (!ref.isFeed(parsed.key)) throw new Error('key must be ed25519 public id');
  return [addressString, parsed];
}

function inferSource(address: string): Peer['source'] {
  // We ASSUME this `address` is NOT in conn-db and is NOT a pub
  return address.startsWith('net:') ? 'local' : 'manual';
}

@plugin('1.0.0')
export class Gossip {
  private readonly ssb: any;
  private readonly notify: any;
  private readonly conn: CONN;
  private readonly connDB: ConnDB;
  private readonly connHub: ConnHub;
  private readonly connStaging: ConnStaging;

  constructor(ssb: any) {
    this.ssb = ssb;
    this.notify = Notify();
    this.conn = this.ssb.conn;
    this.connDB = this.conn.internalConnDB();
    this.connHub = this.conn.internalConnHub();
    this.connStaging = this.conn.internalConnStaging();

    this.setupConnectionListeners();
    this.conn.start();
  }

  private setupConnectionListeners() {
    pull(
      this.connHub.listen(),
      pull.drain((ev: HubEvent) => {
        if (ev.type === 'connecting-failed') this.onConnectingFailed(ev);
        if (ev.type === 'connected') this.onConnected(ev);
        if (ev.type === 'disconnected') this.onDisconnected(ev);
      }),
    );
  }

  private onConnectingFailed(ev: HubEvent) {
    const peer = {
      state: ev.type,
      address: ev.address,
      key: ev.key,
      ...this.connDB.get(ev.address),
    };
    this.notify({type: 'connect-failure', peer});
  }

  private onConnected(ev: HubEvent) {
    const peer = {
      state: ev.type,
      address: ev.address,
      key: ev.key,
      ...this.connDB.get(ev.address),
    } as Peer;
    if (!this.connDB.has(ev.address)) peer.source = inferSource(ev.address);
    this.notify({type: 'connect', peer});
  }

  private onDisconnected(ev: HubEvent) {
    const peer = {
      state: ev.type,
      address: ev.address,
      key: ev.key,
      ...this.connDB.get(ev.address),
    } as Peer;
    this.notify({type: 'disconnect', peer});
  }

  private idToAddr(id: any) {
    const addr = this.connDB.getAddressForId(id as string) as string;
    if (!addr) {
      throw new Error('no known address for peer:' + id);
    }
    return addr;
  }

  @muxrpc('sync')
  public peers: () => any = () => {
    console.error('DEPRECATED gossip.peers() was called. Use ssb-conn instead');
    const peers = Array.from(this.connDB.entries()).map(([address, data]) => {
      return {
        ...data,
        address,
        state: this.connHub.getState(address),
      };
    });

    // Add peers that are connected but are not in the cold database
    for (const [address, data] of this.connHub.entries()) {
      if (!this.connDB.has(address)) {
        const [, parsed] = validateAddr(address);
        peers.push({
          ...data,
          ...parsed,
          address,
          source: inferSource(address),
        });
      }
    }

    return peers;
  };

  // Is this API used 'externally' somehow? We don't use this internally,
  // but it's still used in tests and it's in the manifest
  @muxrpc('sync')
  public get: (addr: Peer | string) => any = (addr: Peer | string) => {
    console.error('DEPRECATED gossip.get() was called. Use ssb-conn instead');
    if (ref.isFeed(addr)) {
      for (let [address, data] of this.connDB.entries()) {
        if (data.key === addr) {
          return {...data, address};
        }
      }
      return undefined;
    }
    const [addressString] = validateAddr(addr);
    const peer = this.connDB.get(addressString);
    if (!peer) return undefined;
    else {
      return {
        address: addressString,
        state: this.connHub.getState(addressString),
        ...peer,
      };
    }
  };

  @muxrpc('async')
  public connect = (addr: Peer | string, cb: Callback<any>) => {
    console.error(
      'DEPRECATED gossip.connect() was called. Use ssb-conn instead',
    );
    let addressString: string;
    try {
      const inputAddr = ref.isFeed(addr) ? this.idToAddr(addr) : addr;
      [addressString] = validateAddr(inputAddr);
    } catch (err) {
      return cb(err);
    }

    this.add(addressString, 'manual');

    this.conn.connect(addressString, cb);
  };

  @muxrpc('async')
  public disconnect = (addr: Peer | string, cb: any) => {
    console.error(
      'DEPRECATED gossip.disconnect() was called. Use ssb-conn instead',
    );
    let addressString: string;
    try {
      const inputAddr = ref.isFeed(addr) ? this.idToAddr(addr) : addr;
      [addressString] = validateAddr(inputAddr);
    } catch (err) {
      return cb(err);
    }

    this.conn.disconnect(addressString, cb);
  };

  @muxrpc('source')
  public changes = () => {
    console.error(
      'DEPRECATED gossip.changes() was called. Use ssb-conn instead',
    );
    return this.notify.listen();
  };

  @muxrpc('sync')
  public add = (addr: Peer | string, source: Peer['source']) => {
    console.error('DEPRECATED gossip.add() was called. Use ssb-conn instead');
    const [addressString, parsed] = validateAddr(addr);
    if (parsed.key === this.ssb.id) return;

    if (source === 'local') {
      console.error(
        'gossip.add(p, "local") from ssb-local is deprecated, ' +
          'this only supports ssb-lan',
      );
      return;
    }

    if (this.connDB.has(addressString)) {
      return this.connDB.get(addressString);
    } else {
      this.connDB.set(addressString, {
        host: parsed.host,
        port: parsed.port,
        key: parsed.key,
        address: addressString,
        source: source,
      });
      this.notify({
        type: 'discover',
        peer: {
          ...parsed,
          state: this.connHub.getState(addressString),
          source: source || 'manual',
        },
        source: source || 'manual',
      });
      return this.connDB.get(addressString) || parsed;
    }
  };

  @muxrpc('sync')
  public remove = (addr: Peer | string) => {
    console.error(
      'DEPRECATED gossip.remove() was called. Use ssb-conn instead',
    );
    const [addressString] = validateAddr(addr);

    this.connHub.disconnect(addressString);
    this.connStaging.unstage(addressString);

    const peer = this.connDB.get(addressString);
    if (!peer) return;
    this.connDB.delete(addressString);
    this.notify({type: 'remove', peer: peer});
  };

  @muxrpc('duplex', {anonymous: 'allow'})
  public ping = () => this.conn.ping();

  @muxrpc('sync')
  public reconnect = () => {
    console.error(
      'DEPRECATED gossip.reconnect() was called. Use ssb-conn instead',
    );
    this.connHub.reset();
  };

  @muxrpc('sync')
  public enable = (type: string) => {
    console.error('UNSUPPORTED gossip.enable("' + type + '") was ignored');
  };

  @muxrpc('sync')
  public disable = (type: string) => {
    console.error('UNSUPPORTED gossip.disable("' + type + '") was ignored');
  };
}
