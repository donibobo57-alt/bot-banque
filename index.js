import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

dotenv.config();

const BOT_NAME = "bot-baque";
const API = "https://discord.com/api/v9";
const CONFIG_PATH = path.resolve("tokens_config.json");
const CLAIM_AUTO = true;

const SUPER_PROPS = Buffer.from(
  JSON.stringify({
    os: "Windows",
    browser: "Discord Client",
    release_channel: "stable",
    client_version: "1.0.9255",
    os_version: "10.0.19045",
    os_arch: "x64",
    system_locale: "fr",
    client_build_number: 382306,
  })
).toString("base64");

function loadTokens() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return Array.isArray(raw.tokens) ? raw.tokens.map((t) => String(t).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveTokens(tokens) {
  const clean = tokens.map((t) => String(t).trim()).filter(Boolean);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ tokens: clean }, null, 2), "utf8");
}

function userHeaders(token) {
  return {
    Authorization: token.trim(),
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9255 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36",
    "Content-Type": "application/json",
    "X-Super-Properties": SUPER_PROPS,
    "X-Discord-Locale": "fr",
  };
}

async function apiReq(token, method, endpoint, body = null) {
  const opts = {
    method,
    headers: userHeaders(token),
  };
  if (body !== null) {
    opts.body = JSON.stringify(body);
  }
  let res = await fetch(`${API}${endpoint}`, opts);
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 5000));
    res = await fetch(`${API}${endpoint}`, opts);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { status: res.status, data };
}

function getAvatarUrl(userId, avatarHash) {
  if (userId && avatarHash) {
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=128`;
  }
  const idx = userId && /^\d+$/.test(userId) ? Number((BigInt(userId) >> 22n) % 6n) : 0;
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

async function fetchAccounts() {
  const tokens = loadTokens();
  const results = [];

  for (const token of tokens) {
    const me = await apiReq(token, "GET", "/users/@me");
    if (me.status !== 200 || !me.data?.id) {
      results.push({ valid: false, username: "Token invalide", avatarUrl: null, balance: 0, token });
      continue;
    }
    const balRes = await apiReq(token, "GET", "/users/@me/virtual-currency/balance");
    let balance = 0;
    if (balRes.status === 200) {
      if (typeof balRes.data === "number") balance = Math.trunc(balRes.data);
      else if (balRes.data && typeof balRes.data === "object") {
        for (const k of ["balance", "amount", "orbs"]) {
          if (typeof balRes.data[k] === "number") {
            balance = Math.trunc(balRes.data[k]);
            break;
          }
        }
      }
    }
    results.push({
      valid: true,
      userId: me.data.id,
      username: me.data.username || "?",
      avatarUrl: getAvatarUrl(me.data.id, me.data.avatar),
      balance,
      token,
    });
  }
  return results;
}

function buildBalancesEmbed(accounts) {
  const total = accounts.reduce((acc, a) => acc + (a.valid ? a.balance : 0), 0);

  const lines = accounts.map((a, i) => {
    if (!a.valid) return `❌ Compte #${i + 1} — Token invalide`;
    return `• **@${a.username}** — **${a.balance} Orbs**`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`💰 ${BOT_NAME} — Comptes & Soldes`)
    .setColor(0x5865f2)
    .setDescription(lines.length ? lines.join("\n") : "Aucun compte dans `tokens_config.json`.")
    .addFields({
      name: "💎 TOTAL DES ORBS",
      value: `**${total} Orbs**`,
      inline: false,
    })
    .setTimestamp();

  const firstWithAvatar = accounts.find((a) => a.valid && a.avatarUrl);
  if (firstWithAvatar) {
    embed.setThumbnail(firstWithAvatar.avatarUrl);
  }
  return embed;
}

function buildAccountsManageEmbed(accounts) {
  const lines = accounts.map((a, i) => {
    if (!a.valid) return `#${i + 1} — ❌ Token invalide`;
    return `#${i + 1} — **@${a.username}** (${a.userId})`;
  });

  return new EmbedBuilder()
    .setTitle(`👤 ${BOT_NAME} — Gestion des comptes`)
    .setColor(0x5865f2)
    .setDescription(lines.length ? lines.join("\n") : "Aucun compte enregistré.")
    .setTimestamp();
}

