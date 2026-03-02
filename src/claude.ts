import { spawn, execSync } from "child_process";
import { createInterface } from "readline";
import fs from "fs";
import path from "path";
import { UserState, updateState } from "./state";
import { config } from "./config";

const TIMEOUT_MS = 10 * 60 * 1000; // 10 minute timeout

// Track the active process so it can be killed externally
let activeProc: ReturnType<typeof spawn> | null = null;

// Track todo list state for first-creation detection
let lastTodoCount = 0;

export function cancelCurrentRequest(): boolean {
  if (activeProc) {
    const pid = activeProc.pid;
    console.log(`[claude] Cancelling active request (PID: ${pid})`);
    // On Windows, .kill() only kills the shell, not the child process tree.
    // Use taskkill /F /T to force-kill the entire process tree.
    if (pid) {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
      } catch {
        // Process may have already exited
        activeProc.kill();
      }
    } else {
      activeProc.kill();
    }
    activeProc = null;
    return true;
  }
  return false;
}

export interface ClaudeResponse {
  text: string;
  toolUse: string[];
  error: string | null;
  costUsd: number | null;
}

export interface StreamEvent {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  content: string;
}

export async function sendMessage(
  prompt: string,
  state: UserState,
  onStream?: (event: StreamEvent) => void,
  recalledContext?: string | null,
  includeRestartContext?: boolean
): Promise<ClaudeResponse> {
  // Build system prompt from config template with placeholder replacement
  const basePrompt = config.systemPrompt
    .replace(/\{botName\}/g, config.botName)
    .replace(/\{ownerName\}/g, config.ownerName)
    .replace(/\{cwd\}/g, state.cwd);

  const systemPromptParts = [basePrompt];

  if (includeRestartContext) {
    systemPromptParts.push(
      "\n\n🔄 SYSTEM NOTICE: The Discord bot just restarted. This is a fresh session."
    );
  }

  if (recalledContext) {
    systemPromptParts.push(
      "\n\n📜 RECALLED CONTEXT: The user used /recall to search their Discord message history.",
      "Here are the relevant messages they wanted you to see:\n\n" + recalledContext
    );
  }

  if (state.recentCommands && state.recentCommands.length > 0) {
    systemPromptParts.push(
      "\n\n⚡ RECENT SLASH COMMANDS: The user ran these commands since the last message:",
      state.recentCommands.map(cmd => `  ${cmd}`).join("\n")
    );
  }

  if (state.pendingScreenshot) {
    systemPromptParts.push(
      `\n\n📸 SCREENSHOT: The user ran /screenshot. The image is saved at: ${state.pendingScreenshot}`,
      "Use the Read tool to view and analyze it. The file will be cleaned up after you read it."
    );
  }

  const systemPrompt = systemPromptParts.join(" ");

  // Write system prompt to a temp file to avoid command-line length limits (Windows 8191 char limit)
  const tempDir = path.join(process.cwd(), ".temp-prompts");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const systemPromptFile = path.join(tempDir, `system-prompt-${Date.now()}.txt`);
  fs.writeFileSync(systemPromptFile, systemPrompt);

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", state.model,
    "--permission-mode", state.permissionMode,
    "--append-system-prompt-file", systemPromptFile,
  ];

  if (state.hasActiveSession) {
    args.push("--continue");
  } else {
    lastTodoCount = 0; // Reset on new session
  }

  console.log(`[claude] model=${state.model}, cwd=${state.cwd}, continue=${state.hasActiveSession}`);
  console.log(`[claude] System prompt: ${systemPrompt.length} chars (written to file)`);
  console.log(`[claude] Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`);

  // Clean env to avoid nested Claude Code detection
  const cleanEnv = { ...process.env };
  for (const key of [
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES", "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
    "CLAUDE_CODE_MODULE_PATH", "CLAUDE_CODE_SESSION_ID",
  ]) {
    delete cleanEnv[key];
  }

  return new Promise((resolve) => {
    let resolved = false;
    const textParts: string[] = [];
    const toolUseParts: string[] = [];
    let costUsd: number | null = null;
    let error: string | null = null;

    const finish = (override?: Partial<ClaudeResponse>) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve({
        text: textParts.join(""),
        toolUse: toolUseParts,
        error,
        costUsd,
        ...override,
      });
    };

    const timeout = setTimeout(() => {
      console.log("[claude] TIMEOUT - killing process");
      proc?.kill();
      finish({ error: "Claude timed out after 10 minutes." });
    }, TIMEOUT_MS);

    const proc = spawn("claude", args, {
      cwd: state.cwd,
      shell: true,
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeProc = proc;

    console.log(`[claude] PID: ${proc.pid}`);

    // Pipe prompt via stdin to avoid shell escaping issues
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    let stderr = "";

    // Parse NDJSON lines from stdout
    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          handleMessage(msg, textParts, toolUseParts, state, onStream, (c) => { costUsd = c; }, (e) => { error = e; });
        } catch {
          // Skip non-JSON lines
        }
      });
    }

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      console.log(`[claude] stderr: ${text.trim()}`);
    });

    proc.on("error", (err) => {
      console.error("[claude] Process error:", err.message);
      finish({ error: `Process error: ${err.message}` });
    });

    proc.on("close", (code) => {
      activeProc = null;
      console.log(`[claude] Exited code=${code}, text parts=${textParts.length}, tool parts=${toolUseParts.length}`);
      if (code !== 0 && textParts.length === 0) {
        error = error || stderr.trim() || `Claude exited with code ${code}`;
      }
      // Clean up temp system prompt file
      try { fs.unlinkSync(systemPromptFile); } catch {}
      finish();
    });
  });
}

