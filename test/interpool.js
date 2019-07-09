const tape = require('tape');
const mock = require('./mock');

const TEST_ADDR =
  'net:localhost:9752~shs:pAhDcHjunq6epPvYYo483vBjcuDkE10qrc2tYC827R0=';

tape('CONN refuses to stage an already connected peer', t => {
  t.plan(4);
  const ssb = mock();

  const address = TEST_ADDR;
  ssb.conn.connect(address, (err, result) => {
    t.error(err, 'no error');
    t.ok(result, 'connect was succesful');

    const stagingResult = ssb.conn.stage(address, {mode: 'internet'});
    t.equals(stagingResult, false, 'stage() should refuse');

    const entries1 = Array.from(ssb.conn.internalConnStaging().entries());
    t.equals(entries1.length, 0, 'there is nothing in staging');

    t.end();
  });
});

tape('automatically unstage upon connHub "connected" event', t => {
  t.plan(6);
  const ssb = mock();

  const address = TEST_ADDR;
  const result1 = ssb.conn.stage(address, {mode: 'internet', address});
  t.equals(result1, true, 'stage() succeeds');

  const entries1 = Array.from(ssb.conn.internalConnStaging().entries());
  t.equals(entries1.length, 1, 'there is one address in staging');
  const [actualAddress] = entries1[0];
  t.equals(actualAddress, TEST_ADDR, 'staged address is what we expected');

  ssb.conn.connect(address, (err, result) => {
    t.error(err, 'no error');
    t.ok(result, 'connect was succesful');

    const entries2 = Array.from(ssb.conn.internalConnStaging().entries());
    t.equals(entries2.length, 0, 'there is nothing in staging');

    t.end();
  });
});

tape('unstage only exactly what connHub "connected" event informed', t => {
  t.plan(6);
  const ssb = mock();

  const address = TEST_ADDR;
  const result1 = ssb.conn.stage(address, {mode: 'internet', address});
  t.equals(result1, true, 'stage() succeeds');

  const entries1 = Array.from(ssb.conn.internalConnStaging().entries());
  t.equals(entries1.length, 1, 'there is one address in staging');
  const [actualAddress] = entries1[0];
  t.equals(actualAddress, TEST_ADDR, 'staged address is what we expected');

  ssb.conn.connect('net:unrelatedaddress.com:9009~noauth', (err, result) => {
    t.error(err, 'no error');
    t.ok(result, 'connect to unrelated random peer was succesful');

    const entries2 = Array.from(ssb.conn.internalConnStaging().entries());
    t.equals(entries2.length, 1, 'there is (still) one address in staging');

    t.end();
  });
});
