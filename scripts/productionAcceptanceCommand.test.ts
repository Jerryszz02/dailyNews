import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "./productionAcceptanceCommand";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("production acceptance command retries", () => {
  it("retries a transient exit 1 once", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "daily-news-command-"));
    temporaryDirectories.push(directory);
    const marker = path.join(directory, "attempted");

    await expect(
      runCommand(
        "/bin/sh",
        ["-c", 'if [ -f "$1" ]; then exit 0; fi; touch "$1"; exit 1', "sh", marker],
        { cwd: directory, maxAttempts: 2, retryDelayMs: 0 },
      ),
    ).resolves.toBe("");
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("does not retry a non-transient exit code", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "daily-news-command-"));
    temporaryDirectories.push(directory);
    const attempts = path.join(directory, "attempts");

    await expect(
      runCommand(
        "/bin/sh",
        ["-c", 'echo attempt >> "$1"; exit 2', "sh", attempts],
        { cwd: directory, maxAttempts: 2, retryDelayMs: 0 },
      ),
    ).rejects.toMatchObject({ code: "COMMAND_EXIT_2" });
    expect(fs.readFileSync(attempts, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
