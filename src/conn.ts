import ConnDB = require('ssb-conn-db');
import ConnHub = require('ssb-conn-hub');
import ConnStaging = require('ssb-conn-staging');
import ConnQuery = require('ssb-conn-query');
import {ListenEvent as HubEvent} from 'ssb-conn-hub/lib/types';
import {StagedData} from 'ssb-conn-staging/lib/types';
import {plugin, muxrpc} from 'secret-stack-decorators';
import {Callback} from './types';
const pull = require('pull-stream');
const msAddress = require('multiserver-address');
const stats = require('statistics');
const ping = require('pull-ping');

@plugin('1.0.0')
export class CONN {
  private readonly ssb: any;
  private readonly config: any;
  private readonly connDB: ConnDB;
  private readonly connHub: ConnHub;
  private readonly connStaging: ConnStaging;
  private readonly connQuery: ConnQuery;

  constructor(ssb: any, cfg: any) {
    this.ssb = ssb;
    this.config = cfg;
    this.connDB = new ConnDB({path: this.config.path, writeTimeout: 10e3});
    this.connHub = new ConnHub(this.ssb);
    this.connStaging = new ConnStaging(this.connHub);
    this.connQuery = new ConnQuery(this.connDB, this.connHub, this.connStaging);

    this.initialize();
  }

  //#region Initialization

  private initialize() {
    this.setupCloseHook();
    this.setupConnectionListeners();
    this.maybeAutoStartScheduler();
  }

  private setupCloseHook() {
    const that = this;
    this.ssb.close.hook(function(this: any, fn: Function, args: Array<any>) {
      that.stopScheduler();
      that.connDB.close();
      that.connHub.close();
      that.connStaging.close();
      return fn.apply(this, args);
    });
  }

  private maybeAutoStartScheduler() {
    if (this.config.conn && this.config.conn.autostart !== false) {
      this.startScheduler();
    }
  }

  private setupConnectionListeners() {
    pull(
      this.connHub.listen(),
      pull.drain((ev: HubEvent) => {
        if (ev.type === 'connecting') this.onConnecting(ev);
        if (ev.type === 'connecting-failed') this.onConnectingFailed(ev);
        if (ev.type === 'connected') this.onConnected(ev);
        if (ev.type === 'disconnecting') this.onDisconnecting(ev);
        if (ev.type === 'disconnecting-failed') this.onDisconnectingFailed(ev);
        if (ev.type === 'disconnected') this.onDisconnected(ev);
      }),
    );
  }

  //#endregion

  //#region Hub events

  private onConnecting(ev: HubEvent) {
    this.connDB.update(ev.address, {stateChange: Date.now()});
  }

  private onConnectingFailed(ev: HubEvent) {
    this.connDB.update(ev.address, (prev: any) => ({
      failure: (prev.failure || 0) + 1,
      stateChange: Date.now(),
      duration: stats(prev.duration, 0),
    }));
  }

  private onConnected(ev: HubEvent) {
    this.connDB.update(ev.address, {stateChange: Date.now(), failure: 0});
    if (ev.details.isClient) this.setupPing(ev.address, ev.details.rpc);
  }

  private onDisconnecting(ev: HubEvent) {
    this.connDB.update(ev.address, {stateChange: Date.now()});
  }

  private onDisconnectingFailed(ev: HubEvent) {
    this.connDB.update(ev.address, {stateChange: Date.now()});
  }

  private onDisconnected(ev: HubEvent) {
    this.connDB.update(ev.address, (prev: any) => ({
      stateChange: Date.now(),
      duration: stats(prev.duration, Date.now() - prev.stateChange),
    }));
  }

  //#endregion

  //#region Helper methods

