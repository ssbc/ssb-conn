const tape = require('tape');
const mock = require('./mock');

tape('Gossip Ping API is available on SSB', t => {
  const ssb = mock();
  t.ok(ssb.gossip, 'ssb.gossip');
  t.ok(ssb.gossip.ping, 'ssb.gossip.ping');

  t.end();
});
