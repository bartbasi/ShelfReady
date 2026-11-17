// Schema migrations, versioned in code. Each one runs once, in order, inside a transaction.
// Never edit a migration that has shipped. Add a new one at the end instead.
// migrate() turns foreign keys off while a migration runs, so a migration may rebuild a table
// (create new, copy, drop old, rename) without cascades firing. It runs foreign_key_check
// before committing and refuses to commit if any reference is broken.

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * Rebuild the file after this migration (VACUUM), so free pages left by earlier deletes,
   * written before secure_delete was on, are wiped too.
   */
  vacuumAfter?: boolean;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'users, sessions, settings, audit log, login throttle',
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('manager', 'admin')),
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Only the SHA-256 of the session token is stored. Times are milliseconds since 1970.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  remember INTEGER NOT NULL CHECK (remember IN (0, 1)),
  created_at INTEGER NOT NULL,
  -- When the password was last typed on this session. Admin changes need it within 15 minutes.
  auth_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- Every value is encrypted with AES-256-GCM. The setting name is bound in as associated data.
CREATE TABLE settings (
  name TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  tag BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
) STRICT;

-- Append only. Later steps add invoice runs, Square writes, scale pushes, edits and undo here.
-- user_id is null for the system. username is kept as it was at the time.
-- entity_type and entity_id say what changed, for example ('square_item', 'ABC123').
-- run_id links an entry to an invoice run once that table exists.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  run_id INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details))
) STRICT;
CREATE INDEX audit_at ON audit_log(at);
CREATE INDEX audit_action ON audit_log(action);
CREATE INDEX audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX audit_run ON audit_log(run_id);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append only'); END;

-- Raw failed and locked sign-in events, kept 30 days then pruned. Only a summary goes to
-- the audit log, so someone spraying usernames cannot grow the append-only log without bound.
CREATE TABLE login_events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unknown_user', 'locked', 'busy')),
  username_key TEXT NOT NULL,
  ip TEXT NOT NULL
) STRICT;
CREATE INDEX login_events_at ON login_events(at);

-- Failed sign ins, keyed 'user:<HMAC of the name>' (from v3) or 'ip:<address>'. Times in milliseconds.
CREATE TABLE login_throttle (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  last_failure_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL
) STRICT;
`,
  },
  {
    version: 2,
    name: 'login events as hourly counters',
    // One row per hour and kind, so the table stays small however many attempts arrive:
    // at most 3 kinds x 24 hours x 30 days. No username is kept, since one may be a typed password.
    sql: `
DROP TABLE login_events;
CREATE TABLE login_events (
  hour INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unknown_user', 'locked', 'busy')),
  events INTEGER NOT NULL,
  PRIMARY KEY (hour, kind)
) STRICT;
`,
  },
  {
    version: 3,
    name: 'throttle keys are HMACs, never typed names',
    // Rows keyed by the typed name are dropped: a lockout in progress simply ends. The VACUUM
    // after it also wipes the free pages left when v2 dropped the old login_events table.
    sql: `DELETE FROM login_throttle;`,
    vacuumAfter: true,
  },
  {
    version: 4,
    name: 'suppliers, supplier aliases, saved item mapping',
    // Store data that grows as the manager confirms matches. Every change to these tables is
    // also written to the audit log with the user and time (src/matching/suppliers.ts, mapping.ts).
    sql: `
