# remote-claude

A Discord bot that gives you remote access to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from anywhere. Send DMs from your phone, tablet, or any device — Claude Code runs on your local machine with full filesystem and tool access, and streams responses back to Discord in real time.

## How It Works

```
Discord DM → Discord.js bot (local) → claude -p (CLI) → Local filesystem
```

You DM the bot, it spawns `claude -p` with your prompt piped via stdin, streams the response back event-by-event, and handles all the message splitting and formatting for Discord automatically.

## Features

- **Remote access** — use Claude Code from any device with Discord
- **Streaming responses** — real-time output as Claude works, via `--output-format stream-json`
- **Tool visibility** — optionally show file reads, edits, and bash commands as they happen
- **Session continuity** — conversations persist across messages via `--continue`
- **Memory system** — save facts for Claude to remember across all sessions (`/remember`, `/viewmemory`, `/forget`)
- **Message recall** — search your Discord DM history and inject matching messages into context (`/recall`)
- **Todo tracking** — view Claude's live task list (`/todo`)
- **Screenshots** — capture your screen and have Claude analyze it (`/screenshot`)
- **Screen recording** — record a region or window and send it back
- **Auto-restart** — the bot watches for crashes and restarts itself; `/restart` picks up code changes live
- **Discord proxy support** — route API calls through a proxy to bypass corporate firewalls
- **Configurable** — custom bot name, owner name, system prompt, default model, and permission mode via `.env`

## Setup

### 1. Create a Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and create a new application
2. Under **Bot**, enable the **Message Content Intent**
3. Under **OAuth2 → URL Generator**, select `bot` + `applications.commands` scopes and `Send Messages` permission, then invite it to a server (or use a DM-only bot)

### 2. Configure `.env`

Copy `.env.example` to `.env` and fill in:

```env
DISCORD_TOKEN=          # Bot token from the Discord developer portal
DISCORD_APP_ID=         # Application ID
DISCORD_OWNER_ID=       # Your Discord user ID (only you can DM the bot)

# Optional
BOT_NAME=Clawde         # Bot's name (used in system prompt)
OWNER_NAME=             # Your name (used in system prompt)
DEFAULT_CWD=            # Starting working directory (defaults to home dir)
DEFAULT_MODEL=sonnet    # sonnet | opus | haiku
DEFAULT_PERMISSION_MODE=acceptEdits  # default | acceptEdits | bypassPermissions
SYSTEM_PROMPT=          # Custom system prompt appended to every request
DISCORD_PROXY=          # Optional proxy URL for Discord API calls
```

### 3. Install and run

```bash
npm install
npm start
```

The bot sends you a DM when it's online and sets its presence to the current working directory.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/cwd [path]` | View or change the working directory (resets session) |
| `/clear` | Start a fresh conversation |
| `/model [name]` | View or change the model (sonnet / opus / haiku) |
| `/tools show\|hide` | Toggle display of tool usage in responses |
| `/perms [mode]` | Change permission mode (default / acceptEdits / bypassPermissions) |
| `/status` | Show current config (cwd, model, session state, etc.) |
| `/stop` | Cancel the current in-progress request |
| `/restart` | Restart the bot process (picks up code changes) |
| `/remember <text>` | Save a memory for Claude to recall in future sessions |
| `/viewmemory` | List all saved memories |
| `/forget <number>` | Remove a saved memory by number |
| `/recall [query]` | Search DM history and inject matching messages into context |
| `/todo` | View Claude's current todo list |
| `/screenshot [target]` | Capture a screen or window and have Claude analyze it |

## Project Structure

```
src/
  index.ts          — Discord client setup, startup notification, presence
  claude.ts         — Spawns Claude CLI, parses streaming NDJSON output
  messageHandler.ts — Incoming DM → Claude → Discord response pipeline
  commands.ts       — Slash command definitions and handlers
  state.ts          — Persistent state (cwd, model, session, memories, etc.)
  discord.ts        — Message splitting, typing indicator helpers
  screenshot.ts     — Screenshot and screen info utilities
  recording.ts      — Screen recording support
  restart.ts        — Auto-restart wrapper
  config.ts         — Env var loading
```

## Notes

- Prompts are piped via stdin to avoid Windows shell escaping issues
- `--append-system-prompt-file` is used to inject context (Discord interface awareness, recalled history, recent commands, pending screenshots) while avoiding the 8191-character Windows CLI limit
- Changing `/cwd` resets the session since Claude Code sessions are per-directory
- The bot is owner-only by design — only `DISCORD_OWNER_ID` can interact with it