function handleMessage(
  msg: any,
  textParts: string[],
  toolUseParts: string[],
  state: UserState,
  onStream: ((event: StreamEvent) => void) | undefined,
  setCost: (cost: number) => void,
  setError: (error: string) => void,
): void {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        console.log(`[claude] Session: ${msg.session_id}`);
      }
      break;

    case "assistant":
      // Full assistant message with content blocks
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
            onStream?.({ type: "text", content: block.text });
          } else if (block.type === "tool_use") {
            // Persist TodoWrite data to state so /todo can display it
            if (block.name === "TodoWrite" && block.input?.todos) {
              updateState({ todos: block.input.todos });
            }
            if (state.showToolUse) {
              const formatted = formatToolUse(block.name, block.input);
              toolUseParts.push(formatted);
              onStream?.({ type: "tool_use", content: formatted });
            } else {
              // Even if not showing, notify stream so user sees activity
              onStream?.({ type: "tool_use", content: `Using ${block.name}...` });
            }
          }
        }
      }
      break;

    case "result":
      if (msg.total_cost_usd != null) {
        setCost(msg.total_cost_usd);
      } else if (msg.cost_usd != null) {
        setCost(msg.cost_usd);
      }
      if (msg.is_error || msg.subtype?.startsWith("error")) {
        const errMsg = msg.error || msg.errors?.join(", ") || "Unknown error";
        setError(errMsg);
      }
      // The result message also has a `result` field with the final text
      // Only use it if we didn't already capture text from assistant messages
      if (textParts.length === 0 && msg.result) {
        textParts.push(msg.result);
      }
      console.log(`[claude] Result: ${msg.subtype}, cost=$${msg.total_cost_usd ?? "?"}`);
      break;

    default:
      // Log unknown types for debugging
      if (msg.type) {
        console.log(`[claude] Event: ${msg.type}${msg.subtype ? "/" + msg.subtype : ""}`);
      }
      break;
  }
}

function cleanFilePath(filePath: string): string {
  // Strip temp-attachments path to just show filename for user-sent files
  if (filePath.includes(".temp-attachments")) {
    // Remove the timestamp prefix (e.g. "1771954123326-") and return just the filename
    const basename = filePath.split(/[/\\]/).pop() || filePath;
    return basename.replace(/^\d+-/, "");
  }
  return filePath;
}

function formatToolUse(toolName: string, input: any): string {
  const icon = getToolIcon(toolName);

  switch (toolName) {
    case "Read":
      return `-# ${icon} Read ${cleanFilePath(input?.file_path || "unknown")}`;
    case "Write":
      return `-# ${icon} Created ${cleanFilePath(input?.file_path || "unknown")}`;
    case "Edit":
      return `-# ${icon} Edited ${cleanFilePath(input?.file_path || "unknown")}`;
    case "Bash": {
      const cmd = input?.command || "";
      const short = cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
      return `-# ${icon} ${short}`;
    }
    case "Glob":
      return `-# ${icon} Search files: ${input?.pattern || ""}`;
    case "Grep":
      return `-# ${icon} Search code: ${input?.pattern || ""}`;
    case "WebSearch":
      return `-# ${icon} Web search: ${input?.query || ""}`;
    case "WebFetch":
      return `-# ${icon} Fetch: ${input?.url || ""}`;
    case "Task":
      return `-# ${icon} Agent: ${input?.description || ""}`;
    case "TodoWrite": {
      const todos = input?.todos || [];
      const inProgress = todos.find((t: any) => t.status === "in_progress");
      const completed = todos.filter((t: any) => t.status === "completed").length;
      const total = todos.length;
      const isNew = !lastTodoCount;
      lastTodoCount = total;

      if (isNew) {
        const taskList = todos.map((t: any) => t.content).join(", ");
        return `-# ${icon} Created todo list (${total} items): ${taskList}`;
      }
      if (inProgress) {
        return `-# ${icon} ${inProgress.activeForm} (${completed}/${total} done)`;
      }
      return `-# ${icon} Updated todos: ${completed}/${total} done`;
    }
    default:
      return `-# ${icon} ${toolName}`;
  }
}

function getToolIcon(toolName: string): string {
  const icons: Record<string, string> = {
    Read: "📖", Write: "📝", Edit: "✏️", Bash: "⚡",
    Glob: "🔍", Grep: "🔎", WebSearch: "🌐", WebFetch: "🌐",
    Task: "🤖", TodoWrite: "📋", AskUserQuestion: "❓",
  };
  return icons[toolName] || "🔧";
}