-- A supplier can print its name several ways, so every name it has used is an alias, found by
-- a key: folded to lower case, "&" read as "and", punctuation and words like Inc or LLC dropped.
-- upc_item_rule is JSON {"prefixes":["..."],"from":7,"to":11} when this supplier's item number
-- sits inside maker UPCs, or '' when it does not.
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name <> ''),
  upc_item_rule TEXT NOT NULL DEFAULT '' CHECK (upc_item_rule = '' OR json_valid(upc_item_rule)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE supplier_aliases (
  alias_key TEXT PRIMARY KEY CHECK (alias_key <> ''),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  alias TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX supplier_aliases_supplier ON supplier_aliases(supplier_id);

-- What one supplier item is in Square, or that the store does not sell it (kitchen supplies).
-- line_key finds the item again: 'n:' and the item number as printed (upper case, no spaces),
-- else 'u:' and the 14-digit UPC, else 'd:' and the folded description.
-- item_key is the item number with the letter O read as 0 and I as 1. Lines are looked up by
-- it too, but a row found only that way must be confirmed by UPC or description.
-- upc_key is the printed UPC when the line had a valid one. invoice_name and invoice_brand are the
-- description and brand as printed, used to confirm the next line saved under the same key is the
-- same product. store_name is the name the store uses for it: the link from invoice name to store name.
CREATE TABLE item_mappings (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  line_key TEXT NOT NULL CHECK (substr(line_key, 1, 2) IN ('n:', 'u:', 'd:') AND length(line_key) > 2),
  item_number TEXT NOT NULL DEFAULT '',
  item_key TEXT NOT NULL DEFAULT '',
  upc_key TEXT NOT NULL DEFAULT '',
  invoice_name TEXT NOT NULL DEFAULT '',
  invoice_brand TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('square', 'not_for_resale')),
  square_variation_id TEXT,
  square_item_id TEXT,
  store_name TEXT NOT NULL DEFAULT '',
  confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by_name TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT NOT NULL,
  CHECK ((kind = 'square' AND coalesce(square_variation_id, '') <> '') OR (kind = 'not_for_resale' AND square_variation_id IS NULL)),
  UNIQUE (supplier_id, line_key)
) STRICT;
CREATE INDEX item_mappings_item_key ON item_mappings(supplier_id, item_key) WHERE item_key <> '';
CREATE INDEX item_mappings_upc ON item_mappings(supplier_id, upc_key) WHERE upc_key <> '';
CREATE INDEX item_mappings_variation ON item_mappings(square_variation_id);

-- Every wording a person confirmed for a saved match. A supplier can print one item several ways
-- over time, so a line is checked against the best of them, and each wording is confirmed once.
-- wording_key is the description and brand folded with spaces and punctuation removed.
CREATE TABLE item_mapping_wordings (
  mapping_id INTEGER NOT NULL REFERENCES item_mappings(id) ON DELETE CASCADE,
  wording_key TEXT NOT NULL CHECK (wording_key <> ''),
  description TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by_name TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (mapping_id, wording_key)
) STRICT;
`,
  },
  {
    version: 5,
    name: 'shelf card copy: cards, links per catalog, card history, rejected suggestions',
    // One card per product (src/copy/store.ts). Every change is also written to the audit log.
    sql: `
-- Card text as printed, minus price and scale code: a printed card always takes those from
-- pricing and Square. content, printed and review are JSON; blocked is a JSON list of reasons the
-- card cannot print until a person edits it (a price, phone number or web address left in).
-- scale_code: the code the card was printed with, or its item's code when last seen, or ''.
-- name_key: the folded product name, for linking by name.
-- import_key: the card's key in the imported file (src/cards/import.ts cardKey), '' for generated
-- cards. A key belongs to one card for good, retired or not, so an import run again never brings
-- a retired card back.
-- source: where the text comes from now; an edit by a person makes it 'edited' for good.
-- checked_version: the version a person checked, 0 if none. Every generated card needs a check
-- of its current version before it prints.
-- retired_at: set when a card with higher precedence replaces it. Cards are never deleted.
CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  scale_code TEXT NOT NULL DEFAULT '' CHECK (scale_code = '' OR (length(scale_code) = 4 AND scale_code NOT GLOB '*[^0-9]*')),
  name_key TEXT NOT NULL DEFAULT '',
  import_key TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('imported', 'generated', 'edited')),
  first_source TEXT NOT NULL CHECK (first_source IN ('imported', 'generated')),
  content TEXT NOT NULL CHECK (json_valid(content)),
  printed TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(printed)),
  review TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(review)),
  blocked TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blocked) AND json_type(blocked) = 'array'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  checked_version INTEGER NOT NULL DEFAULT 0 CHECK (checked_version >= 0),
  retired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source = 'edited' OR source = first_source)
) STRICT;
CREATE UNIQUE INDEX cards_import_key ON cards(import_key) WHERE import_key <> '';
CREATE INDEX cards_scale_code ON cards(scale_code) WHERE scale_code <> '';

-- Where a card is linked: one row per catalog. Square variation ids differ between accounts (the
-- sandbox holds copies of the live items under new ids), so a link holds only in the catalog it
-- was made in. catalog: that catalog's Square location id, which names its id space.
-- catalog_source: where the catalog came from (square_sandbox, file). label: the variation's
-- label then, so a link can carry to the one item of the same name in another catalog.
-- At most one card per variation in a catalog. A retired card has no links.
CREATE TABLE card_links (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
  catalog TEXT NOT NULL CHECK (catalog <> ''),
  catalog_source TEXT NOT NULL DEFAULT '',
  variation_id TEXT NOT NULL CHECK (variation_id <> ''),
  item_id TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL CHECK (method IN ('scale_code', 'name', 'person', 'generated', 'same_item')),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (card_id, catalog)
) STRICT;
CREATE UNIQUE INDEX card_links_variation ON card_links(catalog, variation_id);

