// Offline legacy Supabase regression. Requires a fresh isolated PostgreSQL test cluster.
// Deliberately does not read DATABASE_URL or .env, create roles, or connect to cloud APIs.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

const connection = process.env.LEGACY_TEST_DATABASE_URL;
assert(connection, "LEGACY_TEST_DATABASE_URL is required");
const target = new URL(connection);
assert(["postgres:", "postgresql:"].includes(target.protocol), "PostgreSQL URL required");
assert.match(decodeURIComponent(target.pathname.slice(1)), /_(test|ci)$/, "Legacy database must end in _test or _ci");
const db = postgres(connection, { max: 1, onnotice: () => {} });
try {
  const [{ database }] = await db<{ database: string }[]>`SELECT current_database() AS database`;
  assert.match(database, /_(test|ci)$/, "Connected database must end in _test or _ci");
  const [{ objects }] = await db<{ objects: number }[]>`
    SELECT count(*)::int AS objects FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='daily_news' AND c.relkind IN ('r','v','m','S','f')`;
  assert.equal(objects, 0, "Refusing a nonempty daily_news schema; use a fresh disposable database");
  const requiredRoles = await db<{ rolname: string }[]>`
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`;
  assert.equal(requiredRoles.length, 3, "Provision anon/authenticated/service_role roles in the isolated cluster first");
  const [{ executor_exists }] = await db<{ executor_exists: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='daily_news_retention_executor') AS executor_exists`;
  assert(!executor_exists, "Retention role already exists; use a fresh isolated cluster, never remove another database's role");
  const migrationDir = new URL("../supabase/migrations/", import.meta.url);
  const migrations = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrations) {
    if (process.argv.includes("--upgrade-fixture") && file === "20261012223745_storage_retention.sql") {
      await db.begin(async (tx) => {
        for (const fixture of ["deployed_20260821070000_retention.sql", "retention_cron_stub.sql"]) {
          await tx.unsafe(readFileSync(new URL(`../supabase/tests/fixtures/${fixture}`, import.meta.url), "utf8")).simple();
        }
      });
      console.log("deployed six-argument retention and existing Cron fixtures installed");
    }
    await db.begin(async (tx) => { await tx.unsafe(readFileSync(new URL(file, migrationDir), "utf8")).simple(); });
    console.log(`legacy migration passed: ${file}`);
    if (file === "20261012223745_storage_retention.sql") {
      // Files commit independently: a failed follow-up must not leave a 250-row Cron running.
      for (const limit of [26, 250]) {
        await assert.rejects(db`SELECT * FROM public.daily_news_prune_retention(true, ${limit})`,
          (error: unknown) => (error as { code?: string }).code === "22023");
      }
      if (process.argv.includes("--upgrade-fixture")) {
        await db.unsafe(readFileSync(new URL("../supabase/tests/retention_upgrade_regression.sql", import.meta.url), "utf8")).simple();
      }
      console.log("initial migration is capped before the follow-up (including existing Cron state)");
    }
  }
  if (process.argv.includes("--upgrade-fixture")) {
    await db.unsafe(readFileSync(new URL("../supabase/tests/retention_upgrade_regression.sql", import.meta.url), "utf8")).simple();
    console.log("deployed retention upgrade assertions passed");
  } else {
    const [{ no_cron }] = await db<{ no_cron: boolean }[]>`SELECT to_regclass('cron.job') IS NULL AS no_cron`;
    assert(no_cron, "Fresh migration unexpectedly created a Cron relation");
  }
  await db.unsafe(readFileSync(new URL("../supabase/tests/retention_regression.sql", import.meta.url), "utf8")).simple();
  console.log("legacy retention assertions passed (fixtures rolled back)");
  await db.unsafe(readFileSync(new URL("../supabase/tests/retention_safety_regression.sql", import.meta.url), "utf8")).simple();
  console.log("bounded retention ACL and batch safety assertions passed");
  const [{ pgtap_available }] = await db<{ pgtap_available: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pgtap') AS pgtap_available`;
  if (!pgtap_available) {
    assert(!process.argv.includes("--require-pgtap"), "pgTAP is required but unavailable in this isolated server");
    console.log("pgTAP suites skipped: extension unavailable; plain retention assertions passed");
  } else {
    await db`CREATE SCHEMA IF NOT EXISTS extensions`;
    for (const file of ["daily_news_store_test.sql", "x_collection_cursor_test.sql"]) {
      const results = await db.unsafe(readFileSync(new URL(`../supabase/tests/${file}`, import.meta.url), "utf8")).simple();
      const lines = (results as unknown as Record<string, unknown>[][]).flatMap((rows) =>
        rows.flatMap((row) => Object.values(row).filter((value): value is string => typeof value === "string")));
      const failures = lines.filter((line) => /^not ok\b/m.test(line) || /^# (Looks like|Failed)/m.test(line));
      assert.equal(failures.length, 0, `${file} failed:\n${failures.join("\n")}`);
      const assertions = lines.filter((line) => /^ok\s+\d+\b/m.test(line)).length;
      assert(assertions > 0, `${file} produced no TAP assertions`);
      if (file === "daily_news_store_test.sql") assert.equal(assertions, 123, "Legacy store TAP plan must complete");
      console.log(`${file}: ${assertions} pgTAP assertions passed`);
    }
  }
} finally {
  await db.end();
}
