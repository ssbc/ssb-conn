import ConnDB = require('ssb-conn-db');
import ConnHub = require('ssb-conn-hub');
import ConnStaging = require('ssb-conn-staging');
import ConnQuery = require('ssb-conn-query');
import {AddressData} from 'ssb-conn-db/lib/types';
import {StagedData} from 'ssb-conn-staging/lib/types';
import {plugin, muxrpc} from 'secret-stack-decorators';
import {Callback} from './types';
import {interpoolGlue} from './interpool-glue';
const ping = require('pull-ping');

@plugin('1.0.0')
export class CONN {
  private readonly ssb: any;
  private readonly config: any;
  private readonly _db: ConnDB;
  private readonly _hub: ConnHub;
  private readonly _staging: ConnStaging;
  private readonly _query: ConnQuery;

  constructor(ssb: any, cfg: any) {
    this.ssb = ssb;
    this.config = cfg;
    this._db = new ConnDB({path: this.config.path, writeTimeout: 1e3});
    this._hub = new ConnHub(this.ssb);
    this._staging = new ConnStaging();
    this._query = new ConnQuery(this._db, this._hub, this._staging);

    this.initialize();
  }

  //#region Initialization

  private initialize() {
    this.setupCloseHook();
    this.maybeAutoStartScheduler();
    interpoolGlue(this._db, this._hub, this._staging);
  }

  private setupCloseHook() {
    const that = this;
    this.ssb.close.hook(function(this: any, fn: Function, args: Array<any>) {
      that.stopScheduler();
      that._db.close();
      that._hub.close();
      that._staging.close();
      return fn.apply(this, args);
    });
  }

  private maybeAutoStartScheduler() {
    if (this.config.conn?.autostart === false) {
      // opt-out from starting the scheduler
    } else {
      // by default, start the scheduler
      this.startScheduler();
    }
  }

  //#endregion

  //#region Helper methods

  private async startScheduler() {
    await this._db.loaded();

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

  //#endregion

  //#region PUBLIC MUXRPC

  @muxrpc('sync')
  public remember = (address: string, data: any = {}) => {
    this._db.set(address, data);
  };

  @muxrpc('sync')
  public forget = (address: string) => {
    this._db.delete(address);
  };

  @muxrpc('sync')
  public dbPeers = () => this._db.entries() as Iterable<[string, AddressData]>;

  @muxrpc('async')
  public connect = (
    address: string,
    b?: Record<string, any> | null | undefined | Callback<any>,
    c?: Callback<any>,
  ) => {
    if (c && (typeof b === 'function' || !b)) {
      throw new Error('CONN.connect() received incorrect arguments');
    }
    const last = !!c ? c : b;
    const cb = (typeof last === 'function' ? last : null) as Callback<any>;
    const data = (typeof b === 'object' ? b : {}) as any;

    this._hub
      .connect(address, data)
      .then(result => cb?.(null, result), err => cb?.(err));
  };

  @muxrpc('async')
  public disconnect = (address: string, cb?: Callback<any>) => {
    this._hub
      .disconnect(address)
      .then(result => cb?.(null, result), err => cb?.(err));
  };

  @muxrpc('source')
  public peers = () => this._hub.liveEntries();

  @muxrpc('sync')
  public stage = (
    address: string,
    data: Partial<StagedData> = {type: 'internet'},
  ) => {
    if (!!this._hub.getState(address)) return false;
    if (data.key) {
      for (const other of this._hub.entries()) {
        if (other[1].key === data.key) return false;
      }
    }

    return this._staging.stage(address, data);
  };

  @muxrpc('sync')
  public unstage = (address: string) => {
    return this._staging.unstage(address);
  };

  @muxrpc('source')
  public stagedPeers = () => this._staging.liveEntries();

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
    let timeout = (this.config.timers?.ping) ?? DEFAULT;
    timeout = Math.max(MIN, Math.min(timeout, MAX));
    return ping({timeout});
  };

  @muxrpc('sync')
  public db = () => this._db;

  @muxrpc('sync')
  public hub = () => this._hub;

  @muxrpc('sync')
  public staging = () => this._staging;

  @muxrpc('sync')
  public query = () => this._query;

  @muxrpc('sync')
  public internalConnDB = () => {
    console.error('DEPRECATED conn.internalConnDB(), use conn.db() instead');
    return this._db;
  };

  @muxrpc('sync')
  public internalConnHub = () => {
    console.error('DEPRECATED conn.internalConnHub(), use conn.hub() instead');
    return this._hub;
  };

  @muxrpc('sync')
  public internalConnStaging = () => {
    console.error(
      'DEPRECATED conn.internalConnStaging(), use conn.staging() instead',
    );
    return this._staging;
  };
  //#endregion
}
