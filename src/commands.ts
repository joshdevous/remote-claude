import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  REST,
  Routes,
  Message,
  DMChannel,
  Collection,
  AutocompleteInteraction,
} from "discord.js";
import { config } from "./config";
import { getState, updateState } from "./state";
import { cancelCurrentRequest } from "./claude";
import { setRecalledContext, clearRecalledContext, forceStop } from "./messageHandler";
import { updateBotPresence } from "./index";
import {
  takeScreenshot,
  getScreens,
  getWindows,
  formatScreenInfo,
  formatWindowInfo,
  ScreenshotOptions,
} from "./screenshot";
import { recordScreen, parseRecordTarget } from "./recording";

const commands = [
  new SlashCommandBuilder()
    .setName("cwd")
    .setDescription("View or change the working directory")
    .addStringOption((opt) =>
      opt.setName("path").setDescription("New working directory path")
    ),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear conversation history and start fresh"),

  new SlashCommandBuilder()
    .setName("model")
    .setDescription("View or change the Claude model")
    .addStringOption((opt) =>
      opt
        .setName("name")
        .setDescription("Model name")
        .addChoices(
          { name: "Sonnet", value: "sonnet" },
          { name: "Opus", value: "opus" },
          { name: "Haiku", value: "haiku" }
        )
    ),

  new SlashCommandBuilder()
    .setName("tools")
    .setDescription("Toggle tool usage display in responses")
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("Show or hide tool usage")
        .setRequired(true)
        .addChoices(
          { name: "Show tool usage", value: "show" },
          { name: "Hide tool usage", value: "hide" }
        )
    ),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show current bot configuration"),

  new SlashCommandBuilder()
    .setName("perms")
    .setDescription("Change permission mode")
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("Permission mode")
        .setRequired(true)
        .addChoices(
          { name: "Default (ask)", value: "default" },
          { name: "Accept edits", value: "acceptEdits" },
          { name: "Bypass all", value: "bypassPermissions" }
        )
    ),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the current request"),

  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart (picks up code changes)"),

  new SlashCommandBuilder()
    .setName("remember")
    .setDescription("Save a memory for Claude to remember across all sessions")
    .addStringOption((opt) =>
      opt
        .setName("memory")
        .setDescription("What to remember")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("recall")
    .setDescription("Search Discord message history and inject it into context")
    .addStringOption((opt) =>
      opt
        .setName("query")
        .setDescription("Search term to find in message history (optional - returns all if omitted)")
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("limit")
        .setDescription("Number of messages to search (default: 200)")
        .setMinValue(10)
        .setMaxValue(500)
    ),

  new SlashCommandBuilder()
    .setName("viewmemory")
    .setDescription("View all saved global memories"),

  new SlashCommandBuilder()
    .setName("forget")
    .setDescription("Remove a memory by its number")
    .addIntegerOption((opt) =>
      opt
        .setName("number")
        .setDescription("Memory number to forget (use /viewmemory to see numbers)")
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName("todo")
    .setDescription("View Claude's current todo list"),

  new SlashCommandBuilder()
    .setName("screenshot")
    .setDescription("Take a screenshot and send it")
    .addStringOption((opt) =>
      opt
        .setName("target")
        .setDescription("What to capture: primary (default), all, monitor number, or app name")
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("record")
    .setDescription("Record a short screen capture GIF/MP4")
    .addIntegerOption((opt) =>
      opt
        .setName("duration")
        .setDescription("Recording duration in seconds (default: 5, max: 15)")
        .setMinValue(1)
        .setMaxValue(15)
    )
    .addStringOption((opt) =>
      opt
        .setName("target")
        .setDescription("What to capture: primary (default), all, monitor number, or app name")
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("format")
        .setDescription("Output format")
        .addChoices(
          { name: "GIF", value: "gif" },
          { name: "MP4", value: "mp4" }
        )
    ),

  new SlashCommandBuilder()
    .setName("open")
    .setDescription("Open a URL, app, or file")
    .addStringOption((opt) =>
      opt
        .setName("target")
        .setDescription("URL, app name, or file path to open")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("focus")
    .setDescription("Bring a window to the foreground")
    .addStringOption((opt) =>
      opt
        .setName("app")
        .setDescription("App/window name to focus")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("key")
    .setDescription("Send keystrokes to the active window")
    .addStringOption((opt) =>
      opt
        .setName("keys")
        .setDescription("Keys to send (e.g. \"ctrl+s\", \"alt+tab\", \"ctrl+shift+esc\")")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("type")
    .setDescription("Type text into the active window")
    .addStringOption((opt) =>
      opt
        .setName("text")
        .setDescription("Text to type (press Enter at end with enter=true)")
        .setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("enter")
        .setDescription("Press Enter after typing (default: true)")
    ),

  new SlashCommandBuilder()
    .setName("screens")
    .setDescription("List available monitors and open windows"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all available commands"),
];

function trackCommand(commandName: string, args?: Record<string, any>, screenshotPath?: string): void {
  const state = getState();
  const argStr = args && Object.keys(args).length > 0
    ? " " + Object.entries(args).map(([k, v]) => `${k}="${v}"`).join(" ")
    : "";
  const commandStr = `/${commandName}${argStr}`;

  // Keep last 10 commands
  const recentCommands = [...state.recentCommands, commandStr].slice(-10);
  updateState({ recentCommands, pendingScreenshot: screenshotPath || null });
}

export async function registerCommands(): Promise<void> {
  const rest = new REST().setToken(config.discordToken);
  await rest.put(Routes.applicationCommands(config.discordAppId), {
    body: commands.map((c) => c.toJSON()),
  });
  console.log("Slash commands registered.");
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  // Owner only
  if (interaction.user.id !== config.ownerId) {
    await interaction.reply({ content: "This bot is private.", ephemeral: true });
    return;
  }

  const state = getState();

  switch (interaction.commandName) {
    case "cwd": {
      const newPath = interaction.options.getString("path");
      if (!newPath) {
        trackCommand("cwd");
        await interaction.reply(`Current working directory: \`${state.cwd}\``);
        return;
      }

      // Normalize path separators
      const normalized = newPath.replace(/\\/g, "/");

      if (!fs.existsSync(normalized)) {
        await interaction.reply(`Path does not exist: \`${normalized}\``);
        return;
      }

      const stat = fs.statSync(normalized);
      if (!stat.isDirectory()) {
        await interaction.reply(`Not a directory: \`${normalized}\``);
        return;
      }

      trackCommand("cwd", { path: normalized });
      updateState({ cwd: normalized, hasActiveSession: false, sessionCostUsd: 0 });
      updateBotPresence(normalized);
      await interaction.reply(
        `Working directory changed to \`${normalized}\`\nConversation cleared (new directory).`
      );
      break;
    }

    case "clear": {
      trackCommand("clear");
      updateState({ hasActiveSession: false, sessionCostUsd: 0, todos: [] });
      clearRecalledContext();
      await interaction.reply("Conversation cleared. Next message starts fresh.");
      break;
    }

    case "model": {
      const name = interaction.options.getString("name");
      if (!name) {
        trackCommand("model");
        await interaction.reply(`Current model: \`${state.model}\``);
        return;
      }
      trackCommand("model", { name });
      updateState({ model: name });
      await interaction.reply(`Model changed to \`${name}\`.`);
      break;
    }

    case "tools": {
      const action = interaction.options.getString("action", true);
      const show = action === "show";
      trackCommand("tools", { action });
      updateState({ showToolUse: show });
      await interaction.reply(
        show
          ? "Tool usage will now be shown in responses."
          : "Tool usage is now hidden."
      );
      break;
    }

    case "status": {
      trackCommand("status");
      const lines = [
        `**Working directory:** \`${state.cwd}\``,
        `**Model:** \`${state.model}\``,
        `**Session:** ${state.hasActiveSession ? "active" : "none"}`,
        `**Session cost:** $${state.sessionCostUsd.toFixed(4)}`,
        `**Permission mode:** \`${state.permissionMode}\``,
        `**Show tool use:** ${state.showToolUse ? "yes" : "no"}`,
      ];
      await interaction.reply(lines.join("\n"));
      break;
    }

    case "perms": {
      const mode = interaction.options.getString("mode", true);
      trackCommand("perms", { mode });
      updateState({ permissionMode: mode });
      await interaction.reply(`Permission mode changed to \`${mode}\`.`);
      break;
    }

    case "stop": {
      trackCommand("stop");
      forceStop();
      await interaction.reply("Stopped.");
      break;
    }

    case "restart": {
      cancelCurrentRequest();
      await interaction.deferReply();

      // Type check BEFORE exiting - if we fail, we stay alive
      try {
        const { execSync } = require("child_process");
        await interaction.editReply("🔄 Checking code before restart...");
        execSync("npx tsc --noEmit", { stdio: "pipe", cwd: process.cwd() });
        // Type check passed - safe to restart
        trackCommand("restart");
        await interaction.editReply("✅ Type check passed. Restarting...");
        setTimeout(() => process.exit(0), 500);
      } catch (err: any) {
        const error = err.stderr?.toString() || err.stdout?.toString() || err.message;
        // Extract just the error lines (skip the generic tsc noise)
        const lines = error.split("\n").filter((l: string) =>
          l.toLowerCase().includes("error") && (l.includes(".ts(") || l.includes(".ts:"))
        ).slice(0, 5); // First 5 errors max

        const errorMsg = lines.length > 0
          ? "```\n" + lines.join("\n") + "\n```"
          : "```Type check failed```";

        // Track the failed restart in recentCommands so the current (still running) session knows about it
        trackCommand("restart");
        const state = getState();
        const recentCommands = [
          ...state.recentCommands,
          `restart (FAILED: ${lines.length} type error${lines.length > 1 ? 's' : ''})\n${lines.join("\n")}`
        ];
        updateState({ recentCommands: recentCommands.slice(-10) });

        await interaction.editReply(
          `❌ Type check failed - not restarting!\n\n${errorMsg}\n\nI can see these errors. Want me to fix them?`
        );
      }
      break;
    }

    case "remember": {
      const memory = interaction.options.getString("memory", true);
      await interaction.deferReply();

      try {
        // Run the claude CLI /remember command
        const result = await runClaudeRemember(memory, state.cwd);
        if (result.success) {
          trackCommand("remember", { memory });
          await interaction.editReply(`✅ Memory saved: "${memory}"`);
        } else {
          await interaction.editReply(`❌ Failed to save memory: ${result.error}`);
        }
      } catch (err: any) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
      break;
    }

    case "recall": {
      // Defer immediately to avoid timeout
      await interaction.deferReply();

      try {
        const query = interaction.options.getString("query");
        const limit = interaction.options.getInteger("limit") || 200;
        const channel = interaction.channel as DMChannel;

        console.log(`[recall] Fetching ${limit} messages, query: ${query || "none"}`);
        const context = await fetchMessageHistory(channel, query, limit);
        console.log(`[recall] Got ${context.split('\n\n').length} results`);

        if (context.length === 0) {
          const searchMsg = query ? `matching "${query}"` : "in history";
          await interaction.editReply(`🔍 No messages found ${searchMsg}`);
          return;
        }

        // Store the context for the next message
        setRecalledContext(context);

        const trackArgs: Record<string, any> = {};
        if (query) trackArgs.query = query;
        if (limit !== 200) trackArgs.limit = limit;
        trackCommand("recall", trackArgs);

        const searchMsg = query ? `matching "${query}"` : "from recent history";
        await interaction.editReply(
          `✅ Found ${context.split('\n\n').length} relevant message(s) ${searchMsg}\n` +
          `Context will be injected into your next message (then kept via --continue).`
        );
      } catch (err: any) {
        console.error("[recall] Error:", err);
        await interaction.editReply(`❌ Error: ${err.message}`).catch(() => {});
      }
      break;
    }

    case "viewmemory": {
      trackCommand("viewmemory");
      await interaction.deferReply();

      try {
        const memories = await getClaudeMemories();
        if (memories.length === 0) {
          await interaction.editReply("📝 No memories saved yet. Use `/remember` to add one.");
        } else {
          const memoryList = memories
            .map((m, i) => `${i + 1}. [${m.date}] ${m.content}`)
            .join("\n");
          await interaction.editReply(`📝 **Global Memories:**\n\n${memoryList}`);
        }
      } catch (err: any) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
      break;
    }

    case "forget": {
      const number = interaction.options.getInteger("number", true);
      await interaction.deferReply();

      try {
        const result = await forgetClaudeMemory(number);
        if (result.success) {
          trackCommand("forget", { number });
          await interaction.editReply(`✅ Forgot memory #${number}`);
        } else {
          await interaction.editReply(`❌ ${result.error}`);
        }
      } catch (err: any) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
      break;
    }

    case "todo": {
      trackCommand("todo");
      const todos = state.todos || [];

      if (todos.length === 0) {
        await interaction.reply("📋 No active todo list. Claude will create one when working on multi-step tasks.");
        break;
      }

      const statusIcons: Record<string, string> = {
        completed: "✅",
        in_progress: "🔄",
        pending: "⬜",
      };

      const completed = todos.filter((t: any) => t.status === "completed").length;
      const inProgress = todos.find((t: any) => t.status === "in_progress");
      const total = todos.length;

      const lines = [
        `**📋 Todo List** (${completed}/${total} done)`,
        "",
        ...todos.map((t: any, i: number) => {
          const icon = statusIcons[t.status] || "⬜";
          return `${icon} ${t.content}`;
        }),
      ];

      if (inProgress) {
        lines.push("", `-# Currently: ${inProgress.activeForm}`);
      }

      await interaction.reply(lines.join("\n"));
      break;
    }

    case "screenshot": {
      const target = interaction.options.getString("target");

      await interaction.deferReply();

      try {
        // Determine screenshot options
        let options: ScreenshotOptions = { monitor: "primary" };

        if (target) {
          const lower = target.toLowerCase();

          // Check for "all"
          if (lower === "all") {
            options = { monitor: "all" };
          }
          // Check for monitor number (handle 1-indexed from autocomplete)
          else if (/^monitor (\d+)|^(\d+)$/.test(target)) {
            const match = target.match(/(\d+)/);
            if (match) {
              options = { monitor: parseInt(match[1]) };
            }
          }
          // Check for app name
          else {
            const windows = await getWindows();
            const match = windows.find((w) =>
              w.processName.toLowerCase().includes(lower) ||
              w.title.toLowerCase().includes(lower)
            );
            if (match) {
              options = { windowId: match.id };
            } else {
              await interaction.editReply(`❌ No window found matching "${target}". Use \`/screens\` to see options.`);
              break;
            }
          }
        }

        // Take the screenshot
        const filePath = await takeScreenshot(options);

        // Send the image
        const targetDesc = options.windowId
          ? "window"
          : options.monitor === "all"
          ? "all monitors"
          : options.monitor === "primary"
          ? "primary monitor"
          : `monitor ${options.monitor}`;

        await interaction.editReply({
          content: `📸 Screenshot of ${targetDesc}:`,
          files: [filePath],
        });

        // Copy to temp-attachments so Claude can see it
        const tempDir = path.join(process.cwd(), ".temp-attachments");
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        const tempPath = path.join(tempDir, `screenshot-${Date.now()}.png`);
        fs.copyFileSync(filePath, tempPath);

        // Track command with screenshot path (gets injected into next message's context)
        trackCommand("screenshot", { target: targetDesc }, tempPath);

        // Clean up the original temp file
        fs.unlinkSync(filePath);
      } catch (err: any) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
      break;
    }

    case "record": {
      const duration = interaction.options.getInteger("duration") || 5;
      const target = interaction.options.getString("target");
      const format = (interaction.options.getString("format") || "gif") as "gif" | "mp4";

      await interaction.deferReply();

      try {
        const targetOpts = await parseRecordTarget(target);
        const targetDesc = targetOpts.windowTitle
          ? `"${targetOpts.windowTitle.slice(0, 30)}"`
          : targetOpts.monitor === "all"
          ? "all monitors"
          : targetOpts.monitor === "primary"
          ? "primary monitor"
          : `monitor ${targetOpts.monitor}`;

        await interaction.editReply(`🔴 Recording ${targetDesc} for ${duration}s...`);

        const filePath = await recordScreen({
          duration,
          format,
          ...targetOpts,
        });

        // Check file size (Discord limit ~25MB)
        const stats = fs.statSync(filePath);
        const sizeMB = stats.size / (1024 * 1024);

        if (sizeMB > 25) {
          fs.unlinkSync(filePath);
          await interaction.editReply(
            `❌ Recording too large (${sizeMB.toFixed(1)}MB). Try shorter duration or smaller target.`
          );
          break;
        }

        trackCommand("record", { duration, target: targetDesc, format });
        await interaction.editReply({
          content: `🎬 ${format.toUpperCase()} recording of ${targetDesc} (${duration}s, ${sizeMB.toFixed(1)}MB):`,
          files: [filePath],
        });

        // Clean up
        setTimeout(() => {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }, 5000);
      } catch (err: any) {
        const msg = err.message.includes("ffmpeg not found")
          ? "❌ ffmpeg not found. Install it and make sure it's in PATH."
          : `❌ Recording failed: ${err.message.slice(0, 200)}`;
        await interaction.editReply(msg);
      }
      break;
    }

    case "open": {
      const target = interaction.options.getString("target", true);
      await interaction.deferReply();

      try {
        // Use PowerShell Start-Process which handles URLs, apps, and files
        const result = await new Promise<string>((resolve, reject) => {
          // For URLs, use Start-Process directly
          // For app names, try Start-Process first (works for things in PATH and Start Menu)
          const isUrl = /^https?:\/\//i.test(target);
          const psCommand = isUrl
            ? `Start-Process "${target}"`
            : `Start-Process "${target}"`;

          const proc = spawn("powershell", [
            "-ExecutionPolicy", "Bypass",
            "-Command", psCommand,
          ]);

          let stderr = "";
          proc.stderr.on("data", (d) => (stderr += d.toString()));
          proc.on("close", (code) => {
            if (code === 0) resolve("ok");
            else reject(new Error(stderr || `Exit code ${code}`));
          });
          proc.on("error", reject);
        });

        trackCommand("open", { target });
        const icon = /^https?:\/\//i.test(target) ? "🌐" : "🚀";
        await interaction.editReply(`${icon} Opened: ${target}`);
      } catch (err: any) {
        await interaction.editReply(`❌ Failed to open "${target}": ${err.message.slice(0, 200)}`);
      }
      break;
    }

    case "focus": {
      const app = interaction.options.getString("app", true);
      await interaction.deferReply();

      try {
        const windows = await getWindows();
        const lower = app.toLowerCase();
        const match = windows.find(
          (w) =>
            w.processName.toLowerCase().includes(lower) ||
            w.title.toLowerCase().includes(lower)
        );

        if (!match) {
          await interaction.editReply(`❌ No window found matching "${app}". Use \`/screens\` to see open windows.`);
          break;
        }

        // Use PowerShell to bring window to foreground
        await new Promise<void>((resolve, reject) => {
          const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FocusHelper {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
}
"@
$proc = Get-Process -Id ${match.id} -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
if ([FocusHelper]::IsIconic($hwnd)) {
    [FocusHelper]::ShowWindow($hwnd, 9)
}
[FocusHelper]::SetForegroundWindow($hwnd)
`;
          const proc = spawn("powershell", [
            "-ExecutionPolicy", "Bypass",
            "-Command", psScript,
          ]);

          let stderr = "";
          proc.stderr.on("data", (d) => (stderr += d.toString()));
          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr || `Exit code ${code}`));
          });
          proc.on("error", reject);
        });

        trackCommand("focus", { app: match.processName });
        const title = match.title.length > 40 ? match.title.slice(0, 40) + "..." : match.title;
        await interaction.editReply(`🎯 Focused: **${match.processName}** (${title})`);
      } catch (err: any) {
        await interaction.editReply(`❌ Failed to focus: ${err.message.slice(0, 200)}`);
      }
      break;
    }

    case "key": {
      const keys = interaction.options.getString("keys", true);
      await interaction.deferReply();

      try {
        // Parse key combo like "ctrl+shift+s" into SendKeys format
        const sendKeysStr = parseKeysToSendKeys(keys);

        await new Promise<void>((resolve, reject) => {
          // Use C# SendKeys via PowerShell for reliability
          const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait("${sendKeysStr}")
`;
          const proc = spawn("powershell", [
            "-ExecutionPolicy", "Bypass",
            "-Command", psScript,
          ]);

          let stderr = "";
          proc.stderr.on("data", (d) => (stderr += d.toString()));
          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr || `Exit code ${code}`));
          });
          proc.on("error", reject);
        });

        trackCommand("key", { keys });
        await interaction.editReply(`⌨️ Sent: \`${keys}\``);
      } catch (err: any) {
        await interaction.editReply(`❌ Failed to send keys: ${err.message.slice(0, 200)}`);
      }
      break;
    }

    case "type": {
      const text = interaction.options.getString("text", true);
      const pressEnter = interaction.options.getBoolean("enter") ?? true;
      await interaction.deferReply();

      try {
        // Normalize smart quotes and other unicode punctuation to ASCII
        const normalized = text
          .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')  // smart double quotes
          .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")  // smart single quotes
          .replace(/[\u2013\u2014]/g, "-")  // en/em dash
          .replace(/\u2026/g, "...");  // ellipsis

        // Escape special SendKeys characters: +^%~(){}[]
        const escaped = normalized.replace(/([+^%~(){}[\]])/g, "{$1}");
        const sendKeysStr = pressEnter ? `${escaped}{ENTER}` : escaped;

        // Write to temp file to avoid all shell escaping issues
        const tempFile = path.join(os.tmpdir(), `sendkeys-${Date.now()}.txt`);
        fs.writeFileSync(tempFile, sendKeysStr, "ascii");

        await new Promise<void>((resolve, reject) => {
          const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 100
$keys = Get-Content -Path '${tempFile.replace(/\\/g, "\\\\")}' -Raw -Encoding ASCII
[System.Windows.Forms.SendKeys]::SendWait($keys)
Remove-Item -Path '${tempFile.replace(/\\/g, "\\\\")}' -ErrorAction SilentlyContinue
`;
          const proc = spawn("powershell", [
            "-ExecutionPolicy", "Bypass",
            "-Command", psScript,
          ]);

          let stderr = "";
          proc.stderr.on("data", (d) => (stderr += d.toString()));
          proc.on("close", (code) => {
            // Clean up just in case PS didn't
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            if (code === 0) resolve();
            else reject(new Error(stderr || `Exit code ${code}`));
          });
          proc.on("error", reject);
        });

        trackCommand("type", { text: text.slice(0, 50) });
        const preview = text.length > 50 ? text.slice(0, 50) + "..." : text;
        const enterNote = pressEnter ? " + Enter" : "";
        await interaction.editReply(`⌨️ Typed: \`${preview}\`${enterNote}`);
      } catch (err: any) {
        await interaction.editReply(`❌ Failed to type: ${err.message.slice(0, 200)}`);
      }
      break;
    }

    case "screens": {
      trackCommand("screens");
      await interaction.deferReply();

      try {
        const [screens, windows] = await Promise.all([getScreens(), getWindows()]);
        const lines = [
          "**🖥️ Available Monitors:**",
          "```",
          formatScreenInfo(screens),
          "```",
          "",
          "**📱 Open Windows:**",
          "```",
          formatWindowInfo(windows),
          "```",
          "",
          `-# Use \`/screenshot\` with autocomplete to capture`,
        ];
        await interaction.editReply(lines.join("\n"));
      } catch (err: any) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
      break;
    }

    case "help": {
      const helpText = [
        `**📋 ${config.botName} Commands**`,
        "",
        "**💬 Conversation**",
        "`/clear` — Start fresh conversation",
        "`/recall [query] [limit]` — Search Discord history & inject into context",
        "",
        "**⚙️ Configuration**",
        "`/cwd [path]` — View or change working directory",
        "`/model [sonnet|opus|haiku]` — View or change model",
        "`/perms [mode]` — Change permission mode",
        "`/tools [show|hide]` — Toggle tool usage display",
        "`/status` — Show current config",
        "",
        "**🧠 Memory**",
        "`/remember [text]` — Save a persistent memory",
        "`/viewmemory` — View all saved memories",
        "`/forget [number]` — Remove a memory",
        "",
        "**🔧 System**",
        "`/screenshot [target]` — Take and send a screenshot",
        "`/record [duration] [target] [format]` — Record screen as GIF/MP4",
        "`/open [target]` — Open a URL, app, or file",
        "`/focus [app]` — Bring a window to the foreground",
        "`/key [keys]` — Send keystrokes (e.g. `ctrl+s`, `alt+tab`)",
        "`/type [text]` — Type text into the active window",
        "`/screens` — List available monitors and windows",
        "`/todo` — View Claude's current task list",
        "`/stop` — Stop the current request",
        "`/restart` — Restart bot (picks up code changes)",
        "`/help` — This message",
        "",
        `-# Send any DM to chat • Attach files for analysis • ${config.botName} has full Claude Code access`,
      ];
      await interaction.reply(helpText.join("\n"));
      break;
    }

    default:
      await interaction.reply({ content: "Unknown command.", ephemeral: true });
  }
}

async function runClaudeRemember(
  memory: string,
  cwd: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get the global CLAUDE.md path
    const claudeDir = path.join(os.homedir(), ".claude");
    const claudeMdPath = path.join(claudeDir, "CLAUDE.md");

    // Ensure .claude directory exists
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Read existing content or create new file
    let existingContent = "";
    if (fs.existsSync(claudeMdPath)) {
      existingContent = fs.readFileSync(claudeMdPath, "utf-8");
    } else {
      // Create initial structure
      existingContent = "# Global Memory for Claude Code\n\n## Discord Bot Memories\n\n";
    }

    // Format the new memory entry with timestamp
    const timestamp = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const memoryEntry = `- [${timestamp}] ${memory}\n`;

    // Check if there's a "Discord Bot Memories" section
    if (existingContent.includes("## Discord Bot Memories")) {
      // Append under the Discord Bot Memories section
      existingContent = existingContent.replace(
        /## Discord Bot Memories\n/,
        `## Discord Bot Memories\n\n${memoryEntry}`
      );
    } else {
      // Add a new section at the end
      existingContent += `\n## Discord Bot Memories\n\n${memoryEntry}`;
    }

    // Write back to file
    fs.writeFileSync(claudeMdPath, existingContent, "utf-8");

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function fetchMessageHistory(
  channel: DMChannel,
  query: string | null,
  limit: number
): Promise<string> {
  // Discord API limits fetches to 100 messages at a time, so we need to paginate
  const allMessages: Message[] = [];
  let lastId: string | undefined = undefined;
  const batchSize = 100;

  while (allMessages.length < limit) {
    const toFetch = Math.min(batchSize, limit - allMessages.length);
    const options: { limit: number; before?: string } = {
      limit: toFetch,
      ...(lastId && { before: lastId })
    };

    const batch = await channel.messages.fetch(options) as Collection<string, Message>;

    // batch is a Collection<string, Message>
    if (batch.size === 0) break; // No more messages

    allMessages.push(...batch.values());
    lastId = batch.last()?.id;

    // If we got fewer than requested, we've hit the end
    if (batch.size < toFetch) break;
  }

  // Filter messages that contain the query (case insensitive) if query provided
  let relevant: Message[] = allMessages;

  if (query) {
    const queryLower = query.toLowerCase();
    relevant = [];
    for (const msg of allMessages) {
      if (msg.content.toLowerCase().includes(queryLower)) {
        relevant.push(msg);
      }
    }
  }

  // Sort by timestamp (oldest first)
  relevant.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  // Format as conversation pairs
  const formatted: string[] = [];

  for (const msg of relevant) {
    const author = msg.author.bot ? config.botName : config.ownerName;
    const timestamp = msg.createdAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    formatted.push(`[${timestamp}] ${author}: ${msg.content}`);
  }

  return formatted.join('\n\n');
}

async function getClaudeMemories(): Promise<Array<{ date: string; content: string }>> {
  const claudeMdPath = path.join(os.homedir(), ".claude", "CLAUDE.md");

  if (!fs.existsSync(claudeMdPath)) {
    return [];
  }

  const content = fs.readFileSync(claudeMdPath, "utf-8");
  const memories: Array<{ date: string; content: string }> = [];

  // Parse memories in the "Discord Bot Memories" section
  const lines = content.split("\n");
  let inDiscordSection = false;

  for (const line of lines) {
    if (line.trim() === "## Discord Bot Memories") {
      inDiscordSection = true;
      continue;
    }

    // Stop if we hit another section
    if (inDiscordSection && line.startsWith("##")) {
      break;
    }

    // Parse memory entries like: - [2026-02-24] Some memory text
    if (inDiscordSection && line.trim().startsWith("- [")) {
      const match = line.match(/^- \[([^\]]+)\] (.+)$/);
      if (match) {
        memories.push({
          date: match[1],
          content: match[2],
        });
      }
    }
  }

  return memories;
}

async function forgetClaudeMemory(
  number: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const claudeMdPath = path.join(os.homedir(), ".claude", "CLAUDE.md");

    if (!fs.existsSync(claudeMdPath)) {
      return { success: false, error: "No memories found" };
    }

    const content = fs.readFileSync(claudeMdPath, "utf-8");
    const lines = content.split("\n");
    let inDiscordSection = false;
    let memoryIndex = 0;
    let lineToRemove = -1;

    // Find the memory to remove
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim() === "## Discord Bot Memories") {
        inDiscordSection = true;
        continue;
      }

      if (inDiscordSection && line.startsWith("##")) {
        break;
      }

      if (inDiscordSection && line.trim().startsWith("- [")) {
        memoryIndex++;
        if (memoryIndex === number) {
          lineToRemove = i;
          break;
        }
      }
    }

    if (lineToRemove === -1) {
      return { success: false, error: `Memory #${number} not found` };
    }

    // Remove the line
    lines.splice(lineToRemove, 1);

    // Write back
    fs.writeFileSync(claudeMdPath, lines.join("\n"), "utf-8");

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Convert human-readable key combos like "ctrl+shift+s" to SendKeys format
// See: https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.sendkeys
function parseKeysToSendKeys(input: string): string {
  const modifierMap: Record<string, string> = {
    ctrl: "^",
    control: "^",
    alt: "%",
    shift: "+",
    win: "^({ESC})", // No direct SendKeys for Win, but Ctrl+Esc opens Start
  };

  const keyMap: Record<string, string> = {
    enter: "{ENTER}",
    return: "{ENTER}",
    tab: "{TAB}",
    escape: "{ESC}",
    esc: "{ESC}",
    space: " ",
    backspace: "{BS}",
    delete: "{DEL}",
    del: "{DEL}",
    insert: "{INS}",
    ins: "{INS}",
    home: "{HOME}",
    end: "{END}",
    pageup: "{PGUP}",
    pgup: "{PGUP}",
    pagedown: "{PGDN}",
    pgdn: "{PGDN}",
    up: "{UP}",
    down: "{DOWN}",
    left: "{LEFT}",
    right: "{RIGHT}",
    f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}",
    f5: "{F5}", f6: "{F6}", f7: "{F7}", f8: "{F8}",
    f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
    capslock: "{CAPSLOCK}",
    numlock: "{NUMLOCK}",
    scrolllock: "{SCROLLLOCK}",
    printscreen: "{PRTSC}",
    prtsc: "{PRTSC}",
  };

  // Handle multiple key sequences separated by spaces (e.g. "ctrl+a ctrl+c")
  const sequences = input.trim().split(/\s+/);
  const results: string[] = [];

  for (const seq of sequences) {
    const parts = seq.toLowerCase().split("+");
    let modifiers = "";
    let key = "";

    for (const part of parts) {
      if (modifierMap[part]) {
        modifiers += modifierMap[part];
      } else if (keyMap[part]) {
        key = keyMap[part];
      } else if (part.length === 1) {
        key = part;
      } else {
        // Unknown key, try as literal
        key = part;
      }
    }

    if (modifiers && key) {
      results.push(`${modifiers}(${key})`);
    } else if (key) {
      results.push(key);
    } else if (modifiers) {
      results.push(modifiers);
    }
  }

  return results.join("");
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction
): Promise<void> {
  // Owner only
  if (interaction.user.id !== config.ownerId) {
    return;
  }

  if (interaction.commandName === "focus") {
    // Focus only shows windows, not monitors
    const focusedValue = interaction.options.getFocused();
    const lower = focusedValue.toLowerCase();
    try {
      const windows = await getWindows();
      const choices: { name: string; value: string }[] = [];
      for (const win of windows) {
        if (lower === "" || win.processName.toLowerCase().includes(lower) || win.title.toLowerCase().includes(lower)) {
          const title = win.title.length > 30 ? win.title.slice(0, 30) + "..." : win.title;
          choices.push({ name: `${win.processName}: ${title}`, value: win.processName });
          if (choices.length >= 25) break;
        }
      }
      await interaction.respond(choices.slice(0, 25));
    } catch (err) {
      console.error("Focus autocomplete error:", err);
    }
    return;
  }

  if (interaction.commandName !== "screenshot" && interaction.commandName !== "record") return;

  const focusedValue = interaction.options.getFocused();
  const lower = focusedValue.toLowerCase();

  try {
    const choices: { name: string; value: string }[] = [];

    // Add static options
    choices.push({ name: "Primary monitor", value: "primary" });
    choices.push({ name: "All monitors", value: "all" });

    // Add monitors
    const screens = await getScreens();
    for (const screen of screens) {
      const label = screen.primary
        ? `Monitor ${screen.index + 1} (${screen.width}x${screen.height}, primary)`
        : `Monitor ${screen.index + 1} (${screen.width}x${screen.height})`;
      choices.push({ name: label, value: (screen.index).toString() });
    }

    // Add windows (filter by focused value)
    const windows = await getWindows();
    for (const win of windows) {
      const processLower = win.processName.toLowerCase();
      const titleLower = win.title.toLowerCase();

      // Only show windows that match the focused value
      if (lower === "" || processLower.includes(lower) || titleLower.includes(lower)) {
        // Truncate long titles
        const title = win.title.length > 30 ? win.title.slice(0, 30) + "..." : win.title;
        choices.push({
          name: `${win.processName}: ${title}`,
          value: win.processName,
        });

        // Limit to 25 choices total (Discord max)
        if (choices.length >= 24) break;
      }
    }

    // Filter choices by focused value for static options too
    const filtered = lower
      ? choices.filter((c) => c.name.toLowerCase().includes(lower))
      : choices;

    await interaction.respond(filtered.slice(0, 25));
  } catch (err) {
    console.error("Autocomplete error:", err);
  }
}
