# 4.0.0

- Change return type of `ssb.conn.dbPeers()` to array, not iterable

# 3.2.1

- Updated ssb-conn-db to use atomic-file-rw which should be more robust than before, causing less corrupted conn.json saves to the filesystems.

# 3.2.0

- Improve the scheduler: disconnect to excess peers after a long and random delay that is inversely proportional to the size of the excess. The randomization is important to avoid "back and forth dances" where remote peers connect to you, but you disconnect from them, which leads them to immediately attempt a reconnect to you, and so forth

# 3.1.0

- If already connected to a peer, `ssb.conn.connect()` will just return the RPC instance of that connected peer, instead of `false`. See https://github.com/staltz/ssb-conn-hub/commit/7a8a880d4abf74cc916febbe6efe441a23aed590

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