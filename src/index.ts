import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  InteractionType,
  ActivityType,
} from "discord.js";
import { config } from "./config";
import { getState } from "./state";
import { handleDirectMessage, injectStartupContext } from "./messageHandler";
import { registerCommands, handleCommand } from "./commands";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

export function updateBotPresence(cwd: string) {
  if (client.user) {
    client.user.setPresence({
      status: "online",
      activities: [{
        name: cwd,
        type: ActivityType.Watching,
      }],
    });
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  const state = getState();
  console.log(`Setting presence to: "${state.cwd}"`);
  updateBotPresence(state.cwd);
  try {
    await registerCommands();

    // Send startup notification to owner
    const owner = await c.users.fetch(config.ownerId);
    await owner.send("✅ I'm back up and running!");

    // Inject startup context into Claude's session (without sending response to Discord)
    const dmChannel = await owner.createDM();
    await injectStartupContext(dmChannel);
  } catch (err) {
    console.error("Failed to register commands or send startup DM:", err);
  }
});

client.on(Events.MessageCreate, handleDirectMessage);

client.on(Events.InteractionCreate, async (interaction) => {
  // Handle autocomplete
  if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
    try {
      const { handleAutocomplete } = await import("./commands");
      await handleAutocomplete(interaction as any);
    } catch (err) {
      console.error("Autocomplete error:", err);
    }
    return;
  }

  if (interaction.type !== InteractionType.ApplicationCommand) return;
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction);
  } catch (err) {
    console.error("Command error:", err);
    const reply = interaction.replied || interaction.deferred
      ? interaction.followUp.bind(interaction)
      : interaction.reply.bind(interaction);
    await reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
  }
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  client.destroy();
  process.exit(0);
});

client.login(config.discordToken);
