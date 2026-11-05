-- Database identity, echoed in every pull page so a client can tell a relay
-- rebuilt from nothing (new D1 database, all migrations re-run) from the one
-- it synced with before, and re-seed it. 53 random bits: an exact integer for
-- every JSON consumer. Restoring D1 from a backup keeps the old epoch on
-- purpose, since that log is continuous with what clients already hold.
insert or ignore into relay_meta (key, value) values ('epoch', (random() & 9007199254740991));
