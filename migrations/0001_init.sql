-- One row per submission. `sender_id` is the visitor's signed cookie identity,
-- `ip_hash` is a salted hash of their address — never the address itself, so a
-- database leak cannot be turned back into a list of who visited.
CREATE TABLE submissions (
  id          TEXT    PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  sender_id   TEXT    NOT NULL,
  ip_hash     TEXT    NOT NULL,
  text        TEXT,
  drawing_key TEXT,
  user_agent  TEXT,
  country     TEXT,
  read_at     INTEGER
);

CREATE INDEX submissions_created_at ON submissions (created_at DESC);
CREATE INDEX submissions_sender_id  ON submissions (sender_id, created_at);
CREATE INDEX submissions_ip_hash    ON submissions (ip_hash, created_at);

-- `kind` is 'sender' or 'ip'. Blocking a sender stops that browser; blocking
-- an ip stops the address they last posted from. Both are cheap to undo.
CREATE TABLE blocks (
  kind       TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  note       TEXT,
  PRIMARY KEY (kind, value)
);
