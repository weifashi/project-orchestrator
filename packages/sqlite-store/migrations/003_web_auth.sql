CREATE TABLE web_users (
 id TEXT PRIMARY KEY,
 username TEXT NOT NULL COLLATE NOCASE UNIQUE,
 password_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK(length(username) BETWEEN 3 AND 32),
 CHECK(username NOT GLOB '*[^A-Za-z0-9_-]*')
);

CREATE TABLE web_sessions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES web_users(id) ON DELETE RESTRICT,
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
 csrf_hash TEXT NOT NULL CHECK(length(csrf_hash)=64 AND csrf_hash NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 revoked_at TEXT
);

CREATE TABLE web_login_attempts (
 client_key TEXT PRIMARY KEY,
 failures INTEGER NOT NULL CHECK(failures >= 0),
 window_started_at TEXT NOT NULL,
 locked_until TEXT,
 updated_at TEXT NOT NULL
);

CREATE INDEX idx_web_sessions_active ON web_sessions(token_hash, expires_at) WHERE revoked_at IS NULL;
