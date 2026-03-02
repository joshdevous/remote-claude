import {
  Message,
  ChannelType,
  DMChannel,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ButtonInteraction,
  ComponentType,
  Collection,
  Attachment,
} from "discord.js";
import { config } from "./config";
import { getState, updateState } from "./state";
import { sendMessage, cancelCurrentRequest, StreamEvent } from "./claude";
import { splitMessage, startTypingIndicator } from "./discord";
// No screenshot imports — use /screenshot command instead
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";

let busy = false;
let currentRequestCancelled = false;

export function forceStop(): void {
  cancelCurrentRequest();
  currentRequestCancelled = true;
  busy = false;
}
let pendingMessage: { prompt: string; message: Message } | null = null;
let recalledContext: string | null = null;
let justRestarted = true; // Flag to inject restart context on first message

export function setRecalledContext(context: string): void {
  recalledContext = context;
}

export function clearRecalledContext(): void {
  recalledContext = null;
}

export function getRecalledContext(): string | null {
  // One-time injection: --continue preserves context in Clawde's session after first send
  const ctx = recalledContext;
  recalledContext = null;
  return ctx;
}

export async function injectStartupContext(channel: DMChannel): Promise<void> {
  // Just set the flag - actual context will be injected on first message
  justRestarted = true;
  console.log("[startup] Will inject restart context on first message");
}

export async function handleDirectMessage(message: Message): Promise<void> {
  // Ignore bots
  if (message.author.bot) return;

  // Only DMs
  if (message.channel.type !== ChannelType.DM) return;

  // Owner only
  if (message.author.id !== config.ownerId) {
    await message.reply("This bot is private.");
    return;
  }

  const prompt = message.content;
  const attachments = message.attachments;

  // Require either text or attachments
  if (!prompt.trim() && attachments.size === 0) return;

  // If busy, show cancel button
  if (busy) {
    const cancelButton = new ButtonBuilder()
      .setCustomId("cancel_and_send")
      .setLabel("Cancel & send this instead")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⏹");

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(cancelButton);

    const reply = await message.reply({
      content: "Still processing previous request.",
      components: [row],
    });

    // Store the pending message
    pendingMessage = { prompt, message };

    // Wait for button click (30s timeout)
    try {
      const interaction = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i: ButtonInteraction) => i.user.id === config.ownerId && i.customId === "cancel_and_send",
        time: 30_000,
      });

      // Cancel current request — flag the current one so it doesn't send
      currentRequestCancelled = true;
      cancelCurrentRequest();
      await interaction.update({ content: "Cancelled. Processing new message...", components: [] });

      // Wait for busy to clear (the cancel will cause the current request to finish)
      await waitForNotBusy(5000);

      // Now process the pending message
      const pending = pendingMessage;
      pendingMessage = null;
      if (pending) {
        await processMessage(pending.prompt, pending.message.attachments, pending.message, false);
      }
    } catch {
      // Button timed out — remove it
      await reply.edit({ content: "Still processing previous request.", components: [] }).catch(() => {});
      pendingMessage = null;
    }

    return;
  }

  await processMessage(prompt, attachments, message, false);
}

