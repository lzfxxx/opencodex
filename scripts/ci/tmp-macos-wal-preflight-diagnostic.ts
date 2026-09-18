/**
 * TEMPORARY DIAGNOSTIC - not part of the product, removed before the fix lands.
 *
 * Surfaces what a macOS runner actually does with a read-only open of a cleanly-closed
 * WAL store, because tests/codex-integration/codex-history-provider.test.ts:1680 fails
 * there and the assertion alone cannot say which step threw or with which error.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database, constants as sqliteConstants } from "bun:sqlite";
import { isStateDbCantOpenError, openCodexStateForPreflight } from "../../src/codex/history-state-open";

const IMMUTABLE_READONLY_FLAGS = sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI;

function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { thrown: String(error), typeofThrown: typeof error };
  const record: Record<string, unknown> = {
    constructor: error.constructor?.name,
    name: error.name,
    message: error.message,
    matchedByCurrentNarrowing: isStateDbCantOpenError(error),
  };
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === "stack" || key === "message") continue;
    record["own." + key] = (error as unknown as Record<string, unknown>)[key];
  }
  return record;
}

function sidecars(dbPath: string): Record<string, boolean> {
  return { wal: existsSync(dbPath + "-wal"), shm: existsSync(dbPath + "-shm") };
}

function report(step: string, payload: Record<string, unknown>): void {
  console.log("DIAG " + JSON.stringify({ step, ...payload }));
}

/** The fixture the failing test builds: WAL in the header, no sidecar on disk. */
function makeCheckpointedWalStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-wal-diag-"));
  const dbPath = join(dir, "state_5.sqlite");
  const db = new Database(dbPath);
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL, source TEXT NOT NULL)");
  db.run("INSERT INTO threads VALUES ('thread-1', '/tmp/rollout.jsonl', 'openai', 'cli')");
  const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = wal").all();
  const version = db.query<{ v: string }, []>("SELECT sqlite_version() AS v").all();
  report("fixture.built", { dbPath, journal, sqliteVersion: version[0]?.v, sidecarsBeforeClose: sidecars(dbPath) });
  db.close();
  report("fixture.closed", { sidecarsAfterClose: sidecars(dbPath) });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });
  report("fixture.ready", { sidecars: sidecars(dbPath) });
  return dbPath;
}

/** Open one way, then read, reporting which of the two steps failed and how. */
function probe(label: string, dbPath: string, open: (path: string) => Database): void {
  let db: Database | undefined;
  try {
    db = open(dbPath);
  } catch (error) {
    report(label + ".open", { ok: false, sidecars: sidecars(dbPath), error: describeError(error) });
    return;
  }
  report(label + ".open", { ok: true, sidecars: sidecars(dbPath) });
  try {
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(threads)").all();
    report(label + ".pragma", { ok: true, columns: columns.map(column => column.name), sidecars: sidecars(dbPath) });
  } catch (error) {
    report(label + ".pragma", { ok: false, sidecars: sidecars(dbPath), error: describeError(error) });
    db.close();
    return;
  }
  try {
    const rows = db.query<{ id: string }, []>("SELECT id FROM threads").all();
    report(label + ".select", { ok: true, rows: rows.length, sidecars: sidecars(dbPath) });
  } catch (error) {
    report(label + ".select", { ok: false, sidecars: sidecars(dbPath), error: describeError(error) });
  }
  db.close();
}

report("environment", {
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  bunRevision: Bun.revision,
  tmpdir: tmpdir(),
});

probe("readonlyOption", makeCheckpointedWalStore(), path => new Database(path, { readonly: true }));
probe("readonlyFlags", makeCheckpointedWalStore(), path => new Database(path, sqliteConstants.SQLITE_OPEN_READONLY));
probe("immutableUri", makeCheckpointedWalStore(), path => new Database(pathToFileURL(path).href + "?immutable=1", IMMUTABLE_READONLY_FLAGS));
probe("currentPolicy", makeCheckpointedWalStore(), path => openCodexStateForPreflight(path));