async function runQuestsAll() {
  const accounts = await fetchAccounts();
  let processed = 0;

  for (const acc of accounts) {
    if (!acc.valid) continue;
    const qRes = await apiReq(acc.token, "GET", "/quests/@me");
    if (qRes.status !== 200) continue;
    const quests = Array.isArray(qRes.data) ? qRes.data : qRes.data?.quests || [];

    for (const q of quests) {
      if (!q?.id || q?.user_status?.completed_at) continue;
      const body = { location: 11, is_targeted: false };
      if (q.traffic_metadata_sealed) {
        body.traffic_metadata_sealed = q.traffic_metadata_sealed;
      }
      await apiReq(acc.token, "POST", `/quests/${q.id}/enroll`, body);
      processed += 1;
      if (CLAIM_AUTO) {
        await new Promise((r) => setTimeout(r, 2000));
        await apiReq(acc.token, "POST", `/quests/${q.id}/claim-reward`, body);
      }
    }
  }
  return processed;
}

function buildPanelComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("baque_refresh")
      .setLabel("Voir les soldes & total")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("baque_run")
      .setLabel("Lancer les quêtes")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("baque_accounts")
      .setLabel("Gérer les comptes")
      .setStyle(ButtonStyle.Secondary)
  );
  return [row];
}

function buildAccountManageComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("baque_acc_add")
      .setLabel("Ajouter un compte")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("baque_acc_remove")
      .setLabel("Retirer un compte")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("baque_acc_clear")
      .setLabel("Vider les comptes")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("baque_back")
      .setLabel("Retour")
      .setStyle(ButtonStyle.Primary)
  );
  return [row];
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`✅ ${BOT_NAME} connecté en tant que ${client.user.tag}`);
  if (process.env.DISCORD_TOKEN && client.application?.id) {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    const cmds = [
      new SlashCommandBuilder()
        .setName("panel")
        .setDescription("Affiche le panneau de bot-baque avec les boutons"),
    ].map((c) => c.toJSON());
    await rest.put(Routes.applicationCommands(client.application.id), { body: cmds });
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "panel") {
    await interaction.deferReply();
    const accounts = await fetchAccounts();
    await interaction.editReply({
      embeds: [buildBalancesEmbed(accounts)],
      components: buildPanelComponents(),
    });
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId === "baque_acc_add") {
      const modal = new ModalBuilder()
        .setCustomId("baque_modal_add")
        .setTitle("Ajouter un compte");
      const input = new TextInputBuilder()
        .setCustomId("token_input")
        .setLabel("Token du compte")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId === "baque_acc_remove") {
      const modal = new ModalBuilder()
        .setCustomId("baque_modal_remove")
        .setTitle("Retirer un compte");
      const input = new TextInputBuilder()
        .setCustomId("index_input")
        .setLabel("Numéro du compte à retirer (ex: 1)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    await interaction.deferUpdate();

    if (interaction.customId === "baque_refresh") {
      const accounts = await fetchAccounts();
      await interaction.editReply({
        embeds: [buildBalancesEmbed(accounts)],
        components: buildPanelComponents(),
      });
    } else if (interaction.customId === "baque_run") {
      const count = await runQuestsAll();
      const accounts = await fetchAccounts();
      await interaction.editReply({
        content: `✅ Traitement terminé (${count} quête(s) traitée(s)).`,
        embeds: [buildBalancesEmbed(accounts)],
        components: buildPanelComponents(),
      });
    } else if (interaction.customId === "baque_accounts") {
      const accounts = await fetchAccounts();
      await interaction.editReply({
        embeds: [buildAccountsManageEmbed(accounts)],
        components: buildAccountManageComponents(),
      });
    } else if (interaction.customId === "baque_acc_clear") {
      saveTokens([]);
      const accounts = await fetchAccounts();
      await interaction.editReply({
        embeds: [buildAccountsManageEmbed(accounts)],
        components: buildAccountManageComponents(),
      });
    } else if (interaction.customId === "baque_back") {
      const accounts = await fetchAccounts();
      await interaction.editReply({
        embeds: [buildBalancesEmbed(accounts)],
        components: buildPanelComponents(),
      });
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    await interaction.deferUpdate();
    const tokens = loadTokens();

    if (interaction.customId === "baque_modal_add") {
      const newToken = interaction.fields.getTextInputValue("token_input").trim();
      if (newToken && !tokens.includes(newToken)) {
        tokens.push(newToken);
        saveTokens(tokens);
      }
    } else if (interaction.customId === "baque_modal_remove") {
      const idx = Number.parseInt(interaction.fields.getTextInputValue("index_input").trim(), 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= tokens.length) {
        tokens.splice(idx - 1, 1);
        saveTokens(tokens);
      }
    }

    const accounts = await fetchAccounts();
    await interaction.editReply({
      embeds: [buildAccountsManageEmbed(accounts)],
      components: buildAccountManageComponents(),
    });
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error("❌ Variable DISCORD_TOKEN manquante.");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
