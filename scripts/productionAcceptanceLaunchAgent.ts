import path from "node:path";

export interface LaunchAgentPlistOptions {
  home: string;
  cwd: string;
  label: string;
  programArguments: string[];
}

export interface LaunchAgentPlist {
  body: string;
  logDirectory: string;
  stdoutPath: string;
  stderrPath: string;
}

type LaunchctlRunner = (arguments_: string[]) => Promise<void>;

function commandExitCode(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : null;
}

export async function bootoutLaunchAgent(
  target: string,
  runLaunchctl: LaunchctlRunner,
): Promise<void> {
  try {
    await runLaunchctl(["bootout", target]);
    return;
  } catch (bootoutError) {
    if (commandExitCode(bootoutError) !== "COMMAND_EXIT_3") throw bootoutError;
    try {
      await runLaunchctl(["print", target]);
    } catch (printError) {
      if (commandExitCode(printError) === "COMMAND_EXIT_113") return;
      throw printError;
    }
    throw bootoutError;
  }
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildLaunchAgentPlist(options: LaunchAgentPlistOptions): LaunchAgentPlist {
  const logDirectory = path.join(
    options.home,
    "Library",
    "Logs",
    "dailyNews-production-acceptance",
  );
  const stdoutPath = path.join(logDirectory, "stdout.log");
  const stderrPath = path.join(logDirectory, "stderr.log");
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(options.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...options.programArguments.map((argument) => `    <string>${xml(argument)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(options.cwd)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>60</integer>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(stderrPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

  return { body, logDirectory, stdoutPath, stderrPath };
}
