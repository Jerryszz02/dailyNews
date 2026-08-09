import { spawn } from "node:child_process";

interface CommandOptions {
  cwd: string;
  capture?: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

function runCommandAttempt(
  command: string,
  args: string[],
  options: CommandOptions,
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

function retryableCommandError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return (
    code === "COMMAND_EXIT_1" ||
    code === "COMMAND_TIMEOUT" ||
    code === "EAI_AGAIN" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT"
  );
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<string> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runCommandAttempt(command, args, options);
    } catch (error) {
      if (attempt === maxAttempts || !retryableCommandError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 1_000));
    }
  }
  throw new Error("COMMAND_RETRY_EXHAUSTED");
}
