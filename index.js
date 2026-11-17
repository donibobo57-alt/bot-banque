import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  ActionRowBuilder,
  AttachmentBuilder,
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
const CLAIM_AUTO = true; // réclame automatiquement chaque quête finie[span_1](start_span)[span_1](end_span)

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

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { tokens: [] };
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const tokens = Array.isArray(raw.tokens)
      ? raw.tokens.map((t) => String(t).trim()).filter(Boolean)
      : [];
    return { ...raw, tokens };
  } catch {
    return { tokens: [] };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
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
  const { tokens } = loadConfig();
  const results = [];

  for (const token of tokens) {
    const me = await apiReq(token, "GET", "/users/@me");
    if (me.status !== 200 || !me.data?.id) {
      results.push({
        valid: false,
        userId: null,
        username: "Token invalide",
        avatarUrl: null,
        balance: 0,
        token,
      });
      continue;
    }

    const balRes = await apiReq(token, "GET", "/users/@me/virtual-currency/balance");
    let balance = 0;
    if (balRes.status === 200) {
      if (typeof balRes.data === "number") {
        balance = Math.trunc(balRes.data);
      } else if (balRes.data && typeof balRes.data === "object") {
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

// ==============================================================================
// GÉNÉRATION D'IMAGES DYNAMIQUES
// ==============================================================================

async function generatePanelImage(accounts) {
  const width = 820;
  const height = 420;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Dégradé violet et bleu pour /panel
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, "#6D28D9");
  grad.addColorStop(1, "#1D4ED8");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "rgba(15, 23, 42, 0.35)";
  ctx.roundRect(28, 28, width - 56, height - 56, 24);
  ctx.fill();

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 36px Sans-Serif";
  ctx.fillText(`${BOT_NAME.toUpperCase()} • PANEL`, 60, 95);

  const validCount = accounts.filter((a) => a.valid).length;
  const totalOrbs = accounts.reduce((acc, a) => acc + (a.valid ? a.balance : 0), 0);

  ctx.font = "24px Sans-Serif";
  ctx.fillStyle = "#E0E7FF";
  ctx.fillText(`Comptes actifs : ${validCount}`, 60, 165);
  ctx.fillText(`Total des Orbs : ${totalOrbs} Orbs`, 60, 215);
  ctx.fillText("Utilisez les boutons ci-dessous pour gérer vos comptes & quêtes.", 60, 285);

  return new AttachmentBuilder(canvas.toBuffer("image/png"), { name: "panel.png" });
}

async function generateNoAccountImage() {
  const width = 820;
  const height = 420;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Dégradé jaune et rouge s'il n'y a pas de compte
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, "#FACC15");
  grad.addColorStop(1, "#DC2626");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
  ctx.roundRect(36, 36, width - 72, height - 72, 24);
  ctx.fill();

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 52px Sans-Serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("AUCUN COMPTE", width / 2, height / 2 - 18);

  ctx.font = "24px Sans-Serif";
  ctx.fillText("Ajoutez un token pour afficher les soldes et profils", width / 2, height / 2 + 38);

  return new AttachmentBuilder(canvas.toBuffer("image/png"), { name: "no_account.png" });
}

async function generateAccountsCardImage(accounts) {
  const validAccounts = accounts.filter((a) => a.valid);
  if (validAccounts.length === 0) {
    return generateNoAccountImage();
  }

  const width = 860;
  const rowHeight = 86;
  const height = 160 + validAccounts.length * rowHeight + 40;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Dégradé vert et bleu lorsqu'il y a au moins un compte
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, "#10B981");
  grad.addColorStop(1, "#0284C7");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "rgba(15, 23, 42, 0.38)";
  ctx.roundRect(24, 24, width - 48, height - 48, 24);
  ctx.fill();

  // En haut : le solde des Orbs
  const totalOrbs = validAccounts.reduce((acc, a) => acc + a.balance, 0);
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 30px Sans-Serif";
  ctx.textAlign = "left";
  ctx.fillText(`Solde des Orbs : ${totalOrbs} Orbs`, 52, 76);

  ctx.font = "19px Sans-Serif";
  ctx.fillStyle = "#DCFCE7";
  ctx.fillText(`Comptes (${validAccounts.length})`, 52, 114);

  // De l'autre côté (côté droit) : profils pour chacun des comptes
  let y = 148;
  for (const acc of validAccounts) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.10)";
    ctx.roundRect(44, y, width - 88, rowHeight - 14, 16);
    ctx.fill();

    const rightX = width - 64;
    const avatarSize = 54;
    const avatarX = rightX - avatarSize;
    const avatarY = y + (rowHeight - 14 - avatarSize) / 2;

    // Profil arrondi à droite
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    try {
      const avImg = await loadImage(acc.avatarUrl);
      ctx.drawImage(avImg, avatarX, avatarY, avatarSize, avatarSize);
    } catch {
      ctx.fillStyle = "#1E293B";
      ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
    }
    ctx.restore();

    // Nom du compte + solde individuel à gauche de son profil
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 22px Sans-Serif";
    ctx.textAlign = "right";
    ctx.fillText(`@${acc.username} (${acc.balance} Orbs)`, avatarX - 18, y + 43);

    y += rowHeight;
  }

  return new AttachmentBuilder(canvas.toBuffer("image/png"), { name: "accounts.png" });
}

