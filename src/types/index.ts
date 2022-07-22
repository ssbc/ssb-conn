import {FeedId} from 'ssb-typescript';
import {CONN} from '../conn';

export type Peer = {
  address?: string;
  key?: string;
  host?: string;
  port?: number;
  source:
    | 'pub'
    | 'manual'
    | 'friends'
    | 'local'
    | 'dht'
    | 'bt'
    | 'stored';
  error?: string;
  state?: undefined | 'connecting' | 'connected' | 'disconnecting';
  stateChange?: number;
  failure?: number;
  client?: boolean;
  duration?: {
    mean: number;
  };
  ping?: {
    rtt: {
      mean: number;
    };
    skew: number;
    fail?: any;
  };
  disconnect?: Function;
};

export interface Config {
  conn?: {
    /**
     * Whether the CONN scheduler should start automatically as soon as the
     * SSB app is initialized. Default is `true`.
     */
    autostart: boolean;

    /**
     * Whether the CONN scheduler should look into the SSB database looking for
     * messages of type 'pub' and add them to CONN.
     */
    populatePubs: boolean;
  };
}

export interface SSB {
  readonly id: FeedId;
  readonly friends?: Readonly<{
    graphStream: (opts: {old: boolean; live: boolean}) => CallableFunction;
    hopStream: (opts: {old: boolean; live: boolean}) => CallableFunction;
  }>;
  readonly roomClient?: Readonly<{
    discoveredAttendants: () => CallableFunction;
  }>;
  readonly bluetooth?: Readonly<{
    nearbyScuttlebuttDevices: (x: number) => CallableFunction;
  }>;
  readonly lan?: Readonly<{
    start: () => void;
    stop: () => void;
    discoveredPeers: () => CallableFunction;
  }>;
  readonly db?: Readonly<{
    onMsgAdded?: (cb: CallableFunction) => CallableFunction;
    query: (...args: Array<any>) => any;
    operators: Record<string, any>;
  }>;
  readonly conn: CONN;
}

export type Callback<T> = (err?: any, val?: T) => void;
