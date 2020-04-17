export type Peer = {
  address?: string;
  key?: string;
  host?: string;
  port?: number;
  source:
    | 'seed'
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

export type Config = {
  /**
   * @deprecated
   * Legacy from ssb-gossip that we probably want to delete soon.
   */
  seed?: boolean;

  /**
   * @deprecated
   * Legacy from ssb-gossip that we probably want to delete soon.
   */
  seeds?: Array<string> | string;

  conn?: {
    /**
     * Whether the CONN scheduler should start automatically as soon as the
     * SSB app is initialized. Default is `true`.
     */
    autostart: boolean;

    /**
     * How far in the social graph should a peer be automatically connected to
     * whenever possible. Default value (when this is unspecified) is `1`.
     */
    hops: number;

    /**
     * Whether the CONN scheduler should look into the SSB database looking for
     * messages of type 'pub' and add them to CONN.
     */
    populatePubs: boolean;
  };
};

export type Callback<T> = (err?: any, val?: T) => void;
