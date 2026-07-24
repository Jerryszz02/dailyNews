import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { collectSlotAudit } from "./productionAcceptanceAudit";
import {
  SLOT_MS,
  addSlots,
  advanceMonitorState,
  createMonitorState,
  evaluateSlotAudit,
  floorSlot,
  type MonitorState,
  type SlotVerdict,
} from "./productionAcceptanceRules";

const DEFAULT_ALIAS = "https://daily-news-tau-taupe.vercel.app";
const DEFAULT_OUTPUT = ".production-acceptance/current";
const DEFAULT_SLOT_DELAY_SECONDS = 75;
const MISSED_SLOT_TOLERANCE_MS = 13 * 60 * 1000;

interface CliOptions {
  command: "start" | "run" | "status" | "stop";
  deployment: string | null;
  alias: string;
  output: string;
  firstSlot: string | null;
  slotDelaySeconds: number;
  maxRuntimeDays: number;
  once: boolean;
  keepAwake: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const command =
    argv[0] === "start" || argv[0] === "status" || argv[0] === "stop" ? argv[0] : "run";
  const options: CliOptions = {
    command,
    deployment: null,
    alias: DEFAULT_ALIAS,
    output: DEFAULT_OUTPUT,
    firstSlot: null,
    slotDelaySeconds: DEFAULT_SLOT_DELAY_SECONDS,
    maxRuntimeDays: 21,
    once: false,
    keepAwake: false,
  };
  const args =
    command === "start" || command === "status" || command === "stop"
      ? argv.slice(1)
      : argv[0] === "run"
        ? argv.slice(1)
        : argv;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--deployment" && value) {
      options.deployment = value;
      index += 1;
    } else if (arg === "--alias" && value) {
      options.alias = value.replace(/\/+$/, "");
      index += 1;
    } else if (arg === "--output" && value) {
      options.output = value;
      index += 1;
    } else if (arg === "--first-slot" && value) {
      options.firstSlot = value;
      index += 1;
    } else if (arg === "--slot-delay-seconds" && value) {
      options.slotDelaySeconds = Number(value);
      index += 1;
    } else if (arg === "--max-runtime-days" && value) {
      options.maxRuntimeDays = Number(value);
      index += 1;
    } else if (arg === "--once") {
      options.once = true;
    } else if (arg === "--keep-awake") {
      options.keepAwake = true;
    } else {
      throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
    }
  }

  if (!Number.isFinite(options.slotDelaySeconds) || options.slotDelaySeconds < 60) {
    throw new Error("SLOT_DELAY_MUST_BE_AT_LEAST_60_SECONDS");
  }
  if (!Number.isFinite(options.maxRuntimeDays) || options.maxRuntimeDays < 8) {
    throw new Error("MAX_RUNTIME_MUST_BE_AT_LEAST_8_DAYS");
  }
  if (options.deployment && !/^dpl_[A-Za-z0-9]+$/.test(options.deployment)) {
    throw new Error("DEPLOYMENT_ID_INVALID");
  }
  const aliasUrl = new URL(options.alias);
  if (aliasUrl.protocol !== "https:") throw new Error("ALIAS_MUST_USE_HTTPS");
  return options;
}

function resolveFirstSlot(value: string | null, now = new Date()): string {
  if (!value || value === "next") return addSlots(floorSlot(now), 1);
  if (value === "latest") return floorSlot(now);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || floorSlot(parsed) !== parsed.toISOString()) {
    throw new Error("FIRST_SLOT_MUST_BE_A_15_MINUTE_UTC_BOUNDARY");
  }
  return parsed.toISOString();
}

function atomicWriteJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function appendJsonLine(file: string, value: unknown): void {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function safeCode(error: unknown): string {
  const raw =
    (error as { code?: unknown })?.code ??
    (error as { message?: unknown })?.message ??
    "UNKNOWN";
  return String(raw).toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 120);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; capture?: boolean; timeoutMs?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", options.capture ? "pipe" : "ignore", "ignore"],
    });
    let output = "";
    if (options.capture) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        if (output.length < 2_000_000) output += chunk;
      });
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error("COMMAND_TIMEOUT"), { code: "COMMAND_TIMEOUT" }));
    }, options.timeoutMs ?? 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(Object.assign(new Error("COMMAND_FAILED"), { code: `COMMAND_EXIT_${code}` }));
    });
  });
}

function executable(name: "npm" | "npx"): string {
  const besideNode = path.join(path.dirname(process.execPath), name);
  if (fs.existsSync(besideNode)) return besideNode;
  for (const directory of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
}

async function waitUntil(time: number): Promise<void> {
  while (Date.now() < time) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, time - Date.now())));
  }
}