async function waitForNotBusy(timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (busy && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function processMessage(
  prompt: string,
  attachments: Collection<string, Attachment>,
  message: Message,
  isCancelled: boolean
): Promise<void> {
  const channel = message.channel as DMChannel;
  busy = true;

  // Create a local flag to track if THIS specific request was cancelled
  const cancelled = { value: isCancelled };

  const typing = startTypingIndicator(message.channel);

  // Download attachments (images, PDFs, text files, code, etc.)
  const attachmentPaths: string[] = [];
  const tempDir = path.join(process.cwd(), ".temp-attachments");

  try {
    if (attachments.size > 0) {
      // Ensure temp directory exists
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      for (const attachment of attachments.values()) {
        const filename = `${Date.now()}-${attachment.name}`;
        const filepath = path.join(tempDir, filename);
        await downloadFile(attachment.url, filepath);
        attachmentPaths.push(filepath);
      }
    }

    const state = getState();

    // Track streaming content in order
    const status = {
      messages: [] as Message[],
      parts: [] as Array<{ type: 'tool' | 'text', content: string }>,
      lastEdit: 0
    };
    const EDIT_INTERVAL = 1000;
    const MAX_MSG_LENGTH = 1900;

    const updateStatus = async () => {
      if (cancelled.value) return;

      const now = Date.now();
      if (now - status.lastEdit < EDIT_INTERVAL) return;
      status.lastEdit = now;

      // Build display preserving order
      const lines: string[] = [];
      let textBuffer = "";

      for (const part of status.parts) {
        if (part.type === 'tool') {
          if (textBuffer) {
            lines.push(textBuffer);
            textBuffer = "";
          }
          lines.push(part.content);
        } else {
          textBuffer += part.content;
        }
      }

      if (textBuffer) {
        lines.push(textBuffer);
      }

      const fullDisplay = lines.join("\n\n") || "⏳ Thinking...";

      // Split into chunks if needed
      const chunks: string[] = [];
      if (fullDisplay.length <= MAX_MSG_LENGTH) {
        chunks.push(fullDisplay);
      } else {
        let remaining = fullDisplay;
        while (remaining.length > 0) {
          if (remaining.length <= MAX_MSG_LENGTH) {
            chunks.push(remaining);
            break;
          }
          // Find a good break point (newline) near the limit
          let breakPoint = remaining.lastIndexOf('\n', MAX_MSG_LENGTH);
          if (breakPoint === -1 || breakPoint < MAX_MSG_LENGTH / 2) {
            breakPoint = MAX_MSG_LENGTH;
          }
          chunks.push(remaining.slice(0, breakPoint));
          remaining = remaining.slice(breakPoint).trimStart();
        }
      }

      try {
        // Update or create messages as needed
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (status.messages[i]) {
            // Update existing message
            await status.messages[i].edit(chunk);
          } else {
            // Create new message
            const msg = await channel.send(chunk);
            status.messages.push(msg);
          }
        }

        // Delete extra messages if we have fewer chunks now
        while (status.messages.length > chunks.length) {
          const extra = status.messages.pop();
          await extra?.delete().catch(() => {});
        }
      } catch {
        // Ignore edit failures
      }
    };

    const onStream = (event: StreamEvent) => {
      if (cancelled.value) return;

      if (event.type === "tool_use") {
        status.parts.push({ type: 'tool', content: event.content });
        updateStatus();
      } else if (event.type === "text") {
        status.parts.push({ type: 'text', content: event.content });
        updateStatus();
      }
    };

    // Build the full prompt with attachment references and command context
    let fullPrompt = prompt || "What's in this?";

    // Prepend recent slash commands so Claude knows what happened between messages
    if (state.recentCommands && state.recentCommands.length > 0) {
      const cmdContext = `[The user ran these slash commands since the last message: ${state.recentCommands.join(", ")}]\n\n`;
      fullPrompt = cmdContext + fullPrompt;
    }

    if (attachmentPaths.length > 0) {
      const fileList = attachmentPaths.map((p, i) => `${i + 1}. ${p}`).join("\n");
      fullPrompt = `The user sent ${attachmentPaths.length} file${attachmentPaths.length > 1 ? 's' : ''}. Please use the Read tool to view ${attachmentPaths.length > 1 ? 'them' : 'it'}:\n${fileList}\n\nUser's message: ${fullPrompt}`;
    }

    // Get recalled context (if any) and pass it to Claude
    const context = getRecalledContext();
    const shouldIncludeRestart = justRestarted;
    if (justRestarted) {
      justRestarted = false; // Clear flag after first use
    }
    const response = await sendMessage(fullPrompt, state, onStream, context, shouldIncludeRestart);

    // Clear recent commands after they've been injected into context
    if (state.recentCommands && state.recentCommands.length > 0) {
      updateState({ recentCommands: [] });
    }

    // Clean up pending screenshot after Claude has seen it
    if (state.pendingScreenshot) {
      updateState({ pendingScreenshot: null });
    }

    // Clean up all temp files (screenshots, user uploads, system prompts)
    for (const dir of [".temp-attachments", ".temp-prompts"]) {
      try {
        const tempDir = path.join(state.cwd, dir);
        if (fs.existsSync(tempDir)) {
          for (const file of fs.readdirSync(tempDir)) {
            try {
              fs.unlinkSync(path.join(tempDir, file));
            } catch {}
          }
        }
      } catch (err) {
        console.error(`[messageHandler] Failed to cleanup ${dir}:`, err);
      }
    }

    typing.stop();

    // Check if this request was cancelled while it was running
    if (currentRequestCancelled) {
      currentRequestCancelled = false;
      cancelled.value = true;
    }

    // If this request was cancelled, don't send the response
    if (cancelled.value) {
      for (const msg of status.messages) {
        await msg.delete().catch(() => {});
      }
      return;
    }

    // Mark active session
    if (!state.hasActiveSession && !response.error) {
      updateState({ hasActiveSession: true });
    }

    // Track cost
    if (response.costUsd) {
      updateState({ sessionCostUsd: state.sessionCostUsd + response.costUsd });
    }

    // Send ghost ping for notification, then delete it
    if (response.text.trim() || response.toolUse.length > 0) {
      const ping = await channel.send(`<@${config.ownerId}>`);
      await ping.delete().catch(() => {});
    }

    // Only send error or no-response cases
    // (text was already streamed via onStream callback)
    if (response.error) {
      await channel.send(`**Error:** ${response.error}`);
    } else if (!response.text.trim() && response.toolUse.length === 0) {
      await channel.send("(No response)");
    }
  } catch (err: any) {
    typing.stop();
    if (!cancelled.value) {
      await channel.send(`**Error:** ${err.message}`).catch(() => {});
    }
  } finally {
    // Clean up downloaded attachments
    for (const filePath of attachmentPaths) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors
      }
    }
    busy = false;
  }
}

// Helper function to download files from URLs
async function downloadFile(url: string, filepath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(filepath);
      response.pipe(fileStream);

      fileStream.on("finish", () => {
        fileStream.close();
        resolve();
      });

      fileStream.on("error", (err) => {
        fs.unlinkSync(filepath);
        reject(err);
      });
    }).on("error", reject);
  });
}
