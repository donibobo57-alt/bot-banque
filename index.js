// ============================================================
// INSTALLATION
//   npm i discord.js @napi-rs/canvas
//
// STRUCTURE
//   index.js
//   .env            -> TOKEN=ton_token
//
// BANNIÈRES
//   - Carte 4C/3C/2C : la bannière de PROFIL Discord du membre est copiée.
//     S'il n'en a pas -> bannière ajoutée avec la commande -> sinon NOIR.
//   - Cartes join / boost : bannière ajoutée avec la commande, sinon NOIR.
//   Dans /join-membre, /join-boost et /join-membre-4c2c, l'option "banniere"
//   ajoute une image (format bannière : large, ex. 1280x720 ou 960x320).
//   Tu peux en ajouter plusieurs : une est choisie au hasard.
//   L'option "vider_bannieres" supprime celles ajoutées pour cette commande.
//
// DISCORD DEV PORTAL
//   - Active "Server Members Intent"
//   - Le bot doit avoir la permission "Gérer les rôles"
//     et son rôle doit être placé AU-DESSUS des rôles à donner (4C, 3C, 2C, rôle auto).
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
const IMG_RE = /\.(png|jpe?g|webp)$/i;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ---------- Sauvegarde ----------
const load = () =>
  fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE)) : {};
const save = (data) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));

// ---------- Commandes ----------
const withBannerOptions = (builder) =>
  builder
    .addAttachmentOption((o) =>
      o.setName('banniere').setDescription('Ajoute une bannière (image large) pour ces cartes')
    )
    .addBooleanOption((o) =>
      o
        .setName('vider_bannieres')
        .setDescription('Supprime les bannières ajoutées avec cette commande')
    );

const commands = [
  withBannerOptions(
    new SlashCommandBuilder()
      .setName('join-membre')
      .setDescription('Définit ce salon pour les messages de bienvenue')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addRoleOption((o) =>
        o.setName('role').setDescription("Rôle donné automatiquement à chaque nouvel arrivant")
      )
  ),
  withBannerOptions(
    new SlashCommandBuilder()
      .setName('join-boost')
      .setDescription('Définit ce salon pour les messages de boost')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  ),
  withBannerOptions(
    new SlashCommandBuilder()
      .setName('join-membre-4c2c')
      .setDescription('Définit ce salon pour les membres 4C, 3C et 2C (rôle auto + ping)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  ),
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
const bannerDir = (guildId, type) => path.join(BANNERS_DIR, guildId, type);

function listImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => IMG_RE.test(f))
    .map((f) => path.join(dir, f));
}

// Bannières ajoutées avec la commande (dossier propre au serveur et au type)
function pickBannerFile(guildId, type) {
  const files = listImages(bannerDir(guildId, type));
  if (!files.length) return null;
  return files[Math.floor(Math.random() * files.length)];
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

// Priorité : bannière de profil du membre (si fournie) > bannière de la commande > NOIR
async function drawBanner(ctx, guildId, type, x, y, w, h, memberBannerUrl = null) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(x, y, w, h);

  if (memberBannerUrl) {
    try {
      drawCover(ctx, await loadImage(memberBannerUrl), x, y, w, h);
      return;
    } catch (e) {
      console.error('Bannière du membre illisible :', e.message);
    }
  }

  const file = pickBannerFile(guildId, type);
  if (!file) return;
  try {
    drawCover(ctx, await loadImage(file), x, y, w, h);
  } catch (e) {
    console.error('Bannière illisible :', file, e.message);
  }
}

// ---------- Texte : blanc, majuscules, contour fin, adapté à la largeur ----------
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
  ctx.lineWidth = 2.4; // contour un peu plus épais
  ctx.strokeStyle = '#000000';
  ctx.strokeText(text, cx, cy);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, cx, cy);
}

// ---------- Carte profil blanche (commande 4C2C) : style profil Discord ----------
async function makeCard(user, title, tagLabel, guildId) {
  const W = 1000;
  const H = 600;
  const BANNER_H = 290;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 30);
  ctx.clip();

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // On récupère la bannière de profil Discord du membre (il faut un fetch complet)
  const fullUser = await user.fetch(true).catch(() => user);
  const memberBanner = fullUser.bannerURL({ extension: 'png', size: 1024, forceStatic: true });
  await drawBanner(ctx, guildId, 'tag', 0, 0, W, BANNER_H, memberBanner);

  // Fondu de la bannière vers le blanc
  const fade = ctx.createLinearGradient(0, BANNER_H - 110, 0, BANNER_H);
  fade.addColorStop(0, 'rgba(255,255,255,0)');
  fade.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, BANNER_H - 110, W, 110);

  // Titre : "Bravo, tu as obtenu le rôle @4C"
  drawText(ctx, title, W / 2, 50, W - 80, 44);

  // Photo ronde à gauche, contour noir fin un peu décollé
  const avatar = await loadImage(
    user.displayAvatarURL({ extension: 'png', size: 512, forceStatic: true })
  );
  const r = 90;
  const gap = 9;
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

  // Petite case blanche : le rôle (4C / 3C / 2C)
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