-- Every change to a card, oldest first, with who and when. before and after hold what changed.
-- Append only. user_id is kept as it was, with no reference, so removing a user cannot alter it.
CREATE TABLE card_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  at TEXT NOT NULL,
  user_id INTEGER,
  username TEXT NOT NULL DEFAULT '',
  change TEXT NOT NULL CHECK (change IN ('created', 'reimported', 'edited', 'linked', 'unlinked', 'code_seen', 'checked', 'retired')),
  before TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(before)),
  after TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(after))
) STRICT;
CREATE INDEX card_history_card ON card_history(card_id, id);
CREATE TRIGGER card_history_no_update BEFORE UPDATE ON card_history
BEGIN SELECT RAISE(ABORT, 'card_history is append only'); END;
CREATE TRIGGER card_history_no_delete BEFORE DELETE ON card_history
BEGIN SELECT RAISE(ABORT, 'card_history is append only'); END;

-- A person said this stored card is not this Square variation, in this catalog, so it is not
-- suggested for it again. Cards keep their ids across imports, so this outlives an import.
CREATE TABLE card_link_rejections (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
  catalog TEXT NOT NULL CHECK (catalog <> ''),
  variation_id TEXT NOT NULL CHECK (variation_id <> ''),
  rejected_by INTEGER,
  rejected_by_name TEXT NOT NULL DEFAULT '',
  rejected_at TEXT NOT NULL,
  PRIMARY KEY (card_id, catalog, variation_id)
) STRICT;
`,
  },
  {
    version: 6,
    name: 'invoice runs: files, jobs, decisions, catalog copies, price overrides',
    // One run per uploaded invoice (src/runs/). Times are milliseconds since 1970. Everything a
    // manager decides is also written to the audit log with the run id, the user and the time.
    sql: `
-- The catalog a run was matched against, kept so every decision is checked against the same
-- catalog the choices came from. Stored once per content (sha256), gzipped JSON of the objects.
CREATE TABLE catalog_snapshots (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  source TEXT NOT NULL CHECK (source IN ('square_sandbox', 'file')),
  location_id TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- state follows src/runs/states.ts. read_result holds the reading as the checks left it.
-- pending_approval is a reading stopped at the cost cap: kept here only, never sent to a browser,
-- and resumed only from this copy once an admin approves that model and estimate.
-- evaluation is the last match, pricing and blockers worked out for the run, for lists.
-- dry_run is the change preview; dry_run_hash ties an approval to the preview that was shown.
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('uploaded', 'reading', 'needs_approval', 'retry', 'review', 'ready', 'dry_run_done', 'approved', 'sending', 'done', 'partial', 'failed')),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  catalog_snapshot_id INTEGER REFERENCES catalog_snapshots(id) ON DELETE RESTRICT,
  read_status TEXT NOT NULL DEFAULT '' CHECK (read_status IN ('', 'ok', 'review', 'needs_approval', 'retry')),
  read_result TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(read_result)),
  pending_approval TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(pending_approval)),
  approval_model TEXT NOT NULL DEFAULT '',
  approval_estimate_usd TEXT NOT NULL DEFAULT '',
  cost_approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cost_approved_by_name TEXT NOT NULL DEFAULT '',
  cost_approved_at INTEGER,
  evaluation TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(evaluation)),
  blockers INTEGER NOT NULL DEFAULT 0,
  dry_run TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(dry_run)),
  dry_run_hash TEXT NOT NULL DEFAULT '',
  dry_run_at INTEGER,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_by_name TEXT NOT NULL DEFAULT '',
  approved_at INTEGER,
  message TEXT NOT NULL DEFAULT '',
  -- When this run read its catalog. A catalog copy is stored once and shared, so its own time
  -- is the first time it was seen.
  catalog_taken_at TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX runs_state ON runs(state);
CREATE INDEX runs_created ON runs(created_by, created_at);

-- Uploaded files live under the upload folder with random names, mode 600. original_name is for
-- display only, cleaned and cut, and never used as a path.
CREATE TABLE run_files (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  stored_name TEXT NOT NULL UNIQUE CHECK (length(stored_name) = 32),
  original_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('jpeg', 'png', 'webp', 'heif', 'pdf')),
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, position)
) STRICT;

