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
  announcers?: number;
};

export type Callback<T> = (err?: any, val?: T) => void;