  private async startScheduler() {
    await this.connDB.loaded();

    if (this.ssb.connScheduler) {
      this.ssb.connScheduler.start();
    } else {
      // Maybe this is a race condition, so let's wait a bit more
      setTimeout(() => {
        if (this.ssb.connScheduler) {
          this.ssb.connScheduler.start();
        } else {
          console.error(
            'There is no ConnScheduler! ' +
              'The CONN plugin will remain in manual mode.',
          );
        }
      }, 100);
    }
  }

  private stopScheduler() {
    if (this.ssb.connScheduler) this.ssb.connScheduler.stop();
  }

  private setupPing(address: string, rpc: any) {
    const PING_TIMEOUT = 5 * 6e4; // 5 minutes
    const pp = ping({serve: true, timeout: PING_TIMEOUT}, () => {});
    this.connDB.update(address, {ping: {rtt: pp.rtt, skew: pp.skew}});
    pull(
      pp,
      rpc.gossip.ping({timeout: PING_TIMEOUT}, (err: any) => {
        if (err && err.name === 'TypeError') {
          this.connDB.update(address, (prev: any) => ({
            ping: {...(prev.ping || {}), fail: true},
          }));
        }
      }),
      pp,
    );
  }

  private assertValidAddress(address: string) {
    if (!msAddress.check(address)) {
      throw new Error('The given address is not a valid multiserver-address');
    }
  }

  //#endregion

  //#region PUBLIC MUXRPC

  @muxrpc('async')
  public connect = (
    address: string,
    second: Record<string, any> | null | undefined | Callback<any>,
    third?: Callback<any>,
  ) => {
    if (typeof second === 'function' && typeof third === 'function') {
      throw new Error('CONN.connect() received incorrect arguments');
    }
    const cb = (typeof third === 'function' ? third : second) as Callback<any>;
    const data = (typeof third === 'function' ? second : undefined) as any;

    try {
      this.assertValidAddress(address);
    } catch (err) {
      cb(err);
      return;
    }

    this.connHub
      .connect(address, data)
      .then(result => cb && cb(null, result), err => cb && cb(err));
  };

  @muxrpc('async')
  public disconnect = (address: string, cb: Callback<any>) => {
    try {
      this.assertValidAddress(address);
    } catch (err) {
      cb(err);
      return;
    }

    this.connHub
      .disconnect(address)
      .then(result => cb && cb(null, result), err => cb && cb(err));
  };

  @muxrpc('sync')
  public stage = (
    address: string,
    data: Partial<StagedData> = {type: 'internet'},
  ) => {
    return this.connStaging.stage(address, data);
  };

  @muxrpc('sync')
  public unstage = (address: string) => {
    return this.connStaging.unstage(address);
  };

  @muxrpc('sync')
  public remember = (address: string, data: any = {}) => {
    this.assertValidAddress(address);

    this.connDB.set(address, data);
  };

  @muxrpc('sync')
  public forget = (address: string) => {
    this.assertValidAddress(address);

    this.connDB.delete(address);
  };

  @muxrpc('source')
  public peers = () => this.connHub.liveEntries();

  @muxrpc('source')
  public stagedPeers = () => this.connStaging.liveEntries();

  @muxrpc('sync')
  public start = () => {
    return this.startScheduler();
  };

  @muxrpc('sync')
  public stop = () => {
    this.stopScheduler();
  };

  @muxrpc('duplex', {anonymous: 'allow'})
  public ping = () => {
    const MIN = 10e3;
    const DEFAULT = 5 * 60e3;
    const MAX = 30 * 60e3;
    let timeout = (this.config.timers && this.config.timers.ping) || DEFAULT;
    timeout = Math.max(MIN, Math.min(timeout, MAX));
    return ping({timeout});
  };

  @muxrpc('sync')
  public internalConnDb = () => this.connDB;

  @muxrpc('sync')
  public internalConnHub = () => this.connHub;

  @muxrpc('sync')
  public internalConnStaging = () => this.connStaging;

  @muxrpc('sync')
  public internalConnQuery = () => this.connQuery;

  //#endregion
}
