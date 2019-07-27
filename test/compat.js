const tape = require('tape');
const mock = require('./mock');

tape('Gossip APIs are available on SSB', t => {
  const ssb = mock();
  t.ok(ssb.gossip, 'ssb.gossip');

  t.ok(ssb.gossip.peers, 'ssb.gossip.peers');
  t.ok(ssb.gossip.get, 'ssb.gossip.get');
  t.ok(ssb.gossip.connect, 'ssb.gossip.connect');
  t.ok(ssb.gossip.disconnect, 'ssb.gossip.disconnect');
  t.ok(ssb.gossip.changes, 'ssb.gossip.changes');
  t.ok(ssb.gossip.add, 'ssb.gossip.add');
  t.ok(ssb.gossip.remove, 'ssb.gossip.remove');
  t.ok(ssb.gossip.ping, 'ssb.gossip.ping');
  t.ok(ssb.gossip.reconnect, 'ssb.gossip.reconnect');
  t.ok(ssb.gossip.enable, 'ssb.gossip.enable');
  t.ok(ssb.gossip.disable, 'ssb.gossip.disable');

  t.end();
});

tape('gossip.peers() logs a trace+deprecation warning', t => {
  t.plan(3);
  const ssb = mock();
  const originalWriteFn = process.stderr.write;

  process.stderr.write = (str, _encoding, _fd) => {
    t.true(str.includes('Trace'), 'stderr shows a trace');
    t.true(
      str.includes('DEPRECATED gossip.peers()'),
      'stderr warns of deprecation',
    );
    t.true(str.includes('at Gossip.peers ('), 'stderr shows stack trace');
  };
  ssb.gossip.peers();

  process.stderr.write = originalWriteFn;
  t.end();
});