function stateSummary(state: MonitorState) {
  return {
    status: state.status,
    phase: state.phase,
    expectedDeployment: state.expectedDeployment,
    alias: state.alias,
    attempt: state.attempt,
    baselineSlot: state.baselineSlot,
    burnIn: {
      baselinePassed: state.baselineSlot !== null,
      strictPassed: state.burnInStrictPassed,
      strictRequired: 96,
      passedAt: state.burnInPassedAt,
    },
    soak: {
      daysPassed: state.soakDaysPassed,
      daysRequired: 7,
      startedAt: state.soakStartedAt,
    },
    nextSlot: state.nextSlot,
    latestAuditAt: state.latestAuditAt,
    latestVerdict: state.latestVerdict,
    totals: {
      audited: state.totalSlotsAudited,
      passed: state.totalPassedSlots,
      failed: state.totalFailedSlots,
    },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    deadlineAt: state.deadlineAt,
    completedAt: state.completedAt,
  };
}

function loadState(output: string): MonitorState | null {
  const file = path.join(output, "state.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as MonitorState;
}

function saveState(output: string, state: MonitorState): void {
  atomicWriteJson(path.join(output, "state.json"), state);
  atomicWriteJson(path.join(output, "summary.json"), stateSummary(state));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(output: string): () => void {
  const file = path.join(output, "monitor.pid");
  if (fs.existsSync(file)) {
    const existing = Number(fs.readFileSync(file, "utf8").trim());
    if (Number.isInteger(existing) && existing !== process.pid && processIsAlive(existing)) {
      throw new Error("MONITOR_ALREADY_RUNNING");
    }
  }
  fs.writeFileSync(file, `${process.pid}\n`, { mode: 0o600 });
  return () => {
    try {
      if (Number(fs.readFileSync(file, "utf8").trim()) === process.pid) fs.unlinkSync(file);
    } catch {
      // A replaced or already-cleaned lock needs no further action.
    }
  };
}

function resetAfterRuntimeFailure(
  state: MonitorState,
  targetSlot: string,
  code: string,
  at = new Date(),
): MonitorState {
  const verdict: SlotVerdict = {
    passed: false,
    failures: [code],
    runId: null,
    reportId: null,
    duration: null,
  };
  const common = {
    ...state,
    updatedAt: at.toISOString(),
    latestAuditAt: at.toISOString(),
    latestVerdict: verdict,
    totalSlotsAudited: state.totalSlotsAudited + 1,
    totalFailedSlots: state.totalFailedSlots + 1,
  };
  if (at.getTime() > Date.parse(state.deadlineAt)) {
    return { ...common, status: "needs_review", phase: "needs_review" };
  }
  if (state.phase === "soak") {
    return {
      ...common,
      attempt: state.attempt + 1,
      soakDaysPassed: 0,
      soakStartedAt: null,
      nextSlot: addSlots(targetSlot, 96),
    };
  }
  return {
    ...common,
    phase: "seeking_baseline",
    attempt: state.attempt + 1,
    baselineSlot: null,
    burnInStrictPassed: 0,
    nextSlot: addSlots(targetSlot, 1),
  };
}

async function prepareTemporaryClient(root: string, cwd: string): Promise<string> {
  const clientRoot = path.join(root, "client");
  fs.mkdirSync(clientRoot, { mode: 0o700 });
  await runCommand(
    executable("npm"),
    [
      "install",
      "--prefix",
      clientRoot,
      "--no-save",
      "--no-package-lock",
      "--ignore-scripts",
      "pg",
      "dotenv",
    ],
    { cwd, timeoutMs: 120_000 },
  );
  return path.join(clientRoot, "node_modules");
}

async function auditSlot(options: {
  cwd: string;
  temporaryRoot: string;
  nodeModules: string;
  state: MonitorState;
  targetSlot: string;
}) {
  const envFile = path.join(options.temporaryRoot, `production-${crypto.randomUUID()}.env`);
  try {
    await runCommand(
      executable("npx"),
      [
        "--yes",
        "vercel",
        "env",
        "pull",
        envFile,
        "--environment=production",
        "--yes",
      ],
      { cwd: options.cwd, timeoutMs: 60_000 },
    );
    fs.chmodSync(envFile, 0o600);
    const inspectOutput = await runCommand(
      executable("npx"),
      ["--yes", "vercel", "inspect", options.state.alias, "--format=json"],
      { cwd: options.cwd, capture: true, timeoutMs: 45_000 },
    );
    const inspect = JSON.parse(inspectOutput) as {
      id?: unknown;
      readyState?: unknown;
      target?: unknown;
    };
    const inspectedDeploymentId =
      inspect.readyState === "READY" &&
      inspect.target === "production" &&
      typeof inspect.id === "string"
        ? inspect.id
        : null;
    return await collectSlotAudit({
      targetSlot: options.targetSlot,
      expectedDeployment: options.state.expectedDeployment,
      alias: options.state.alias,
      envFile,
      nodeModules: options.nodeModules,
      inspectedDeploymentId,
      includeRolling24h: options.state.phase === "soak",
    });
  } finally {
    fs.rmSync(envFile, { force: true });
  }
}

function printStatus(output: string): void {
  const state = loadState(output);
  if (!state) throw new Error("MONITOR_STATE_NOT_FOUND");
  const pidFile = path.join(output, "monitor.pid");
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8").trim()) : null;
  process.stdout.write(
    `${JSON.stringify(
      {
        ...stateSummary(state),
        monitorProcess: {
          running: Number.isInteger(pid) && processIsAlive(pid as number),
          pid: Number.isInteger(pid) ? pid : null,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function stopMonitor(output: string): Promise<void> {
  const labelFile = path.join(output, "launch-agent-label.txt");
  if (fs.existsSync(labelFile)) {
    const label = fs.readFileSync(labelFile, "utf8").trim();
    if (!/^com\.[A-Za-z0-9.-]+$/.test(label)) throw new Error("LAUNCH_AGENT_LABEL_INVALID");
    try {
      await runCommand(
        "/bin/launchctl",
        ["bootout", `gui/${process.getuid?.() ?? 0}/${label}`],
        { cwd: process.cwd(), timeoutMs: 15_000 },
      );
    } catch {
      // An already-exited job can still leave completed evidence to review.
    }
    fs.rmSync(labelFile, { force: true });
    const plistPointer = path.join(output, "launch-agent-plist.txt");
    if (fs.existsSync(plistPointer)) {
      const plist = fs.readFileSync(plistPointer, "utf8").trim();
      const expectedDirectory = path.join(os.homedir(), "Library", "LaunchAgents");
      if (
        path.dirname(plist) !== expectedDirectory ||
        path.basename(plist) !== `${label}.plist`
      ) {
        throw new Error("LAUNCH_AGENT_PLIST_PATH_INVALID");
      }
      fs.rmSync(plist, { force: true });
      fs.rmSync(plistPointer, { force: true });
    } else {
      fs.rmSync(path.join(output, "monitor.plist"), { force: true });
    }
  }
  const pidFile = path.join(output, "monitor.pid");
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && processIsAlive(pid)) process.kill(pid, "SIGTERM");
  }
  process.stdout.write("MONITOR_STOP_REQUESTED\n");
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function startMonitorAgent(options: CliOptions): Promise<void> {
  if (!options.deployment) throw new Error("DEPLOYMENT_ID_REQUIRED");
  process.umask(0o077);
  const cwd = process.cwd();
  const output = path.resolve(cwd, options.output);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.chmodSync(output, 0o700);
  const pidFile = path.join(output, "monitor.pid");
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && processIsAlive(pid)) throw new Error("MONITOR_ALREADY_RUNNING");
  }

  const label = "com.jerryszz.dailynews.production-acceptance";
  const uid = process.getuid?.() ?? 0;
  const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
  fs.mkdirSync(launchAgents, { recursive: true });
  const plist = path.join(launchAgents, `${label}.plist`);
  const tsxCli = path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxCli)) throw new Error("TSX_CLI_NOT_FOUND");
  const script = path.join(cwd, "scripts", "productionAcceptanceMonitor.ts");
  const programArguments = [
    "/usr/bin/env",
    "-i",
    `HOME=${os.homedir()}`,
    `PATH=${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    process.execPath,
    tsxCli,
    script,
    "run",
    "--deployment",
    options.deployment,
    "--alias",
    options.alias,
    "--output",
    output,
    "--first-slot",
    options.firstSlot ?? "next",
    "--slot-delay-seconds",
    String(options.slotDelaySeconds),
    "--max-runtime-days",
    String(options.maxRuntimeDays),
    ...(options.once ? ["--once"] : []),
    ...(options.keepAwake ? ["--keep-awake"] : []),
  ];
  const plistBody = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...programArguments.map((argument) => `    <string>${xml(argument)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(cwd)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <false/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(path.join(output, "stdout.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(path.join(output, "stderr.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  fs.writeFileSync(plist, plistBody, { mode: 0o600 });
  fs.writeFileSync(path.join(output, "launch-agent-label.txt"), `${label}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(output, "launch-agent-plist.txt"), `${plist}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(output, "stdout.log"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(output, "stderr.log"), "", { mode: 0o600 });
  atomicWriteJson(path.join(output, "launch-agent.json"), {
    label,
    expectedDeployment: options.deployment,
    alias: options.alias,
    installedAt: new Date().toISOString(),
  });

  try {
    await runCommand(
      "/bin/launchctl",
      ["bootout", `gui/${uid}/${label}`],
      { cwd, timeoutMs: 15_000 },
    );
  } catch {
    // The normal first-start case has no previously loaded job.
  }
  await runCommand(
    "/bin/launchctl",
    ["bootstrap", `gui/${uid}`, plist],
    { cwd, timeoutMs: 15_000 },
  );
  process.stdout.write("MONITOR_AGENT_STARTED\n");
}

async function runMonitor(options: CliOptions): Promise<void> {
  process.umask(0o077);
  const cwd = process.cwd();
  const output = path.resolve(cwd, options.output);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.chmodSync(output, 0o700);
  const releaseLock = acquireLock(output);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daily-news-monitor-"));
  fs.chmodSync(temporaryRoot, 0o700);
  let cleaningUp = false;
  const cleanup = () => {
    if (cleaningUp) return;
    cleaningUp = true;
    releaseLock();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  };
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    let state = loadState(output);
    if (!state) {
      if (!options.deployment) throw new Error("DEPLOYMENT_ID_REQUIRED");
      state = createMonitorState({
        deployment: options.deployment,
        alias: options.alias,
        firstSlot: resolveFirstSlot(options.firstSlot),
        maxRuntimeDays: options.maxRuntimeDays,
      });
      saveState(output, state);
      appendJsonLine(path.join(output, "events.jsonl"), {
        type: "monitor_started",
        at: state.createdAt,
        expectedDeployment: state.expectedDeployment,
        alias: state.alias,
        firstSlot: state.nextSlot,
      });
    } else {
      if (options.deployment && options.deployment !== state.expectedDeployment) {
        throw new Error("DEPLOYMENT_DOES_NOT_MATCH_EXISTING_STATE");
      }
      if (options.alias !== DEFAULT_ALIAS && options.alias !== state.alias) {
        throw new Error("ALIAS_DOES_NOT_MATCH_EXISTING_STATE");
      }
    }

    if (state.status !== "running") {
      printStatus(output);
      return;
    }

    if (options.keepAwake) {
      const caffeinate = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
        detached: true,
        stdio: "ignore",
      });
      caffeinate.unref();
    }

    const nodeModules = await prepareTemporaryClient(temporaryRoot, cwd);
    appendJsonLine(path.join(output, "events.jsonl"), {
      type: "temporary_client_ready",
      at: new Date().toISOString(),
    });

    while (state.status === "running") {
      const targetSlot = state.nextSlot;
      const captureAt = Date.parse(targetSlot) + options.slotDelaySeconds * 1000;
      await waitUntil(captureAt);

      if (Date.now() - Date.parse(targetSlot) > MISSED_SLOT_TOLERANCE_MS) {
        state = resetAfterRuntimeFailure(state, targetSlot, "monitor_missed_slot");
        appendJsonLine(path.join(output, "evidence.jsonl"), {
          type: "runtime_failure",
          targetSlot,
          at: state.latestAuditAt,
          verdict: state.latestVerdict,
        });
        saveState(output, state);
        if (options.once) break;
        continue;
      }

      try {
        const audit = await auditSlot({
          cwd,
          temporaryRoot,
          nodeModules,
          state,
          targetSlot,
        });
        const verdict = evaluateSlotAudit(audit, {
          requireRolling24h: state.phase === "soak",
        });
        appendJsonLine(path.join(output, "evidence.jsonl"), {
          type: "slot_audit",
          attempt: state.attempt,
          phase: state.phase,
          audit,
          verdict,
        });
        state = advanceMonitorState(state, audit, verdict);
        saveState(output, state);
      } catch (error) {
        const code = `audit_${safeCode(error).toLowerCase()}`;
        state = resetAfterRuntimeFailure(state, targetSlot, code);
        appendJsonLine(path.join(output, "evidence.jsonl"), {
          type: "runtime_failure",
          targetSlot,
          at: state.latestAuditAt,
          verdict: state.latestVerdict,
        });
        saveState(output, state);
      }

      if (options.once) break;
    }

    if (state.status === "passed") {
      atomicWriteJson(path.join(output, "final-report.json"), stateSummary(state));
      appendJsonLine(path.join(output, "events.jsonl"), {
        type: "monitor_completed",
        at: state.completedAt,
      });
    }
  } finally {
    cleanup();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const output = path.resolve(process.cwd(), options.output);
  if (options.command === "status") {
    printStatus(output);
    return;
  }
  if (options.command === "stop") {
    await stopMonitor(output);
    return;
  }
  if (options.command === "start") {
    await startMonitorAgent(options);
    return;
  }
  await runMonitor(options);
}

main().catch((error) => {
  process.stderr.write(`MONITOR_FAILED:${safeCode(error)}\n`);
  process.exit(1);
});
