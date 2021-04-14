# 3.0.0

- Drop support for `ssb.gossip.*` APIs, except `ssb.gossip.ping`
- If you want to support `pub` messages in the scheduler, you need `ssb-db@2` or higher
- Remove the deprecated APIs `ssb.conn.internalConnDB()`, `ssb.conn.internalConnHub()`, `ssb.conn.internalConnStaging()`

# 2.1.0

- If already connected to a peer, `connect()` on that peer now returns the `rpc` object, not `false`

# 2.0.1

- Avoids global pollution of all objects with the `.z` field, something caused by the dependency `zii` in previous versions

# 2.0.0

- If you want to support `pub` messages in the scheduler, this version needs ssb-db2 and drops support for ssb-db. Everything else than `pub` messages will still work if you're on ssb-db.

# 1.0.0

Official first stable version (just a blessing of 0.19.1).

# 0.18.3

- Preliminary support for running in the browser