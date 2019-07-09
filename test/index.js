const tape = require('tape');
const mock = require('./mock');

tape('CONN APIs are available on SSB', t => {
  const ssb = mock();
  t.ok(ssb.conn, 'ssb.conn');

  t.ok(ssb.conn.remember, 'ssb.conn.remember');
  t.ok(ssb.conn.forget, 'ssb.conn.forget');
  t.ok(ssb.conn.dbPeers, 'ssb.conn.dbPeers');

  t.ok(ssb.conn.connect, 'ssb.conn.connect');
  t.ok(ssb.conn.disconnect, 'ssb.conn.disconnect');
  t.ok(ssb.conn.peers, 'ssb.conn.peers');

  t.ok(ssb.conn.stage, 'ssb.conn.stage');
  t.ok(ssb.conn.unstage, 'ssb.conn.unstage');
  t.ok(ssb.conn.stagedPeers, 'ssb.conn.stagedPeers');

  t.ok(ssb.conn.query, 'ssb.conn.query');
  t.ok(ssb.conn.start, 'ssb.conn.start');
  t.ok(ssb.conn.stop, 'ssb.conn.stop');
  t.ok(ssb.conn.ping, 'ssb.conn.ping');

  t.end();
});
