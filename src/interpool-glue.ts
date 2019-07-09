import ConnDB = require('ssb-conn-db');
import ConnHub = require('ssb-conn-hub');
import ConnStaging = require('ssb-conn-staging');
import {ListenEvent as HubEvent} from 'ssb-conn-hub/lib/types';
const pull = require('pull-stream');
const stats = require('statistics');
const ping = require('pull-ping');

export function interpoolGlue(db: ConnDB, hub: ConnHub, staging: ConnStaging) {
  function setupPing(address: string, rpc: any) {
    const PING_TIMEOUT = 5 * 6e4; // 5 minutes
    const pp = ping({serve: true, timeout: PING_TIMEOUT}, () => {});
    db.update(address, {ping: {rtt: pp.rtt, skew: pp.skew}});
    pull(
      pp,
      rpc.gossip.ping({timeout: PING_TIMEOUT}, (err: any) => {
        if (err && err.name === 'TypeError') {
          db.update(address, (prev: any) => ({
            ping: {...(prev.ping || {}), fail: true},
          }));
        }
      }),
      pp,
    );
  }

  function onConnecting(ev: HubEvent) {
    staging.unstage(ev.address);
    db.update(ev.address, {stateChange: Date.now()});
  }

  function onConnectingFailed(ev: HubEvent) {
    db.update(ev.address, (prev: any) => ({
      failure: (prev.failure || 0) + 1,
      stateChange: Date.now(),
      duration: stats(prev.duration, 0),
    }));
  }

  function onConnected(ev: HubEvent) {
    staging.unstage(ev.address);
    db.update(ev.address, {stateChange: Date.now(), failure: 0});
    if (ev.details.isClient) setupPing(ev.address, ev.details.rpc);
  }

  function onDisconnecting(ev: HubEvent) {
    db.update(ev.address, {stateChange: Date.now()});
  }

  function onDisconnectingFailed(ev: HubEvent) {
    db.update(ev.address, {stateChange: Date.now()});
  }

  function onDisconnected(ev: HubEvent) {
    db.update(ev.address, (prev: any) => ({
      stateChange: Date.now(),
      duration: stats(prev.duration, Date.now() - prev.stateChange),
    }));
    // TODO ping this address to see if it's worth re-staging it
    // But how to "ping" without multiserver-connecting to them?
  }

  pull(
    hub.listen(),
    pull.drain((ev: HubEvent) => {
      if (ev.type === 'connecting') onConnecting(ev);
      if (ev.type === 'connecting-failed') onConnectingFailed(ev);
      if (ev.type === 'connected') onConnected(ev);
      if (ev.type === 'disconnecting') onDisconnecting(ev);
      if (ev.type === 'disconnecting-failed') onDisconnectingFailed(ev);
      if (ev.type === 'disconnected') onDisconnected(ev);
    }),
  );
}
