/**
 * Make a store's database look like a library from before versioned migrations, so a test can drop a column and
 * watch the migrations bring it back. Such a library reports user_version 0 and keeps its money the old way: no
 * spend table, a cost on each version. The baseline step recreates the rest (the cost_ledger, versions.host_usd).
 */
export function asOldLibrary(db) {
  db.exec('DROP TABLE IF EXISTS spend; ALTER TABLE versions ADD COLUMN cost_usd REAL;');
  db.pragma('user_version = 0');
}