-- Background work, one job at a time. A job left running by a restart is picked up again on start.
CREATE TABLE run_jobs (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('process', 'dry_run')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'interrupted')),
  resume_approved INTEGER NOT NULL DEFAULT 0 CHECK (resume_approved IN (0, 1)),
  queued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX run_jobs_state ON run_jobs(state, id);
CREATE INDEX run_jobs_run ON run_jobs(run_id);

-- Progress lines for the run page.
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  stage TEXT NOT NULL,
  message TEXT NOT NULL
) STRICT;
CREATE INDEX run_events_run ON run_events(run_id, id);

-- The manager's current decisions for a run, one per kind and target (a line number, a variation
-- id, a check id or 'supplier'). The audit log keeps every change.
CREATE TABLE run_decisions (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  UNIQUE (run_id, kind, target)
) STRICT;

-- A price set by a person that sticks to a Square variation (brief, Price overrides). Read by
-- pricing now; set and removed when a run is sent (step 7) and from the edit screens (Phase 2).
-- A case size or unit weight a person gave for a saved match, used next time the line's pack
-- cannot be read from the invoice. Exactly one of the two is set. variation_id is the Square
-- variation it was given for: it applies only while the match and the line point there.
CREATE TABLE item_mapping_packs (
  mapping_id INTEGER PRIMARY KEY REFERENCES item_mappings(id) ON DELETE CASCADE,
  variation_id TEXT NOT NULL CHECK (variation_id <> ''),
  units_per_case INTEGER CHECK (units_per_case IS NULL OR (units_per_case > 0 AND units_per_case <= 10000)),
  pounds_per_unit TEXT CHECK (pounds_per_unit IS NULL OR pounds_per_unit <> ''),
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  set_by_name TEXT NOT NULL DEFAULT '',
  set_at INTEGER NOT NULL,
  CHECK ((units_per_case IS NULL) <> (pounds_per_unit IS NULL))
) STRICT;

-- After approval, a line found not to have arrived: the stock to take back out of Square and
-- the credit to claim. state is 'pending' until step 7 writes the stock change.
CREATE TABLE run_corrections (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  variation_id TEXT NOT NULL DEFAULT '',
  stock_take_back TEXT NOT NULL DEFAULT '',
  stock_unit TEXT NOT NULL DEFAULT '' CHECK (stock_unit IN ('', 'lb', 'unit')),
  credit_cents INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent')),
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recorded_by_name TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE (run_id, line)
) STRICT;

-- Every upload attempt, refused or not, for the per-person rate. Rows older than a day are pruned.
CREATE TABLE upload_attempts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX upload_attempts_user ON upload_attempts(user_id, at);
CREATE INDEX upload_attempts_at ON upload_attempts(at);

