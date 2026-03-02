import { spawn, ChildProcess, execSync } from "child_process";
import path from "path";
import fs from "fs";

// Trust Windows certificate store
// Must be set before any TLS connections, and inherited by child processes
if (!process.env.NODE_OPTIONS?.includes("--use-system-ca")) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--use-system-ca"].filter(Boolean).join(" ");
}

// Simple wrapper that restarts the bot when it exits
let child: ChildProcess | null = null;
let crashCount = 0;
const MAX_CRASHES = 3;

// Use local node_modules .cmd binaries directly to avoid PATH issues (e.g. Task Scheduler)
const projectRoot = path.resolve(__dirname, "..");
const cmdExt = process.platform === "win32" ? ".cmd" : "";
const localTsc = path.join(projectRoot, "node_modules", ".bin", `tsc${cmdExt}`);
const localTsx = path.join(projectRoot, "node_modules", ".bin", `tsx${cmdExt}`);

// --- Logging setup ---
const logsDir = path.join(projectRoot, "logs");
fs.mkdirSync(logsDir, { recursive: true });

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

const logFileName = `${formatDate(new Date())}.log`;
const logPath = path.join(logsDir, logFileName);
const logStream = fs.createWriteStream(logPath, { flags: "a" });

function timestamp(): string {
  return new Date().toISOString();
}

function log(msg: string) {
  const line = `[${timestamp()}] ${msg}`;
  logStream.write(line + "\n");
  process.stdout.write(line + "\n");
}

function logError(msg: string) {
  const line = `[${timestamp()}] ${msg}`;
  logStream.write(line + "\n");
  process.stderr.write(line + "\n");
}

// Redirect child process output through the log with timestamps
function pipeWithTimestamps(stream: NodeJS.ReadableStream, isError = false) {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // keep incomplete last line in buffer
    for (const line of lines) {
      if (isError) {
        logError(line);
      } else {
        log(line);
      }
    }
  });
  stream.on("end", () => {
    if (buffer) {
      if (isError) {
        logError(buffer);
      } else {
        log(buffer);
      }
    }
  });
}

// --- Core logic ---

function typeCheck(): boolean {
  try {
    log("[wrapper] Running type check...");
    execSync(`"${localTsc}" --noEmit`, { stdio: "pipe", cwd: projectRoot, shell: true as any });
    log("[wrapper] Type check passed.");
    return true;
  } catch (err: any) {
    logError("[wrapper] Type check failed:");
    const error = err.stderr?.toString() || err.stdout?.toString() || err.message;
    logError(error);
    return false;
  }
}

function start() {
  // First run type check - if it fails, don't even try to start
  if (!typeCheck()) {
    logError("[wrapper] Not starting bot due to type errors. Fix the errors and restart manually.");
    process.exit(1);
  }

  log("[wrapper] Starting bot...");
  child = spawn(localTsx, ["src/index.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    cwd: projectRoot,
  });

  if (child.stdout) pipeWithTimestamps(child.stdout);
  if (child.stderr) pipeWithTimestamps(child.stderr, true);

  child.on("close", (code) => {
    child = null;
    if (code === 0) {
      log("[wrapper] Bot exited cleanly, restarting...");
      crashCount = 0; // Reset crash count on clean exit
      setTimeout(start, 500);
    } else {
      crashCount++;
      if (crashCount >= MAX_CRASHES) {
        logError(`[wrapper] Bot crashed ${MAX_CRASHES} times in a row. Stopping to prevent infinite loop.`);
        logError("[wrapper] Fix the errors and restart manually with: npm start");
        process.exit(1);
      }
      log(`[wrapper] Bot crashed (code ${code}), restarting in 3s... (${crashCount}/${MAX_CRASHES})`);
      setTimeout(start, 3000);
    }
  });
}

process.on("SIGINT", () => {
  log("[wrapper] Shutting down...");
  child?.kill();
  process.exit(0);
});

log(`[wrapper] Log file: ${logPath}`);
start();