// ---------- Carte centrée (join / boost) ----------
async function makeCenterCard(user, title, guildId, type) {
  const W = 1280;
  const H = 720;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  await drawBanner(ctx, guildId, type, 0, 0, W, H);

  drawText(ctx, title, W / 2, 95, W - 160, 80);

  const avatar = await loadImage(
    user.displayAvatarURL({ extension: 'png', size: 512, forceStatic: true })
  );
  const x = W / 2;
  const y = H / 2;
  const r = 150;
  const gap = 15; // contour blanc un tout petit peu plus proche de la photo

  ctx.beginPath();
  ctx.arc(x, y, r + gap, 0, Math.PI * 2);
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

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

// layout 'center' = join / boost ; layout 'profile' = carte blanche 4C2C
async function sendCard(channel, user, { title, content, tagLabel, layout = 'center', type }) {
  const file =
    layout === 'profile'
      ? await makeCard(user, title, tagLabel, channel.guild.id)
      : await makeCenterCard(user, title, channel.guild.id, type);
  await channel.send({ content, files: [file] });
}

// ---------- Events ----------
client.once('clientReady', async () => {
  await client.application.commands.set(commands);
  console.log(`Connecté en tant que ${client.user.tag}`);
  console.log('Version : cartes v5 | commandes :', commands.map((c) => '/' + c.name).join(', '));
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  const cmd = COMMAND_TYPES[i.commandName];
  if (!cmd || !i.guild) return;

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const lines = [cmd.msg];

  const data = load();
  data[i.guildId] = { ...data[i.guildId], [cmd.type]: i.channelId };

  // /join-membre : rôle donné automatiquement à l'arrivée
  const role = i.options.getRole('role');
  if (role) {
    if (role.managed || role.id === i.guild.id) {
      lines.push("Ce rôle ne peut pas être donné automatiquement (rôle de bot ou @everyone).");
    } else {
      data[i.guildId].joinRole = role.id;
      lines.push(`Chaque nouveau membre recevra automatiquement le rôle ${role.name}.`);
      const me = i.guild.members.me;
      if (me && me.roles.highest.comparePositionTo(role) <= 0) {
        lines.push(
          "Attention : place le rôle du bot AU-DESSUS de ce rôle dans les paramètres du serveur, sinon il ne pourra pas le donner."
        );
      }
    }
  }
  save(data);

  // Bannières : vider puis/ou ajouter
  const dir = bannerDir(i.guildId, cmd.type);
  if (i.options.getBoolean('vider_bannieres')) {
    fs.rmSync(dir, { recursive: true, force: true });
    lines.push('Les bannières ajoutées pour cette commande ont été supprimées.');
  }

  const att = i.options.getAttachment('banniere');
  if (att) {
    const m = /^image\/(png|jpeg|jpg|webp)/.exec(att.contentType || '');
    if (!m) {
      lines.push('Bannière refusée : utilise une image png, jpg ou webp.');
    } else if (att.size > 8 * 1024 * 1024) {
      lines.push('Bannière refusée : image trop lourde (8 Mo max).');
    } else {
      try {
        const res = await fetch(att.url);
        const buf = Buffer.from(await res.arrayBuffer());
        const img = await loadImage(buf); // vérifie que l'image est lisible
        const ratio = img.width / img.height;
        if (ratio < 1.7 || ratio > 4) {
          lines.push(
            `Bannière refusée : ce n'est pas un format bannière (${img.width}x${img.height}). Utilise une image large, par exemple 1280x720 ou 960x320.`
          );
        } else {
          fs.mkdirSync(dir, { recursive: true });
          const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
          fs.writeFileSync(path.join(dir, `${Date.now()}.${ext}`), buf);
          lines.push(`Bannière ajoutée (${listImages(dir).length} au total, choisie au hasard).`);
        }
      } catch (e) {
        console.error(e);
        lines.push("Impossible de charger cette image.");
      }
    }
  }

  await i.editReply(lines.join('\n'));
});

// Nouveau membre
client.on('guildMemberAdd', async (member) => {
  const guild = member.guild;
  const cfg = load()[guild.id] || {};
  const len = member.user.username.length; // nombre de caractères de l'@
  const tagLabel = len >= 2 && len <= 4 ? `${len}C` : null;

  // 1) Rôle automatique de /join-membre
  if (cfg.joinRole) {
    await member.roles
      .add(cfg.joinRole, "Rôle automatique à l'arrivée")
      .catch((e) => console.error('Rôle auto impossible :', e.message));
  }

  // 2) Rôle 4C / 3C / 2C
  let tagRole = null;
  if (tagLabel) {
    try {
      tagRole = await getOrCreateRole(guild, tagLabel);
      await member.roles.add(tagRole);
    } catch (e) {
      console.error('Rôle 4C/3C/2C impossible :', e.message);
      tagRole = null;
    }
  }

  // 3) Bienvenue dans le salon join-membre (ping du membre)
  try {
    const channel = getChannel(guild, 'welcome');
    if (channel) {
      await sendCard(channel, member.user, {
        title: 'BIENVENUE',
        content: `Bienvenue ${member} sur **${guild.name}**. Nous sommes ravis de t'accueillir parmi nous.`,
        layout: 'center',
        type: 'welcome',
      });
    }
  } catch (e) {
    console.error(e);
  }

  // 4) Carte 4C / 3C / 2C dans son salon (ping du membre + du rôle)
  try {
    const tagChannel = getChannel(guild, 'tag');
    if (tagRole && tagChannel) {
      await sendCard(tagChannel, member.user, {
        title: `BRAVO, TU AS OBTENU LE RÔLE @${tagLabel}`,
        content: `${member}\nBravo, tu as obtenu le rôle ${tagRole}`,
        tagLabel,
        layout: 'profile',
        type: 'tag',
      });
    }
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
    await sendCard(channel, newM.user, {
      title: "MERCI D'AVOIR BOOSTÉ LE SERVEUR",
      content: `Merci ${newM} d'avoir boosté **${newM.guild.name}**. Ton soutien compte énormément pour nous.`,
      layout: 'center',
      type: 'boost',
    });
  } catch (e) {
    console.error(e);
  }
});

client.login(TOKEN);