CREATE TABLE price_overrides (
  variation_id TEXT PRIMARY KEY CHECK (variation_id <> ''),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  note TEXT NOT NULL DEFAULT '',
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  set_by_name TEXT NOT NULL DEFAULT '',
  set_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    version: 7,
    name: 'card copy in invoice runs, and a spend ledger for model calls',
    // Card copy written for a run (src/runs/card-copy.ts), one row per run and Square variation,
    // and the money every model call may have cost (src/runs/spend.ts).
    sql: `
-- state: requested (a person asked for copy), calling (a call to the model is under way: a
-- restart leaves it, and it is never sent again on its own), written or review (a card was
-- stored), failed, needs_approval (over the budget: approval_usd with approval_model is waiting
-- for an admin), approved (an admin did; the next job writes it), interrupted (ShelfReady
-- restarted mid-call, so a person must ask again). What it cost is in model_spend.
CREATE TABLE run_copy (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  variation_id TEXT NOT NULL CHECK (variation_id <> ''),
  state TEXT NOT NULL CHECK (state IN ('requested', 'calling', 'written', 'review', 'failed', 'needs_approval', 'approved', 'interrupted')),
  card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  reasons TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons)),
  approval_model TEXT NOT NULL DEFAULT '',
  approval_usd TEXT NOT NULL DEFAULT '',
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_by_name TEXT NOT NULL DEFAULT '',
  approved_at INTEGER,
  requested_by_name TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  UNIQUE (run_id, variation_id)
) STRICT;
CREATE INDEX run_copy_state ON run_copy(state);

-- Every model call that may cost money, for the budgets. A row is written as reserved, at the
-- call's worst case, before the call goes out, and set to the real cost (booked) when it comes
-- back. A restart books whatever is still reserved at its worst case (estimate = 1), since that
-- call may have been paid for. Budgets add up both states. The audit log keeps the detail.
CREATE TABLE model_spend (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('read', 'copy')),
  variation_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('reserved', 'booked')),
  usd REAL NOT NULL CHECK (usd >= 0),
  estimate INTEGER NOT NULL DEFAULT 0 CHECK (estimate IN (0, 1)),
  at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX model_spend_at ON model_spend(at);
CREATE INDEX model_spend_run ON model_spend(run_id, kind);
-- Readings made before this version, from the run log.
INSERT INTO model_spend (run_id, kind, state, usd, estimate, at, updated_at)
  SELECT a.run_id, 'read', 'booked', max(0, coalesce(json_extract(a.details, '$.totalCostUsd'), 0)), 0,
    CAST(strftime('%s', a.at) AS INTEGER) * 1000, CAST(strftime('%s', a.at) AS INTEGER) * 1000
  FROM audit_log a JOIN runs r ON r.id = a.run_id WHERE a.action = 'run.read';

-- 1 once the run's automatic first pass of card copy is done. After that, copy is written only
-- for a product a person asks for, or whose cost an admin approved.
ALTER TABLE runs ADD COLUMN copy_auto_done INTEGER NOT NULL DEFAULT 0 CHECK (copy_auto_done IN (0, 1));
`,
  },
  {
    version: 8,
    name: 'sending a run to Square and the scales, with pending scales and resend',
    // Step 7 (src/runs/square-send.ts, src/runs/scale-push.ts). run_jobs is rebuilt to take the
    // new job kinds. The other tables are new.
    sql: `
CREATE TABLE run_jobs_new (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('process', 'dry_run', 'send_square', 'scale_preview', 'send_scales', 'scale_lookup', 'resend_compare', 'resend_apply', 'corrections')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'interrupted')),
  resume_approved INTEGER NOT NULL DEFAULT 0 CHECK (resume_approved IN (0, 1)),
  queued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT NOT NULL DEFAULT ''
) STRICT;
INSERT INTO run_jobs_new (id, run_id, kind, state, resume_approved, queued_by, created_at, started_at, finished_at, error)
  SELECT id, run_id, kind, state, resume_approved, queued_by, created_at, started_at, finished_at, error FROM run_jobs;
DROP TABLE run_jobs;
ALTER TABLE run_jobs_new RENAME TO run_jobs;
CREATE INDEX run_jobs_state ON run_jobs(state, id);
CREATE INDEX run_jobs_run ON run_jobs(run_id);

-- One row per run once a person presses Send. phase is the step within sending (the run's own
-- state stays sending, partial or done). scales: the scales this send targets, chosen by the
-- person (all, or FRONT alone for a test run). all_scales: every scale ScaleConnect reported.
-- snapshot: what each Square item and variation held when it was first read before any write,
-- so a retry can tell our own writes from someone else's.
CREATE TABLE run_sends (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('sending_square', 'square_done', 'square_failed', 'scale_preview', 'sending_scales', 'done', 'partial')),
  scales TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scales)),
  all_scales TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(all_scales)),
  started_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_by_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(snapshot)),
  square_report TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(square_report)),
  message TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
) STRICT;

-- Every Square write, stored with its idempotency key and exact body before it is sent. A write
-- whose reply was lost stays 'sending' and is sent again with the same key and body, so Square
-- never applies it twice. 'failed' means Square refused it, so nothing of it landed.
CREATE TABLE square_writes (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step TEXT NOT NULL CHECK (step IN ('rename', 'variations', 'inventory', 'correction')),
  idempotency_key TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL CHECK (json_valid(body)),
  object_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(object_ids)),
  state TEXT NOT NULL CHECK (state IN ('sending', 'confirmed', 'failed')),
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX square_writes_run ON square_writes(run_id, id);

-- Each ScaleConnect preview a run made, and what became of it. kind push: the run's price
-- changes. kind settle: one missed item on one scale, for a resend. preview keeps what the person
-- was shown (warnings, drift, scales left out). ack is what the person accepted, with who and when.
CREATE TABLE scale_steps (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('push', 'settle')),
  scale TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  preview_id TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(preview)),
  state TEXT NOT NULL CHECK (state IN ('previewed', 'blocked', 'acknowledged', 'applying', 'unknown', 'success', 'partial', 'failed', 'refused', 'replaced')),
  ack TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(ack)),
  result TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(result)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX scale_steps_run ON scale_steps(run_id, id);

-- A scale that did not confirm a price from this run: the code, the price it is missing and why.
-- resolved once a settle verified it there, or a settle preview found it already matching.
CREATE TABLE scale_pending (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  scale TEXT NOT NULL,
  code TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('not_verified', 'not_targeted', 'may_be_frozen', 'not_known')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'resolved')),
  resolved_how TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  UNIQUE (run_id, scale, code)
) STRICT;

-- A resend for one pending scale: a person confirmed someone looked at it (looked), the compare
-- of that scale alone ran (still_frozen when it did not answer), the settles were previewed.
CREATE TABLE scale_resends (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  scale TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('looked', 'still_frozen', 'previewed', 'applying', 'done', 'stopped')),
  looked_by_name TEXT NOT NULL,
  looked_at INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, scale)
) STRICT;
`,
  },
  {
    version: 9,
    name: 'shelf card sheets for a run, with their rendered check',
    // Step 8 (src/runs/card-sheets.ts). kind run: exactly the approved cards. kind reprint: cards
    // a person chose later. stored_name is the random file name under the sheet folder, sha256 its
    // hash. cards: what is on the sheet, in printed order. check_state: queued, checking, then
    // passed, failed (a real failure: clipped text or a wrong page count, which blocks the
    // download) or unchecked (the check could not run, offered with a warning).
    sql: `
CREATE TABLE card_sheets (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('run', 'reprint')),
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  slots INTEGER NOT NULL,
  cards TEXT NOT NULL CHECK (json_valid(cards)),
  dry_run_hash TEXT NOT NULL,
  check_state TEXT NOT NULL CHECK (check_state IN ('queued', 'checking', 'passed', 'failed', 'unchecked')),
  check_result TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(check_result)),
  check_message TEXT NOT NULL DEFAULT '',
  checked_at INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX card_sheets_run ON card_sheets(run_id, id);
CREATE INDEX card_sheets_check ON card_sheets(check_state, id);
CREATE UNIQUE INDEX card_sheets_one_run_sheet ON card_sheets(run_id) WHERE kind = 'run';
`,
  },
  {
    version: 10,
    name: 'the fish email in Mailchimp: dry run previews, tasks and copies',
    // Step 11a (src/mailchimp/). mailchimp_previews: what the dry run showed for the fish email,
    // tied to that dry run's hash. mailchimp_tasks: each piece of work on the fish email, one at a
    // time: kind run (after an invoice's Square send) or check (the evening and morning checks,
    // one per slot). progress holds the target campaign and how far the work got, so a restart
    // carries on without doing anything twice. alert is what the home page shows: note, warn, or
    // red (no fish email is sure to go out: a person must look). mailchimp_copies: every copy
    // ShelfReady asked Mailchimp to make, stored before the call, so a lost answer is looked for
    // and never copied again blindly. mailchimp_clock: when the check clock last ran.
    sql: `
CREATE TABLE mailchimp_previews (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  dry_run_hash TEXT NOT NULL,
  preview TEXT NOT NULL CHECK (json_valid(preview)),
  made_at INTEGER NOT NULL
) STRICT;

CREATE TABLE mailchimp_tasks (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('run', 'check')),
  run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  slot TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'stopped', 'needs_person')),
  plan TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(plan)),
  progress TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress)),
  result TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(result)),
  message TEXT NOT NULL DEFAULT '',
  alert TEXT NOT NULL DEFAULT '' CHECK (alert IN ('', 'note', 'warn', 'red')),
  alert_cleared_by_name TEXT NOT NULL DEFAULT '',
  alert_cleared_at INTEGER,
  not_before INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((kind = 'run') = (run_id IS NOT NULL)),
  CHECK ((kind = 'check') = (slot IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX mailchimp_tasks_one_per_run ON mailchimp_tasks(run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX mailchimp_tasks_one_per_slot ON mailchimp_tasks(slot) WHERE slot IS NOT NULL;
CREATE INDEX mailchimp_tasks_state ON mailchimp_tasks(state, id);

CREATE TABLE mailchimp_copies (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES mailchimp_tasks(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  source_title TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('asking', 'made', 'not_made')),
  campaign_id TEXT NOT NULL DEFAULT '',
  looks INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX mailchimp_copies_task ON mailchimp_copies(task_id, id);

-- When the check clock last ran, so a start after a long stop can name the checks that never ran.
CREATE TABLE mailchimp_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_tick INTEGER NOT NULL
) STRICT;
`,
  },
  {
    version: 11,
    name: 'the fish email: one tracked campaign per fish day, and held price changes',
    // Bart, November 10 (src/mailchimp/). mailchimp_fish_days: the one campaign ShelfReady uses for
    // each fish day, by its Mailchimp id, kept even while staff have it unscheduled as a draft, so a
    // second one is never made. how: copied (ShelfReady made it) or adopted (staff scheduled it and
    // ShelfReady took it on). mailchimp_held: each invoice price change Square confirmed, kept until
    // it is in a fish email. row_count: the fish rows the email had when ShelfReady first read it,
    // so a campaign staff reuse for something else is never scheduled as the fish email.
    // dismissed_by_name and dismissed_at: an admin set aside a held change over three weeks old,
    // so it is no longer listed. day is the fish day it was first meant for; a change not yet in an
    // email goes into the next one. applied_day and applied_at say which email took it, and when.
    sql: `
CREATE TABLE mailchimp_fish_days (
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  campaign_id TEXT NOT NULL UNIQUE,
  how TEXT NOT NULL CHECK (how IN ('copied', 'adopted')),
  task_id INTEGER REFERENCES mailchimp_tasks(id) ON DELETE SET NULL,
  row_count INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE mailchimp_held (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  row_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  variation_id TEXT NOT NULL,
  label TEXT NOT NULL,
  to_cents INTEGER NOT NULL CHECK (to_cents > 0),
  per_pound INTEGER NOT NULL CHECK (per_pound IN (0, 1)),
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  applied_day TEXT,
  applied_at INTEGER,
  dismissed_by_name TEXT,
  dismissed_at INTEGER
) STRICT;
CREATE INDEX mailchimp_held_open ON mailchimp_held(applied_at, day, id);
`,
  },
  {
    version: 12,
    name: 'the purchase history: old invoices recorded only, and the lines of every invoice run',
    // src/history/. An old invoice is read and its lines are kept, nothing else: no run, no
    // Square, no scales, no cards. An invoice run's reading is recorded here too, so the purchase
    // history covers every invoice. Times are milliseconds since 1970. Every upload, reading and
    // removal is also in the audit log with who and when.
    sql: `
-- source: old (an old invoice uploaded for the history, record only) or run (the lines of an
-- invoice run, recorded when its reading finishes and refreshed when a person says what arrived).
-- run_id is the run, for source run only. A run's row goes when the run does.
-- state: uploaded (waiting for the reader), reading, done (lines saved) or failed (message says
-- why: a file that could not be read, a duplicate, or a reading that could not be made).
-- vendor and invoice_number are as printed; the _key columns are folded for the duplicate check.
-- invoice_date_iso is YYYY-MM-DD, or '' when no date could be read. checks: problems with the
-- whole invoice that can make line values wrong (the lines do not add up, a page is missing), so
-- every line is flagged for them, as a JSON list of plain sentences. notes: facts about the whole
-- invoice that do not change a line (an unsure date, no invoice number). reading: what the reader
-- returned, after the checks bounded it, kept so the lines can be checked again later.
CREATE TABLE purchase_invoices (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'old' CHECK (source IN ('old', 'run')),
  run_id INTEGER UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('uploaded', 'reading', 'done', 'failed')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  vendor TEXT NOT NULL DEFAULT '',
  vendor_key TEXT NOT NULL DEFAULT '',
  invoice_number TEXT NOT NULL DEFAULT '',
  invoice_number_key TEXT NOT NULL DEFAULT '',
  invoice_date TEXT NOT NULL DEFAULT '',
  invoice_date_iso TEXT NOT NULL DEFAULT '' CHECK (invoice_date_iso = '' OR invoice_date_iso GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  total_cents INTEGER,
  read_status TEXT NOT NULL DEFAULT '' CHECK (read_status IN ('', 'ok', 'review', 'needs_approval', 'retry')),
  models TEXT NOT NULL DEFAULT '',
  final_model TEXT NOT NULL DEFAULT '',
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  cost_is_estimate INTEGER NOT NULL DEFAULT 0 CHECK (cost_is_estimate IN (0, 1)),
  checks TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(checks) AND json_type(checks) = 'array'),
  notes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(notes) AND json_type(notes) = 'array'),
  reading TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(reading)),
  line_count INTEGER NOT NULL DEFAULT 0,
  needs_check_count INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  CHECK ((source = 'run') = (run_id IS NOT NULL)),
  CHECK (source = 'old' OR state = 'done')
) STRICT;
CREATE INDEX purchase_invoices_state ON purchase_invoices(state, id);
CREATE INDEX purchase_invoices_date ON purchase_invoices(invoice_date_iso);
-- One recorded old copy of each invoice: the same vendor and invoice number is refused. A run may
-- share them with an old invoice; the spreadsheet then uses the run (src/history/store.ts).
CREATE UNIQUE INDEX purchase_invoices_one ON purchase_invoices(vendor_key, invoice_number_key)
  WHERE state = 'done' AND source = 'old' AND vendor_key <> '' AND invoice_number_key <> '';
CREATE INDEX purchase_invoices_keys ON purchase_invoices(vendor_key, invoice_number_key);

-- The photos or PDF, kept like run files: random names, mode 600, in their own folder.
CREATE TABLE purchase_files (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  stored_name TEXT NOT NULL UNIQUE CHECK (length(stored_name) = 32),
  original_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('jpeg', 'png', 'webp', 'heif', 'pdf')),
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (invoice_id, position)
) STRICT;
CREATE INDEX purchase_files_sha ON purchase_files(sha256);
CREATE INDEX purchase_files_created ON purchase_files(created_at);

-- One row per invoice line. The printed fields are text exactly as the reader gave them.
-- qty, qty_unit and price_per are what the spreadsheet shows: for a line priced by weight, qty is
-- the weight in pounds. file_position and page say which photo (or PDF page) the line is on.
-- needs_check is 1 when a person should compare the line with its photo; reasons says why.
-- notes holds plain facts that are not a problem, such as an allowance.
CREATE TABLE purchase_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  page INTEGER NOT NULL DEFAULT 0,
  file_position INTEGER NOT NULL DEFAULT 0,
  item_number TEXT NOT NULL DEFAULT '',
  upc TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL DEFAULT '',
  pack_size TEXT NOT NULL DEFAULT '',
  units_per_pack TEXT NOT NULL DEFAULT '',
  pack TEXT NOT NULL DEFAULT '',
  qty_shipped TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  weight TEXT NOT NULL DEFAULT '',
  unit_price TEXT NOT NULL DEFAULT '',
  price_unit TEXT NOT NULL DEFAULT '',
  allowance TEXT NOT NULL DEFAULT '',
  extension TEXT NOT NULL DEFAULT '',
  qty TEXT NOT NULL DEFAULT '',
  qty_unit TEXT NOT NULL DEFAULT '',
  price_per TEXT NOT NULL DEFAULT '',
  extension_cents INTEGER,
  printed_status TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT '',
  confidence_note TEXT NOT NULL DEFAULT '',
  needs_check INTEGER NOT NULL DEFAULT 0 CHECK (needs_check IN (0, 1)),
  reasons TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons) AND json_type(reasons) = 'array'),
  notes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(notes) AND json_type(notes) = 'array'),
  UNIQUE (invoice_id, n)
) STRICT;

-- Readings of old invoices count toward the daily limit on model spend like any other reading.
-- run_id stays null for them. source says the money was for an old invoice, and stays so after the
-- invoice is removed, so old invoices can be held to their share of the daily limit.
-- purchase_invoice_id says which old invoice, while it exists.
ALTER TABLE model_spend ADD COLUMN source TEXT NOT NULL DEFAULT 'run' CHECK (source IN ('run', 'history'));
ALTER TABLE model_spend ADD COLUMN purchase_invoice_id INTEGER REFERENCES purchase_invoices(id) ON DELETE SET NULL;
CREATE INDEX model_spend_source ON model_spend(source, at);
CREATE INDEX model_spend_purchase ON model_spend(purchase_invoice_id) WHERE purchase_invoice_id IS NOT NULL;

-- Upload attempts by kind: old invoices have their own hourly limit per person.
ALTER TABLE upload_attempts ADD COLUMN kind TEXT NOT NULL DEFAULT 'run' CHECK (kind IN ('run', 'history'));
CREATE INDEX upload_attempts_kind ON upload_attempts(user_id, kind, at);
`,
  },
  {
    version: 13,
    name: 'catalog copies may come from live Square',
    // Going live (docs/GO-LIVE.md). A run's catalog records the Square it was read in, so a run
    // read in the sandbox is never sent live, and the reverse (src/square/origins.ts). The table is
    // rebuilt to widen its CHECK. Every row and id is kept, so runs keep their catalog.
    sql: `
CREATE TABLE catalog_snapshots_new (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  source TEXT NOT NULL CHECK (source IN ('square_sandbox', 'square_production', 'file')),
  location_id TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
INSERT INTO catalog_snapshots_new (id, sha256, source, location_id, taken_at, data, created_at)
  SELECT id, sha256, source, location_id, taken_at, data, created_at FROM catalog_snapshots;
DROP TABLE catalog_snapshots;
ALTER TABLE catalog_snapshots_new RENAME TO catalog_snapshots;
`,
  },
];
