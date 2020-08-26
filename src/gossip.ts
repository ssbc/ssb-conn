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
    let protocol = 'net';
    if (address.host?.endsWith('.onion')) protocol = 'onion';
    return (
      [protocol, address.host, address.port].join(':') +
      '~' +
      ['shs', toBase64(address.key)].join(':')
    );
  }
  return address;
}

function parseAddress(address: string) {
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
  private deprecationWarned: Partial<Record<keyof Gossip, boolean>>;

  /**
   * Timestamp of the latest deprecation warning for gossip.peers()
   */
  private latestWarning: number;

  constructor(ssb: any, cfg: any) {
    this.ssb = ssb;
    this.notify = Notify();
    this.conn = this.ssb.conn;
    this.latestWarning = 0;

    this.setupConnectionListeners();
    if (cfg.conn?.autostart === false) {
      // opt-out from starting the scheduler
    } else {
      // by default, start the scheduler
      this.conn.start();
    }

    this.deprecationWarned = {};
  }

  private setupConnectionListeners() {
    pull(
      this.conn.hub().listen(),
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
      ...this.conn.db().get(ev.address),
    };
    this.notify({type: 'connect-failure', peer});
  }

  private onConnected(ev: HubEvent) {
    const peer = {
      state: ev.type,
      address: ev.address,
      key: ev.key,
      ...this.conn.db().get(ev.address),
    } as Peer;
    if (!this.conn.db().has(ev.address)) peer.source = inferSource(ev.address);
    this.notify({type: 'connect', peer});
  }

  private onDisconnected(ev: HubEvent) {
    const peer = {
      state: ev.type,
      address: ev.address,
      key: ev.key,
      ...this.conn.db().get(ev.address),
    } as Peer;
    this.notify({type: 'disconnect', peer});
  }

  private idToAddr(id: any) {
    const addr = this.conn.db().getAddressForId(id as string) as string;
    if (!addr) {
      throw new Error('no known address for peer:' + id);
    }
    return addr;
  }

  private deprecationWarning(method: keyof Gossip) {
    if (this.deprecationWarned[method]) return;

    console.error(
      `DEPRECATED gossip.${method}() was called. Use ssb-conn instead`,
    );
    this.deprecationWarned[method] = true;
  }

  @muxrpc('sync')
  public peers: () => any = () => {
    if (this.latestWarning + 10e3 < Date.now()) {
      console.trace('DEPRECATED gossip.peers(), use ssb-conn instead');
      this.latestWarning = Date.now();
    }
    const peers = Array.from(this.conn.db().entries()).map(
      ([address, data]) => {
        return {
          ...data,
          address,
          state: this.conn.hub().getState(address),
        };
      },
    );

    // Add peers that are connected but are not in the cold database
    for (const [address, data] of this.conn.hub().entries()) {
      if (!this.conn.db().has(address)) {
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
    this.deprecationWarning('get');
    if (ref.isFeed(addr)) {
      for (let [address, data] of this.conn.db().entries()) {
        if (data.key === addr) {
          return {...data, address};
        }
      }
      return undefined;
    }
    const [addressString] = validateAddr(addr);
    const peer = this.conn.db().get(addressString);
    if (!peer) return undefined;
    else {
      return {
        address: addressString,
        state: this.conn.hub().getState(addressString),
        ...peer,
      };
    }
  };

  @muxrpc('async')
  public connect = (addr: Peer | string, cb: Callback<any>) => {
    this.deprecationWarning('connect');
    let addressString: string;
    try {
      const inputAddr = ref.isFeed(addr) ? this.idToAddr(addr) : addr;
      [addressString] = validateAddr(inputAddr);
    } catch (err) {
      return cb(err);
    }

    this.add(addressString, 'manual');
    const stagedData = this.conn.staging().get(addressString) ?? {};
    const dbData = this.conn.db().get(addressString) ?? {};
    const data = {...dbData, ...stagedData};

    this.conn.connect(addressString, data, cb);
  };

  @muxrpc('async')
  public disconnect = (addr: Peer | string, cb: any) => {
    this.deprecationWarning('disconnect');
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
    this.deprecationWarning('changes');
    return this.notify.listen();
  };

  @muxrpc('sync')
  public add = (addr: Peer | string, source: Peer['source']) => {
    this.deprecationWarning('add');
    const [addressString, parsed] = validateAddr(addr);
    if (parsed.key === this.ssb.id) return;

    if (source === 'local') {
      console.error(
        'gossip.add(p, "local") from ssb-local is deprecated, ' +
          'this only supports ssb-lan',
      );
      return;
    }

    if (this.conn.db().has(addressString)) {
      return this.conn.db().get(addressString);
    } else {
      this.conn.db().set(addressString, {
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
          state: this.conn.hub().getState(addressString),
          source: source ?? 'manual',
        },
        source: source ?? 'manual',
      });
      return this.conn.db().get(addressString) ?? parsed;
    }
  };

  @muxrpc('sync')
  public remove = (addr: Peer | string) => {
    this.deprecationWarning('remove');
    const [addressString] = validateAddr(addr);

    this.conn.hub().disconnect(addressString);
    this.conn.staging().unstage(addressString);

    const peer = this.conn.db().get(addressString);
    if (!peer) return;
    this.conn.db().delete(addressString);
    this.notify({type: 'remove', peer: peer});
  };

  @muxrpc('duplex', {anonymous: 'allow'})
  public ping = () => this.conn.ping();

  @muxrpc('sync')
  public reconnect = () => {
    this.deprecationWarning('reconnect');
    this.conn.hub().reset();
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