// ==============================================================================
// GESTION DES QUÊTES
// ==============================================================================

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

function buildPanelButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("baque_accounts")
        .setLabel("Comptes & Soldes")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("baque_add_token")
        .setLabel("Ajouter un compte")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("baque_run_quests")
        .setLabel("Lancer les quêtes")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

// ==============================================================================
// CLIENT DISCORD
// ==============================================================================

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`✅ ${BOT_NAME} connecté en tant que ${client.user.tag}`);
  if (process.env.DISCORD_TOKEN && client.application?.id) {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
      new SlashCommandBuilder()
        .setName("panel")
        .setDescription("Affiche le panneau principal de bot-baque"),
      new SlashCommandBuilder()
        .setName("help")
        .setDescription("Affiche l'aide de bot-baque"),
    ].map((c) => c.toJSON());
    await rest.put(Routes.applicationCommands(client.application.id), { body: commands });
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "panel") {
      await interaction.deferReply();
      const accounts = await fetchAccounts();
      const image = await generatePanelImage(accounts);
      const embed = new EmbedBuilder()
        .setTitle(`🎛️ ${BOT_NAME} — Panel`)
        .setColor(0x6d28d9)
        .setImage("attachment://panel.png");
      await interaction.editReply({
        embeds: [embed],
        files: [image],
        components: buildPanelButtons(),
      });
      return;
    }

    if (interaction.commandName === "help") {
      const embed = new EmbedBuilder()
        .setTitle(`📖 Aide — ${BOT_NAME}`)
        .setColor(0x3b82f6)
        .setDescription(
          [
            "• **`/panel`** : Affiche le panneau violet/bleu avec les boutons de contrôle.",
            "• **`/help`** : Affiche cette liste des commandes et boutons.",
            "• **Bouton `Comptes & Soldes`** : Génère l'image vert/bleu avec le solde des Orbs en haut et les profils des comptes à droite (ou jaune/rouge `AUCUN COMPTE` s'il n'y a pas de compte).",
            "• **Bouton `Ajouter un compte`** : Ouvre une fenêtre pour ajouter un token dans `tokens_config.json`.",
            "• **Bouton `Lancer les quêtes`** : Lance l'inscription et la réclamation automatique des quêtes.",
          ].join("\n")
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === "baque_add_token") {
      const modal = new ModalBuilder()
        .setCustomId("baque_modal_token")
        .setTitle("Ajouter un compte");
      const input = new TextInputBuilder()
        .setCustomId("token_field")
        .setLabel("Token Discord")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    await interaction.deferUpdate();

    if (interaction.customId === "baque_accounts") {
      const accounts = await fetchAccounts();
      const validAccounts = accounts.filter((a) => a.valid);
      const image = await generateAccountsCardImage(accounts);
      const embed = new EmbedBuilder()
        .setTitle(
          validAccounts.length > 0
            ? `💰 ${BOT_NAME} — Soldes & Profils`
            : `⚠️ ${BOT_NAME} — Aucun compte`
        )
        .setColor(validAccounts.length > 0 ? 0x10b981 : 0xdc2626)
        .setImage(`attachment://${image.name}`);
      await interaction.editReply({
        embeds: [embed],
        files: [image],
        components: buildPanelButtons(),
      });
    } else if (interaction.customId === "baque_run_quests") {
      const processed = await runQuestsAll();
      const accounts = await fetchAccounts();
      const image = await generateAccountsCardImage(accounts);
      const embed = new EmbedBuilder()
        .setTitle(`🚀 ${BOT_NAME} — Quêtes lancées (${processed})`)
        .setColor(0x10b981)
        .setImage(`attachment://${image.name}`);
      await interaction.editReply({
        embeds: [embed],
        files: [image],
        components: buildPanelButtons(),
      });
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === "baque_modal_token") {
    await interaction.deferReply({ ephemeral: true });
    const token = interaction.fields.getTextInputValue("token_field").trim();
    const cfg = loadConfig();
    if (!cfg.tokens.includes(token)) {
      cfg.tokens.push(token);
      saveConfig(cfg);
    }
    await interaction.editReply({ content: "✅ Compte enregistré dans `tokens_config.json`." });
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error("❌ Variable DISCORD_TOKEN manquante.");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
