import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("an unconfigured runtime cannot call models", () => {
  const env = { ...process.env };
  delete env.MODEL_CALLS_ENABLED;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import { config } from "@aihot/backend/config"; console.log(config.modelCallsEnabled)'], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "false");
});

test("initialization leaves external work off and never prints generated secrets", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dailynews-init-"));
  try {
    const template = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    // The initializer is deliberately cwd-local; the real checkout and its credentials stay intact.
    writeFileSync(path.join(dir, ".env.example"), template);
    const env = { ...process.env };
    delete env.LLM_API_KEY;
    const result = spawnSync(process.execPath, [path.resolve("scripts/init-env.ts")], { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const created = readFileSync(path.join(dir, ".env"), "utf8");
    for (const name of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
      assert.match(created, new RegExp(`^${name}=false$`, "m"));
    }
    for (const name of ["ADMIN_PASSWORD", "SESSION_SECRET", "IMG_PROXY_SIGN_SECRET", "POSTGRES_PASSWORD"]) {
      const secret = created.match(new RegExp(`^${name}=(.+)$`, "m"))![1]!;
      assert.ok(secret.length >= 12);
      assert.ok(!result.stdout.includes(secret));
    }
    const repeated = spawnSync(process.execPath, [path.resolve("scripts/init-env.ts")], { cwd: dir, env, encoding: "utf8" });
    assert.equal(repeated.status, 1);
    assert.equal(readFileSync(path.join(dir, ".env"), "utf8"), created);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
