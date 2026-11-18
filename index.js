// ============================================================
// INSTALLATION
//   npm i discord.js @napi-rs/canvas
//
// STRUCTURE
//   index.js
//   .env            -> TOKEN=ton_token
//   banners/        -> mets-y UNE OU PLUSIEURS bannières (png, jpg, webp)
//                      format conseillé : large, ex. 1000x280 (ratio ~3.5:1)
//                      une bannière au hasard est choisie à chaque carte
//
// DISCORD DEV PORTAL
//   - Active "Server Members Intent"
//   - Le bot doit avoir la permission "Gérer les rôles"
//     (et son rôle doit être placé au-dessus des rôles 4C/3C/2C)
// ============================================================

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

try {
  process.loadEnvFile();
} catch {}
const TOKEN = (process.env.TOKEN || '').trim();
if (!TOKEN) {
  console.error('Token manquant : crée un fichier .env avec la ligne TOKEN=ton_token');
  process.exit(1);
}

const CONFIG_FILE = './config.json';
const BANNERS_DIR = './banners';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ---------- Sauvegarde des salons ----------
const load = () =>
  fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE)) : {};
const save = (data) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));

// ---------- Commandes ----------
const commands = [
  new SlashCommandBuilder()
    .setName('join-membre')
    .setDescription('Définit ce salon pour les messages de bienvenue')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('join-boost')
    .setDescription('Définit ce salon pour les messages de boost')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('join-membre-4c2c')
    .setDescription('Définit ce salon pour les membres 4C, 3C et 2C (rôle auto + ping)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

const COMMAND_TYPES = {
  'join-membre': { type: 'welcome', msg: 'Les messages de bienvenue seront envoyés dans ce salon.' },
  'join-boost': { type: 'boost', msg: 'Les messages de boost seront envoyés dans ce salon.' },
  'join-membre-4c2c': {
    type: 'tag',
    msg: 'Les membres 4C / 3C / 2C seront accueillis dans ce salon (rôle automatique + ping).',
  },
};

// ---------- Bannières ----------
function pickBannerFile() {
  if (!fs.existsSync(BANNERS_DIR)) return null;
  const files = fs
    .readdirSync(BANNERS_DIR)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  if (!files.length) return null;
  return path.join(BANNERS_DIR, files[Math.floor(Math.random() * files.length)]);
}

// Dessine l'image en "cover" (remplit la zone sans déformer, rogne ce qui dépasse)
function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// ---------- Texte : blanc, majuscules, contour très fin, adapté à la largeur ----------
function drawText(ctx, text, cx, cy, maxWidth, startSize, align = 'center') {
  text = text.toUpperCase();
  let size = startSize;
  do {
    ctx.font = `bold ${size}px sans-serif`;
    size -= 2;
  } while (ctx.measureText(text).width > maxWidth && size > 10);

  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, cx, cy);
  ctx.lineWidth = 1.2; // contour très fin
  ctx.strokeStyle = '#000000';
  ctx.strokeText(text, cx, cy);
}

// ---------- Carte profil blanche (commande 4C2C) : style profil Discord ----------
async function makeCard(user, title, tagLabel) {
  const W = 1000;
  const H = 600;
  const BANNER_H = 290;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Coins arrondis sur toute la carte
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 30);
  ctx.clip();

  // Fond blanc
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Bannière copiée en haut
  const bannerFile = pickBannerFile();
  let drawn = false;
  if (bannerFile) {
    try {
      drawCover(ctx, await loadImage(bannerFile), 0, 0, W, BANNER_H);
      drawn = true;
    } catch (e) {
      console.error('Bannière illisible :', bannerFile, e.message);
    }
  }
  if (!drawn) {
    ctx.fillStyle = '#cccccc';
    ctx.fillRect(0, 0, W, BANNER_H);
  }

  // Fondu de la bannière vers le blanc
  const fade = ctx.createLinearGradient(0, BANNER_H - 110, 0, BANNER_H);
  fade.addColorStop(0, 'rgba(255,255,255,0)');
  fade.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, BANNER_H - 110, W, 110);

  // Titre en haut (sur la bannière)
  drawText(ctx, title, W / 2, 50, W - 80, 44);

  // Photo de profil ronde à gauche, contour noir fin décollé
  const avatar = await loadImage(
    user.displayAvatarURL({ extension: 'png', size: 512, forceStatic: true })
  );
  const r = 90;
  const gap = 12;
  const ax = 150;
  const ay = BANNER_H;

  ctx.beginPath();
  ctx.arc(ax, ay, r + gap + 6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(ax, ay, r + gap, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#000000';
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.arc(ax, ay, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(avatar, ax - r, ay - r, r * 2, r * 2);
  ctx.restore();

  // Petite case blanche à côté de la photo : le rôle (4C / 3C / 2C)
  if (tagLabel) {
    const bw = 120;
    const bh = 120;
    const bx = ax + r + gap + 40;
    const by = BANNER_H - 10;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 24);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    drawText(ctx, tagLabel, bx + bw / 2, by + bh / 2 + 2, bw - 24, 52);
  }

  // Pseudo en bas à gauche
  drawText(ctx, user.displayName || user.username, 50, 505, W - 100, 64, 'left');

  return new AttachmentBuilder(await canvas.encode('png'), { name: 'card.png' });
}

// ---------- Carte centrée (join / boost) : bannière plein cadre, photo au centre ----------
async function makeCenterCard(user, title) {
  const W = 1280;
  const H = 720;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Bannière en fond (plein cadre)
  ctx.fillStyle = '#cccccc';
  ctx.fillRect(0, 0, W, H);
  const bannerFile = pickBannerFile();
  if (bannerFile) {
    try {
      drawCover(ctx, await loadImage(bannerFile), 0, 0, W, H);
    } catch (e) {
      console.error('Bannière illisible :', bannerFile, e.message);
    }
  }

  // Titre en haut
  drawText(ctx, title, W / 2, 95, W - 160, 80);

  // Photo de profil agrandie, au centre
  const avatar = await loadImage(
    user.displayAvatarURL({ extension: 'png', size: 512, forceStatic: true })
  );
  const x = W / 2;
  const y = H / 2;
  const r = 150;
  const gap = 24; // espace entre la photo et le contour blanc

  // Contour blanc fin, décollé de la photo (avec une légère ombre pour qu'il se voie)
  ctx.beginPath();
  ctx.arc(x, y, r + gap, 0, Math.PI * 2);
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  // Photo + petit liseré noir
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(avatar, x - r, y - r, r * 2, r * 2);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, r + 1, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000000';
  ctx.stroke();

  // Pseudo en bas
  drawText(ctx, user.displayName || user.username, W / 2, H - 95, W - 160, 90);

  return new AttachmentBuilder(await canvas.encode('png'), { name: 'card.png' });
}

// ---------- Rôles 4C / 3C / 2C (créés une seule fois) ----------
const roleLocks = new Map();

async function getOrCreateRole(guild, name) {
  const key = `${guild.id}:${name}`;
  if (roleLocks.has(key)) return roleLocks.get(key); // évite la double création

  const promise = (async () => {
    await guild.roles.fetch();
    let role = guild.roles.cache.find((r) => r.name === name);
    if (!role) {
      role = await guild.roles.create({
        name,
        mentionable: true,
        reason: 'Rôle automatique pseudo court',
      });
    }
    return role;
  })();

  roleLocks.set(key, promise);
  try {
    return await promise;
  } finally {
    roleLocks.delete(key);
  }
}

// ---------- Envoi ----------
function getChannel(guild, type) {
  const id = load()[guild.id]?.[type];
  return id && guild.channels.cache.get(id);
}

// layout 'center' = join / boost (croquis) ; layout 'profile' = carte blanche 4C-2C
async function sendCard(channel, user, title, content, tagLabel, layout = 'center') {
  const file =
    layout === 'profile'
      ? await makeCard(user, title, tagLabel)
      : await makeCenterCard(user, title);
  await channel.send({ content, files: [file] });
}

// ---------- Events ----------
client.once('clientReady', async () => {
  await client.application.commands.set(commands);
  console.log(`Connecté en tant que ${client.user.tag}`);
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  const cmd = COMMAND_TYPES[i.commandName];
  if (!cmd) return;

  const data = load();
  data[i.guildId] = { ...data[i.guildId], [cmd.type]: i.channelId };
  save(data);

  await i.reply({ content: cmd.msg, flags: MessageFlags.Ephemeral });
});

// Nouveau membre
client.on('guildMemberAdd', async (member) => {
  try {
    const guild = member.guild;
    const len = member.user.username.length; // nombre de caractères de l'@
    const isShort = len >= 2 && len <= 4;
    const tagLabel = isShort ? `${len}C` : null;

    // Pseudo court : rôle auto + salon dédié + ping du rôle
    const tagChannel = getChannel(guild, 'tag');
    if (isShort && tagChannel) {
      const role = await getOrCreateRole(guild, tagLabel);
      await member.roles.add(role).catch(console.error);
      await sendCard(
        tagChannel,
        member.user,
        'BIENVENUE',
        `${member}\nBravo, tu as obtenu le rôle ${role}`,
        tagLabel,
        'profile'
      );
      return;
    }

    // Bienvenue classique
    const channel = getChannel(guild, 'welcome');
    if (!channel) return;
    await sendCard(
      channel,
      member.user,
      'BIENVENUE',
      `Bienvenue ${member} sur **${guild.name}**. Nous sommes ravis de t'accueillir parmi nous.`,
      tagLabel
    );
  } catch (e) {
    console.error(e);
  }
});

// Nouveau boost
client.on('guildMemberUpdate', async (oldM, newM) => {
  if (oldM.premiumSince || !newM.premiumSince) return;
  try {
    const channel = getChannel(newM.guild, 'boost');
    if (!channel) return;
    const len = newM.user.username.length;
    const tagLabel = len >= 2 && len <= 4 ? `${len}C` : null;
    await sendCard(
      channel,
      newM.user,
      "MERCI D'AVOIR BOOSTÉ LE SERVEUR",
      `Merci ${newM} d'avoir boosté **${newM.guild.name}**. Ton soutien compte énormément pour nous.`,
      tagLabel
    );
  } catch (e) {
    console.error(e);
  }
});

client.login(TOKEN);
