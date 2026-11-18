// ============================================================
// INSTALLATION
//   npm i discord.js @napi-rs/canvas
//
// STRUCTURE
//   index.js
//   .env            -> TOKEN=ton_token
//
// DISCORD DEV PORTAL (onglet Bot -> Privileged Gateway Intents)
//   - Server Members Intent   (obligatoire)
//   - Presence Intent         (pour /soutien avec le texte de statut)
//
// PERMISSIONS DU BOT
//   Gérer les rôles, Gérer les salons, Expulser des membres,
//   Déplacer des membres, Envoyer des messages, Joindre des fichiers.
//   Son rôle doit être placé AU-DESSUS de tous les rôles qu'il donne.
//
// COMMANDES
//   /accueil               salon de bienvenue (+ rôle automatique, bannières)
//   /annonce-boost         salon des annonces de boost
//   /pseudos-rares         salon des pseudos rares (4C, 4L, Semi 4L...)
//   /messages-perso        change les textes envoyés par le bot
//   /verrouiller           bloque un salon          /deverrouiller  le réouvre
//   /soutien               rôle pour tag du serveur / texte de statut
//   /classement-boosts     classement des boosters + rôles Top 1/2/3 Boost
//   /classement-fond       fond des classements
//   /panneau-roles         embed avec boutons qui donnent des rôles
//   /badges-rares          annonce + rôles pour les badges rares / Nitro / Boost
//   /anti-pub              isole ceux qui font de la pub sur leur profil
//   /modules               active ou désactive chaque fonction du bot
//   /tribunal              audience temporaire     /tribunal-cloturer  la ferme
//
// PSEUDOS RARES (le @ du membre, de 1 à 4 caractères)
//   chiffres seuls -> 4C | lettres seules -> 4L
//   avec un . ou un _ dedans -> Semi 4C | Semi 4L (la longueur compte les . et _)
// ============================================================

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ActivityType,
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

const P = PermissionFlagsBits;
const CONFIG_FILE = './config.json';
const TRIB_FILE = './tribunals.json';
const BANNERS_DIR = './banners';
const IMG_RE = /\.(png|jpe?g|webp)$/i;

// Pseudos rares : longueurs prises en compte
const MIN_LEN = 1;
const MAX_LEN = 4;

// Tribunal
const RESTRICT_AFTER = 5 * 60 * 1000; // 5 min : plus de vocaux visibles
const KICK_AFTER = 60 * 60 * 1000; // 1 h : expulsion
const TRIBUNAL_PENALIZED = ['victim', 'witness']; // qui subit les sanctions d'absence

// Classement : nombre de boosters par page
const PAGE_SIZE = 8;

// Autres tags de serveur considérés comme de la pub ? (false = seuls les liens d'invitation comptent)
const FLAG_OTHER_TAGS = false;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ---------- Sauvegarde ----------
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {});
const load = () => readJson(CONFIG_FILE);
const save = (data) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
const loadT = () => readJson(TRIB_FILE);
const saveT = (data) => fs.writeFileSync(TRIB_FILE, JSON.stringify(data, null, 2));

// ---------- Messages propres (embeds) ----------
const COLORS = { ok: 0x57f287, err: 0xed4245, info: 0x5865f2, warn: 0xfee75c };
const embed = (kind, title, desc) =>
  new EmbedBuilder().setColor(COLORS[kind]).setTitle(title).setDescription(desc);
// Réponse visible uniquement par l'auteur de la commande
const say = (i, kind, title, desc) =>
  i.deferred || i.replied
    ? i.editReply({ embeds: [embed(kind, title, desc)] })
    : i.reply({ embeds: [embed(kind, title, desc)], flags: MessageFlags.Ephemeral });

// ---------- Modules (actif / inactif) ----------
const MODULES = [
  ['welcome', 'Accueil'],
  ['boost', 'Annonces de boost'],
  ['tag', 'Pseudos rares'],
  ['badges', 'Badges rares'],
  ['support', 'Soutien'],
  ['rank', 'Classement des boosts'],
  ['adpub', 'Anti-pub'],
  ['tribunal', 'Tribunal'],
];
const isOn = (gid, key) => load()[gid]?.modules?.[key] !== false;

function modulesPanel(gid) {
  const lines = MODULES.map(([k, n]) => `${isOn(gid, k) ? '🟢' : '🔴'}  **${n}** · ${isOn(gid, k) ? 'actif' : 'inactif'}`);
  const e = embed('info', 'Panneau des modules', `${lines.join('\n')}\n\nClique sur un bouton pour activer ou désactiver un module.`);
  const rows = [];
  for (let k = 0; k < MODULES.length; k += 4) {
    rows.push(
      new ActionRowBuilder().addComponents(
        MODULES.slice(k, k + 4).map(([key, n]) =>
          new ButtonBuilder()
            .setCustomId(`md:${key}`)
            .setLabel(`${n} : ${isOn(gid, key) ? 'Actif' : 'Inactif'}`)
            .setStyle(isOn(gid, key) ? ButtonStyle.Success : ButtonStyle.Danger)
        )
      )
    );
  }
  return { embeds: [e], components: rows };
}

// ---------- Textes personnalisables ----------
const DEFAULTS = {
  welcome: {
    title: 'BIENVENUE',
    text: "Bienvenue {membre} sur **{serveur}**. Nous sommes ravis de t'accueillir parmi nous.",
  },
  boost: {
    title: "MERCI D'AVOIR BOOSTÉ LE SERVEUR",
    text: "Merci {membre} d'avoir boosté **{serveur}**. Ton soutien compte énormément pour nous.",
  },
  tag: {
    title: 'BRAVO, TU AS OBTENU LE RÔLE @{rolenom}',
    text: '{membre}\nBravo, tu as obtenu le rôle {role}',
  },
};
const getMsg = (gid, type) => ({
  ...DEFAULTS[type],
  ...(load()[gid]?.messages?.[type] || {}),
});
const fmt = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

// ---------- Commandes ----------
const withBannerOptions = (builder) =>
  builder
    .addAttachmentOption((o) =>
      o.setName('banniere').setDescription('Ajoute une bannière (image large, ex. 1280x720)')
    )
    .addBooleanOption((o) =>
      o.setName('vider_bannieres').setDescription('Supprime les bannières déjà ajoutées ici')
    );

const roleOpt = (n, desc, required = false) => (o) =>
  o.setName(n).setDescription(desc).setRequired(required);

const commands = [
  withBannerOptions(
    new SlashCommandBuilder()
      .setName('accueil')
      .setDescription('Active les messages de bienvenue dans ce salon')
      .setDefaultMemberPermissions(P.ManageGuild)
      .addRoleOption(roleOpt('role', 'Rôle donné automatiquement à chaque nouvel arrivant'))
  ),
  withBannerOptions(
    new SlashCommandBuilder()
      .setName('annonce-boost')
      .setDescription('Active les annonces de boost dans ce salon')
      .setDefaultMemberPermissions(P.ManageGuild)
  ),
  (
    new SlashCommandBuilder()
      .setName('pseudos-rares')
      .setDescription('Accueille les pseudos rares (4C, 4L, Semi 4C, Semi 4L...) dans ce salon')
      .setDefaultMemberPermissions(P.ManageGuild)
      .addStringOption((o) =>
        o
          .setName('fond')
          .setDescription("Fond de secours si le membre n'a pas de couleur de profil")
          .addChoices({ name: 'Gris', value: 'gris' }, { name: 'Blanc', value: 'blanc' })
      )
  ),
  new SlashCommandBuilder()
    .setName('messages-perso')
    .setDescription('Personnalise les textes envoyés par le bot')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addStringOption((o) =>
      o
        .setName('type')
        .setDescription('Quel message modifier ?')
        .setRequired(true)
        .addChoices(
          { name: 'Bienvenue', value: 'welcome' },
          { name: 'Boost', value: 'boost' },
          { name: 'Pseudo rare', value: 'tag' }
        )
    )
    .addStringOption((o) =>
      o.setName('texte').setDescription('Message. Variables : {membre} {serveur} {pseudo} {role}')
    )
    .addStringOption((o) =>
      o.setName('titre').setDescription('Titre sur la carte. Variables : {pseudo} {serveur} {rolenom}')
    )
    .addBooleanOption((o) =>
      o.setName('reinitialiser').setDescription('Remet le texte par défaut')
    ),
  new SlashCommandBuilder()
    .setName('verrouiller')
    .setDescription("Bloque l'écriture dans un salon")
    .setDefaultMemberPermissions(P.ManageChannels)
    .addChannelOption((o) =>
      o
        .setName('salon')
        .setDescription('Salon à verrouiller (par défaut : celui-ci)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addStringOption((o) => o.setName('raison').setDescription('Raison affichée dans le salon')),
  new SlashCommandBuilder()
    .setName('deverrouiller')
    .setDescription("Rouvre l'écriture dans un salon verrouillé")
    .setDefaultMemberPermissions(P.ManageChannels)
    .addChannelOption((o) =>
      o
        .setName('salon')
        .setDescription('Salon à rouvrir (par défaut : celui-ci)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ),
  new SlashCommandBuilder()
    .setName('soutien')
    .setDescription('Donne un rôle à ceux qui portent le tag ou le statut du serveur')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addStringOption((o) =>
      o.setName('texte').setDescription('Texte à afficher dans le statut personnalisé (la petite bulle)')
    )
    .addRoleOption(roleOpt('role', 'Rôle à donner (par défaut : un rôle "Soutien" créé pour toi)'))
    .addBooleanOption((o) => o.setName('desactiver').setDescription('Désactive le système de soutien')),
  new SlashCommandBuilder()
    .setName('classement-boosts')
    .setDescription('Affiche le classement des boosters et donne les rôles Top Boost')
    .setDefaultMemberPermissions(P.ManageGuild),
  withBannerOptions(
    new SlashCommandBuilder()
      .setName('classement-fond')
      .setDescription('Définit le fond des classements')
      .setDefaultMemberPermissions(P.ManageGuild)
  ),
  new SlashCommandBuilder()
    .setName('panneau-roles')
    .setDescription('Envoie un embed avec des boutons qui donnent des rôles')
    .setDefaultMemberPermissions(P.ManageRoles)
    .addStringOption((o) => o.setName('titre').setDescription("Titre de l'embed").setRequired(true))
    .addStringOption((o) =>
      o.setName('message').setDescription('Texte de l\'embed (\\n pour un retour à la ligne)').setRequired(true)
    )
    .addRoleOption(roleOpt('role1', 'Rôle du bouton 1', true))
    .addStringOption((o) => o.setName('couleur').setDescription('Couleur de l\'embed en hexadécimal (ex. #ff66aa)'))
    .addRoleOption(roleOpt('role2', 'Rôle du bouton 2'))
    .addRoleOption(roleOpt('role3', 'Rôle du bouton 3'))
    .addRoleOption(roleOpt('role4', 'Rôle du bouton 4'))
    .addRoleOption(roleOpt('role5', 'Rôle du bouton 5')),
  new SlashCommandBuilder()
    .setName('tribunal')
    .setDescription('Ouvre une audience : catégorie et vocal temporaires, convocations')
    .setDefaultMemberPermissions(P.KickMembers)
    .addUserOption((o) => o.setName('juge').setDescription('Le juge').setRequired(true))
    .addUserOption((o) => o.setName('avocat').setDescription("L'avocat").setRequired(true))
    .addUserOption((o) => o.setName('victime').setDescription('La victime').setRequired(true))
    .addUserOption((o) => o.setName('temoin').setDescription('Le témoin (facultatif)')),
  new SlashCommandBuilder()
    .setName('tribunal-cloturer')
    .setDescription("Ferme l'audience et supprime les salons temporaires")
    .setDefaultMemberPermissions(P.KickMembers),
  new SlashCommandBuilder()
    .setName('badges-rares')
    .setDescription('Annonce les badges rares (Early, HypeSquad, Nitro, Boost...) dans ce salon')
    .setDefaultMemberPermissions(P.ManageGuild),
  new SlashCommandBuilder()
    .setName('anti-pub')
    .setDescription('Isole les membres qui font de la pub pour un autre serveur sur leur profil')
    .setDefaultMemberPermissions(P.Administrator),
  new SlashCommandBuilder()
    .setName('modules')
    .setDescription('Active ou désactive chaque fonction du bot')
    .setDefaultMemberPermissions(P.ManageGuild),
].map((c) => c.toJSON());

// ---------- Bannières ----------
const bannerDir = (guildId, type) => path.join(BANNERS_DIR, guildId, type);

function listImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => IMG_RE.test(f))
    .map((f) => path.join(dir, f));
}

function pickBannerFile(guildId, type) {
  const files = listImages(bannerDir(guildId, type));
  if (!files.length) return null;
  return files[Math.floor(Math.random() * files.length)];
}

// Image en "cover" : remplit la zone sans déformer
function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// Priorité : bannière de profil du membre > bannière de la commande > noir (ou rien)
// Retourne true si une image a été dessinée
async function drawBanner(ctx, guildId, type, x, y, w, h, memberBannerUrl = null, fillBlack = true) {
  if (fillBlack) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(x, y, w, h);
  }
  if (memberBannerUrl) {
    try {
      drawCover(ctx, await loadImage(memberBannerUrl), x, y, w, h);
      return true;
    } catch (e) {
      console.error('Bannière du membre illisible :', e.message);
    }
  }
  const file = pickBannerFile(guildId, type);
  if (!file) return false;
  try {
    drawCover(ctx, await loadImage(file), x, y, w, h);
    return true;
  } catch (e) {
    console.error('Bannière illisible :', file, e.message);
    return false;
  }
}

// Gère les options "banniere" et "vider_bannieres" d'une commande
async function handleBanners(i, type, lines, problems) {
  const dir = bannerDir(i.guildId, type);
  if (i.options.getBoolean('vider_bannieres')) {
    fs.rmSync(dir, { recursive: true, force: true });
    lines.push('Les bannières ajoutées ici ont été supprimées.');
  }
  const att = i.options.getAttachment('banniere');
  if (!att) return;

  const m = /^image\/(png|jpeg|jpg|webp)/.exec(att.contentType || '');
  if (!m) return problems.push('Bannière refusée : utilise une image png, jpg ou webp.');
  if (att.size > 8 * 1024 * 1024) return problems.push('Bannière refusée : image trop lourde (8 Mo max).');
  try {
    const res = await fetch(att.url);
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buf);
    const ratio = img.width / img.height;
    if (ratio < 1.7 || ratio > 4) {
      return problems.push(
        `Bannière refusée : format ${img.width}x${img.height} trop carré. Utilise une image large, par exemple 1280x720 ou 960x320.`
      );
    }
    fs.mkdirSync(dir, { recursive: true });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    fs.writeFileSync(path.join(dir, `${Date.now()}.${ext}`), buf);
    lines.push(`Bannière ajoutée (${listImages(dir).length} au total, choisie au hasard).`);
  } catch (e) {
    console.error(e);
    problems.push('Impossible de charger cette image.');
  }
}

// ---------- Couleurs ----------
const toRgb = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => {
  const A = toRgb(a);
  const B = toRgb(b);
  return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
};
const rgba = (h, a) => {
  const [r, g, b] = toRgb(h);
  return `rgba(${r},${g},${b},${a})`;
};

// Couleurs moyennes gauche / droite de la bannière du membre (pour faire un dégradé)
async function bannerColors(url) {
  try {
    const img = await loadImage(url);
    const c = createCanvas(2, 1);
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 2, 1);
    const d = x.getImageData(0, 0, 2, 1).data;
    return [toHex(d[0], d[1], d[2]), toHex(d[4], d[5], d[6])];
  } catch {
    return null;
  }
}

// Thème de la carte : couleur d'accent du profil > couleurs de la bannière > gris / blanc
async function memberTheme(fullUser, fond, bannerUrl) {
  if (fullUser.accentColor != null) {
    const c = '#' + fullUser.accentColor.toString(16).padStart(6, '0');
    return { c1: c, c2: mix(c, '#000000', 0.55), text: '#ffffff', light: false };
  }
  if (bannerUrl) {
    const cols = await bannerColors(bannerUrl);
    if (cols) {
      return {
        c1: mix(cols[0], '#000000', 0.25),
        c2: mix(cols[1], '#000000', 0.55),
        text: '#ffffff',
        light: false,
      };
    }
  }
  return fond === 'blanc'
    ? { c1: '#ffffff', c2: '#e3e5e8', text: '#111214', light: true }
    : { c1: '#2b2d31', c2: '#1e1f22', text: '#ffffff', light: false };
}

// ---------- Texte : majuscules, contour fin, adapté à la largeur ----------
function drawText(ctx, text, cx, cy, maxWidth, startSize, align = 'center', color = '#ffffff', outline = '#000000') {
  text = text.toUpperCase();
  let size = startSize;
  do {
    ctx.font = `bold ${size}px sans-serif`;
    size -= 2;
  } while (ctx.measureText(text).width > maxWidth && size > 10);

  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  if (outline) {
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = outline;
    ctx.strokeText(text, cx, cy);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy);
}

const avatarOf = (user) =>
  loadImage(user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true })).catch(() => null);

// ---------- Carte profil (pseudos rares) ----------
async function makeCard(member, title, guildId) {
  const W = 1000;
  const H = 640;
  const BH = 290;
  const user = member.user;

  await member.fetch().catch(() => {});
  const fullUser = await user.fetch(true).catch(() => user);
  const bannerUrl = fullUser.bannerURL({ extension: 'png', size: 1024, forceStatic: true });
  const fond = load()[guildId]?.fond || 'gris';
  const t = await memberTheme(fullUser, fond, bannerUrl);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 30);
  ctx.clip();

  // Fond dégradé
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, t.c1);
  bg.addColorStop(1, t.c2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Seule la bannière du membre est utilisée ; sinon sa couleur de profil
  if (bannerUrl) {
    try {
      drawCover(ctx, await loadImage(bannerUrl), 0, 0, W, BH);
    } catch (e) {
      console.error('Bannière du membre illisible :', e.message);
    }
  }
  const edge = mix(t.c1, t.c2, BH / H);
  const fade = ctx.createLinearGradient(0, BH - 110, 0, BH);
  fade.addColorStop(0, rgba(edge, 0));
  fade.addColorStop(1, rgba(edge, 1));
  ctx.fillStyle = fade;
  ctx.fillRect(0, BH - 110, W, 111);

  drawText(ctx, title, W / 2, 50, W - 80, 44);

  // Photo ronde, contour fin décollé
  const avatar = await avatarOf(user);
  const r = 90;
  const gap = 9;
  const ax = 150;
  const ay = BH;
  ctx.beginPath();
  ctx.arc(ax, ay, r + gap + 6, 0, Math.PI * 2);
  ctx.fillStyle = edge;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ax, ay, r + gap, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = rgba(t.text, 0.7);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.arc(ax, ay, r, 0, Math.PI * 2);
  ctx.clip();
  if (avatar) ctx.drawImage(avatar, ax - r, ay - r, r * 2, r * 2);
  ctx.restore();

  // Pseudo + @
  drawText(ctx, user.displayName || user.username, 50, BH + 150, W - 100, 60, 'left', t.text, null);
  ctx.font = '500 28px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = rgba(t.text, 0.65);
  ctx.fillText(`@${user.username}`, 50, BH + 195);

  // Rôles du membre, comme sur un profil Discord
  const roles = member.roles.cache
    .filter((x) => x.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .first(8);
  const pillBg = t.light ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.10)';
  const pillLine = t.light ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.35)';
  ctx.font = '600 24px sans-serif';
  let px = 50;
  let py = 525;
  for (const role of roles) {
    const w = ctx.measureText(role.name).width + 62;
    if (px + w > W - 50) {
      px = 50;
      py += 58;
    }
    if (py > H - 60) break;
    ctx.beginPath();
    ctx.roundRect(px, py, w, 46, 23);
    ctx.fillStyle = pillBg;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = pillLine;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px + 25, py + 23, 8, 0, Math.PI * 2);
    ctx.fillStyle = role.hexColor && role.hexColor !== '#000000' ? role.hexColor : '#b5bac1';
    ctx.fill();
    ctx.font = '600 24px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = t.text;
    ctx.fillText(role.name, px + 43, py + 24);
    px += w + 12;
  }

  return new AttachmentBuilder(await canvas.encode('png'), { name: 'card.png' });
}

// ---------- Carte centrée (bienvenue / boost) ----------
async function makeCenterCard(user, title, guildId, type) {
  const W = 1280;
  const H = 720;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  await drawBanner(ctx, guildId, type, 0, 0, W, H);
  drawText(ctx, title, W / 2, 95, W - 160, 80);

  const avatar = await avatarOf(user);
  const x = W / 2;
  const y = H / 2;
  const r = 150;
  const gap = 15;

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
  if (avatar) ctx.drawImage(avatar, x - r, y - r, r * 2, r * 2);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, r + 1, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000000';
  ctx.stroke();

  drawText(ctx, user.displayName || user.username, W / 2, H - 95, W - 160, 90);
  return new AttachmentBuilder(await canvas.encode('png'), { name: 'card.png' });
}

// ---------- Classement des boosts ----------
function formatDuration(ms) {
  const d = Math.floor(ms / 86400000);
  if (d < 1) {
    const h = Math.floor(ms / 3600000);
    return h < 1 ? "Moins d'1 h" : `${h} h`;
  }
  const y = Math.floor(d / 365);
  const mo = Math.floor((d % 365) / 30);
  const j = (d % 365) % 30;
  if (y) return `${y} an${y > 1 ? 's' : ''}${mo ? ` ${mo} mois` : ''}`;
  if (mo) return `${mo} mois${j ? ` ${j} j` : ''}`;
  return `${d} j`;
}

async function getRanked(guild) {
  const members = await guild.members.fetch();
  return [...members.values()]
    .filter((m) => m.premiumSinceTimestamp)
    .sort((a, b) => a.premiumSinceTimestamp - b.premiumSinceTimestamp)
    .map((m) => ({ member: m, since: m.premiumSinceTimestamp }));
}

// Copie floue d'un canvas (effet verre dépoli derrière les bulles)
function makeFrosted(src, W, H) {
  let cur = src;
  let w = W;
  let h = H;
  for (let n = 0; n < 2; n++) {
    w = Math.max(8, Math.round(w / 5));
    h = Math.max(8, Math.round(h / 5));
    const c = createCanvas(w, h);
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, w, h);
    cur = c;
  }
  const out = createCanvas(W, H);
  const o = out.getContext('2d');
  o.imageSmoothingEnabled = true;
  o.imageSmoothingQuality = 'high';
  o.drawImage(cur, 0, 0, W, H);
  return out;
}

async function makeRankCard(guild, rows, start, page, pages) {
  const W = 1280;
  const ROW_H = 88;
  const GAP = 18;
  const TOP = 190;
  const H = TOP + PAGE_SIZE * (ROW_H + GAP) + 50;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#2b2d31');
  bg.addColorStop(1, '#0b0c0e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const hasImage = await drawBanner(ctx, guild.id, 'rank', 0, 0, W, H, null, false);
  if (hasImage) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, W, H);
  }
  const frosted = makeFrosted(canvas, W, H);

  drawText(ctx, 'CLASSEMENT DES BOOSTS', W / 2, 80, W - 160, 76);
  ctx.font = '500 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillText(`Page ${page + 1} sur ${pages}`, W / 2, 140);

  const avatars = await Promise.all(rows.map((r) => avatarOf(r.member.user)));
  const now = Date.now();

  rows.forEach((row, k) => {
    const x = 110;
    const w = W - 220;
    const y = TOP + k * (ROW_H + GAP);
    const cy = y + ROW_H / 2;

    // Bulle en verre dépoli : fond flou, voile léger, contour blanc
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, ROW_H, ROW_H / 2);
    ctx.clip();
    ctx.drawImage(frosted, 0, 0);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(x, y, w, ROW_H);
    ctx.restore();
    ctx.beginPath();
    ctx.roundRect(x, y, w, ROW_H, ROW_H / 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();

    // Gauche : profil
    const ar = 32;
    const ax = x + 56;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, cy, ar, 0, Math.PI * 2);
    ctx.clip();
    if (avatars[k]) ctx.drawImage(avatars[k], ax - ar, cy - ar, ar * 2, ar * 2);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(ax, cy, ar + 2, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // Milieu : rang + pseudo
    drawText(ctx, `#${start + k + 1}`, x + 118, cy, 90, 42, 'left');
    drawText(ctx, row.member.displayName || row.member.user.username, x + 206, cy, 470, 42, 'left');

    // Droite : durée du boost
    drawText(ctx, formatDuration(now - row.since), x + w - 40, cy, 340, 38, 'right');
  });

  return new AttachmentBuilder(await canvas.encode('png'), { name: 'classement.png' });
}

// ---------- Rôles (créés une fois, puis simplement mis à jour) ----------
// Avantages des 3 plus anciens boosters (modifie la liste comme tu veux)
const TOP_PERKS = {
  top1: [P.MuteMembers, P.ManageNicknames, P.PrioritySpeaker],
  top2: [P.MuteMembers, P.PrioritySpeaker],
  top3: [P.PrioritySpeaker, P.CreateInstantInvite],
};

const BADGE_DEFS = {
  staff: { flag: 'Staff', name: '🛡️ Employé Discord', color: 0x5865f2 },
  partner: { flag: 'Partner', name: '🤝 Partenaire Discord', color: 0x5865f2 },
  events: { flag: 'Hypesquad', name: '🎪 HypeSquad Events', color: 0xf1c40f },
  bug1: { flag: 'BugHunterLevel1', name: '🐛 Chasseur de bugs', color: 0x57f287 },
  bug2: { flag: 'BugHunterLevel2', name: '🐞 Chasseur de bugs Or', color: 0xf1c40f },
  bravery: { flag: 'HypeSquadOnlineHouse1', name: '🟣 HypeSquad Bravery', color: 0x9b59b6 },
  brilliance: { flag: 'HypeSquadOnlineHouse2', name: '🟠 HypeSquad Brilliance', color: 0xe67e22 },
  balance: { flag: 'HypeSquadOnlineHouse3', name: '🟢 HypeSquad Balance', color: 0x2ecc71 },
  early: { flag: 'PremiumEarlySupporter', name: '🌟 Early Supporter', color: 0xeb459e },
  botdev: { flag: 'VerifiedDeveloper', name: '🤖 Développeur de bot pionnier', color: 0x3498db },
  mod: { flag: 'CertifiedModerator', name: '🔨 Ancien modérateur Discord', color: 0x5865f2 },
  devactive: { flag: 'ActiveDeveloper', name: '💻 Développeur actif', color: 0x2ecc71 },
  nitro: { name: '💠 Nitro', color: 0xeb459e },
};
// Paliers de boost mesurés sur la durée du boost dans CE serveur
const BOOST_TIERS = [
  [0, 'Bronze', '🥉', 0xcd7f32],
  [2, 'Argent', '🥈', 0xbdc3c7],
  [3, 'Or', '🥇', 0xf1c40f],
  [6, 'Platine', '💠', 0x7fdbff],
  [9, 'Diamant', '💎', 0x00d4ff],
  [12, 'Émeraude', '🟩', 0x2ecc71],
  [15, 'Rubis', '♦️', 0xe74c3c],
  [18, 'Opale', '🔮', 0xf5b7f0],
  [24, 'Feu', '🔥', 0xff5722],
];
BOOST_TIERS.forEach(([, n, emoji, color], k) => {
  BADGE_DEFS['boost' + k] = { name: `${emoji} Boost ${n}`, color };
});

function roleDef(key) {
  const fixed = {
    top1: { name: '🥇 Top 1 Boost', color: 0xf1c40f, legacy: ['Top 1 Boost'], perms: TOP_PERKS.top1, hoist: true },
    top2: { name: '🥈 Top 2 Boost', color: 0xbdc3c7, legacy: ['Top 2 Boost'], perms: TOP_PERKS.top2, hoist: true },
    top3: { name: '🥉 Top 3 Boost', color: 0xcd7f32, legacy: ['Top 3 Boost'], perms: TOP_PERKS.top3, hoist: true },
    support: { name: '💖 Soutien', color: 0xff6fae, legacy: ['Soutien'] },
    adpub: { name: '🚫 Pub à retirer', color: 0x992d22, legacy: [] },
  };
  if (fixed[key]) return fixed[key];
  if (key.startsWith('tag:')) {
    const label = key.slice(4);
    const semi = label.startsWith('Semi');
    const letters = label.endsWith('L');
    return {
      name: `${semi ? '✨' : letters ? '🔤' : '🔢'} ${label}`,
      color: letters ? 0x5865f2 : 0xeb459e,
      legacy: [label],
    };
  }
  if (key.startsWith('badge:')) return { ...BADGE_DEFS[key.slice(6)], legacy: [] };
  return { name: key, color: 0x99aab5, legacy: [] };
}

const roleLocks = new Map();

async function getOrCreateRole(guild, key) {
  const lock = `${guild.id}:${key}`;
  if (roleLocks.has(lock)) return roleLocks.get(lock);
  const promise = (async () => {
    const def = roleDef(key);
    await guild.roles.fetch();
    const known = load()[guild.id]?.roles?.[key];
    let role =
      guild.roles.cache.get(known) ||
      guild.roles.cache.find((r) => r.name === def.name || (def.legacy || []).includes(r.name));
    if (role) {
      // Déjà créé : on le remet simplement au goût du jour
      if (role.editable) {
        const patch = {};
        if (role.name !== def.name) patch.name = def.name;
        if (role.color !== def.color) patch.color = def.color;
        if (def.perms && role.permissions.bitfield === 0n) patch.permissions = def.perms;
        if (Object.keys(patch).length) await role.edit(patch).catch(() => {});
      }
    } else {
      const base = { name: def.name, color: def.color, hoist: !!def.hoist, mentionable: true, reason: 'Rôle automatique du bot' };
      role = await guild.roles.create({ ...base, permissions: def.perms }).catch(() => guild.roles.create(base));
    }
    const d = load();
    ((d[guild.id] ||= {}).roles ||= {})[key] = role.id;
    save(d);
    return role;
  })();
  roleLocks.set(lock, promise);
  try {
    return await promise;
  } finally {
    roleLocks.delete(lock);
  }
}

// Pseudo rare : chiffres seuls = C, lettres seules = L ; avec . ou _ = Semi
function classifyName(u) {
  const n = u.length;
  if (n < MIN_LEN || n > MAX_LEN) return null;
  const semi = /[._]/.test(u);
  const core = u.replace(/[._]/g, '');
  if (!core) return null;
  const pre = semi ? 'Semi ' : '';
  if (/^[0-9]+$/.test(core)) return { label: `${pre}${n}C` };
  if (/^[a-z]+$/i.test(core)) return { label: `${pre}${n}L` };
  return null;
}

// Top 1 / 2 / 3 Boost : les 3 boosters les plus anciens
async function syncTopBoostRoles(guild, ranked) {
  const roles = [];
  for (const key of ['top1', 'top2', 'top3']) roles.push(await getOrCreateRole(guild, key));
  for (let k = 0; k < 3; k++) {
    const role = roles[k];
    const target = ranked[k]?.member;
    for (const [, m] of role.members) {
      if (!target || m.id !== target.id) await m.roles.remove(role).catch(() => {});
    }
    if (target && !target.roles.cache.has(role.id)) await target.roles.add(role).catch(() => {});
  }
}

async function refreshRank(guild) {
  if (!isOn(guild.id, 'rank')) return;
  try {
    await syncTopBoostRoles(guild, await getRanked(guild));
  } catch (e) {
    console.error('Rôles Top Boost :', e.message);
  }
}

// ---------- Soutien (tag du serveur / texte de statut) ----------
// Majuscules, minuscules et accents sont ignorés ; un chiffre collé au texte est refusé
const norm = (t) => (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matchesStatus(text, wanted) {
  const w = norm(wanted).trim();
  if (!w) return false;
  return new RegExp(`(?<![0-9])${escRe(w)}(?![0-9])`).test(norm(text));
}

// true (soutient), false (ne soutient pas), null (inconnu : hors ligne, Discord ne donne pas le statut)
function supportState(member, sup) {
  const tag = member.user.primaryGuild;
  if (tag?.identityGuildId === member.guild.id && tag.identityEnabled !== false) return true;
  if (!sup.text) return false;
  const p = member.presence;
  if (!p || p.status === 'offline') return null;
  const custom = p.activities.find((a) => a.type === ActivityType.Custom);
  return matchesStatus(custom?.state, sup.text);
}

async function syncSupport(member) {
  const gid = member.guild.id;
  const sup = load()[gid]?.support;
  if (!sup || !isOn(gid, 'support') || member.user.bot) return;
  const state = supportState(member, sup);
  const has = member.roles.cache.has(sup.roleId);
  if (state === true && !has) await member.roles.add(sup.roleId, 'Soutien du serveur').catch(() => {});
  else if (state === false && has) await member.roles.remove(sup.roleId, 'Soutien retiré').catch(() => {});
}

// ---------- Badges rares ----------
async function computeBadges(member, fetchUser = true) {
  const u = fetchUser ? await member.user.fetch(true).catch(() => member.user) : member.user;
  const keys = [];
  for (const [k, d] of Object.entries(BADGE_DEFS)) {
    if (d.flag && u.flags?.has(d.flag)) keys.push(k);
  }
  if (u.avatar?.startsWith('a_') || u.banner) keys.push('nitro');
  if (member.premiumSinceTimestamp) {
    const months = (Date.now() - member.premiumSinceTimestamp) / (30 * 86400000);
    let tier = 0;
    BOOST_TIERS.forEach(([m], k) => {
      if (months >= m) tier = k;
    });
    keys.push('boost' + tier);
  }
  return keys;
}

async function syncBadges(member, announce = false, fetchUser = true) {
  const gid = member.guild.id;
  if (!isOn(gid, 'badges') || member.user.bot) return;
  const keys = await computeBadges(member, fetchUser);
  const known = load()[gid]?.roles || {};
  const gained = [];
  for (const k of keys) {
    const role = await getOrCreateRole(member.guild, 'badge:' + k);
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, 'Badge rare').catch(() => {});
      gained.push(role);
    }
  }
  // Un seul palier de boost à la fois
  for (const k of Object.keys(BADGE_DEFS).filter((x) => x.startsWith('boost') && !keys.includes(x))) {
    const id = known['badge:' + k];
    if (id && member.roles.cache.has(id)) await member.roles.remove(id).catch(() => {});
  }
  if (announce && gained.length) {
    const ch = getChannel(member.guild, 'badges');
    await ch
      ?.send({
        embeds: [
          embed('info', 'Badge rare obtenu', `${member} vient de recevoir : ${gained.map((r) => `${r}`).join(', ')}.`).setThumbnail(
            member.displayAvatarURL({ size: 256 })
          ),
        ],
      })
      .catch(() => {});
  }
}

// ---------- Anti-pub ----------
const INVITE_RE = /(discord\.gg|discord(?:app)?\.com\/invite|dsc\.gg|discord\.me|\bgg\/[\w-]{2,})/i;
const isExempt = (m) =>
  m.user.bot || m.id === m.guild.ownerId || m.permissions.has(P.Administrator) || m.permissions.has(P.ManageGuild);

function adState(member) {
  const tag = member.user.primaryGuild;
  if (FLAG_OTHER_TAGS && tag?.identityGuildId && tag.identityGuildId !== member.guild.id) return true;
  const p = member.presence;
  if (!p || p.status === 'offline') return null;
  const texts = p.activities.flatMap((a) => [a.name, a.state, a.details]).filter(Boolean);
  return texts.some((t) => INVITE_RE.test(t));
}

async function ensureAdSetup(guild) {
  const role = await getOrCreateRole(guild, 'adpub');
  let g = load()[guild.id] || {};
  let ch = guild.channels.cache.get(g.adpub?.channelId);
  if (!ch) {
    ch = await guild.channels.create({
      name: '🚫・retirer-la-pub',
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.id, deny: [P.ViewChannel] },
        { id: role.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.AddReactions] },
        { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks] },
      ],
    });
    await ch.send({
      embeds: [
        embed(
          'err',
          'Accès restreint',
          "**Retirez votre pub de votre profil si vous voulez avoir accès au serveur.**\n\nSupprime le lien d'invitation de ton statut : tes accès te seront rendus automatiquement."
        ),
      ],
    });
  }
  const d = load();
  g = d[guild.id] ||= {};
  g.adpub = { ...g.adpub, roleId: role.id, channelId: ch.id, saved: g.adpub?.saved || {} };
  save(d);
  for (const [, c] of guild.channels.cache) {
    if (c.id !== ch.id) await c.permissionOverwrites.edit(role.id, { ViewChannel: false }).catch(() => {});
  }
}

async function quarantine(member) {
  const ad = load()[member.guild.id].adpub;
  const others = member.roles.cache.filter((r) => r.id !== member.guild.id && r.id !== ad.roleId);
  const keep = others.filter((r) => r.managed || !r.editable).map((r) => r.id);
  const removed = others.filter((r) => !r.managed && r.editable).map((r) => r.id);
  const d = load();
  d[member.guild.id].adpub.saved[member.id] = removed;
  save(d);
  await member.roles.set([...keep, ad.roleId], 'Pub sur le profil').catch((e) => console.error('Isolement impossible :', e.message));
  await member.guild.channels.cache
    .get(ad.channelId)
    ?.send({
      content: `${member}`,
      embeds: [embed('err', 'Accès restreint', 'Retirez votre pub de votre profil si vous voulez avoir accès au serveur.')],
    })
    .catch(() => {});
}

async function release(member) {
  const d = load();
  const ad = d[member.guild.id]?.adpub;
  if (!ad) return;
  const saved = (ad.saved?.[member.id] || []).filter((id) => member.guild.roles.cache.has(id));
  const current = member.roles.cache.filter((r) => r.id !== member.guild.id && r.id !== ad.roleId).map((r) => r.id);
  await member.roles.set([...new Set([...current, ...saved])], 'Pub retirée').catch(() => {});
  delete ad.saved?.[member.id];
  save(d);
}

async function syncAdPub(member) {
  if (!isOn(member.guild.id, 'adpub')) return;
  const ad = load()[member.guild.id]?.adpub;
  if (!ad?.roleId) return;
  const has = member.roles.cache.has(ad.roleId);
  if (!has && isExempt(member)) return;
  const state = adState(member);
  if (state === true && !has) await quarantine(member);
  else if (state === false && has) await release(member);
}

async function releaseAllAdPub(guild) {
  const ad = load()[guild.id]?.adpub;
  if (!ad?.roleId) return;
  const role = guild.roles.cache.get(ad.roleId);
  const members = new Set([...(role?.members.values() || [])]);
  for (const id of Object.keys(ad.saved || {})) {
    const m = await guild.members.fetch(id).catch(() => null);
    if (m) members.add(m);
  }
  for (const m of members) await release(m);
}

// ---------- Vérification globale (soutien, anti-pub, badges de boost) ----------
async function scanGuild(guild) {
  const members = await guild.members.fetch({ withPresences: true }).catch(() => guild.members.cache);
  for (const [, m] of members) {
    await syncSupport(m);
    await syncAdPub(m);
    if (m.premiumSinceTimestamp) await syncBadges(m, true, false);
  }
}
const syncSupportGuild = (g) => scanGuild(g);

// ---------- Envoi des cartes ----------
function getChannel(guild, type) {
  const id = load()[guild.id]?.[type];
  return id && guild.channels.cache.get(id);
}

async function sendCard(channel, member, { title, content, layout = 'center', type }) {
  const file =
    layout === 'profile'
      ? await makeCard(member, title, channel.guild.id)
      : await makeCenterCard(member.user, title, channel.guild.id, type);
  await channel.send({ content, files: [file] });
}

// ---------- Commandes : configuration des salons ----------
const setup = (type, text, extra) => async (i) => {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const lines = [text];
  const problems = [];
  const data = load();
  data[i.guildId] = { ...data[i.guildId], [type]: i.channelId };
  if (extra) extra(i, data[i.guildId], lines, problems);
  save(data);
  await handleBanners(i, type, lines, problems);
  await say(i, problems.length ? 'warn' : 'ok', 'Configuration enregistrée', [...lines, ...problems].join('\n'));
};

const setupWelcome = (i, g, lines, problems) => {
  const role = i.options.getRole('role');
  if (!role) return;
  if (role.managed || role.id === i.guild.id) {
    return problems.push('Ce rôle ne peut pas être donné automatiquement (rôle de bot ou @everyone).');
  }
  g.joinRole = role.id;
  lines.push(`Chaque nouveau membre recevra le rôle ${role.name}.`);
  const me = i.guild.members.me;
  if (me && me.roles.highest.comparePositionTo(role) <= 0) {
    problems.push('Place le rôle du bot AU-DESSUS de ce rôle dans les paramètres du serveur, sinon il ne pourra pas le donner.');
  }
};

const setupTag = (i, g, lines) => {
  const fond = i.options.getString('fond');
  if (fond) {
    g.fond = fond;
    lines.push(`Fond de secours des cartes : ${fond}.`);
  }
};

// ---------- Commandes : messages personnalisés ----------
async function cmdMessages(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const type = i.options.getString('type', true);
  const texte = i.options.getString('texte');
  const titre = i.options.getString('titre');
  const data = load();
  const g = (data[i.guildId] ||= {});
  const msgs = (g.messages ||= {});

  if (i.options.getBoolean('reinitialiser')) {
    delete msgs[type];
    save(data);
    return say(i, 'ok', 'Message réinitialisé', 'Le texte par défaut est de retour.');
  }
  if (!texte && !titre) {
    return say(i, 'warn', 'Rien à modifier', 'Indique un `texte`, un `titre`, ou choisis `reinitialiser`.');
  }
  msgs[type] = { ...msgs[type], ...(texte && { text: texte.replace(/\\n/g, '\n') }), ...(titre && { title: titre }) };
  save(data);

  const m = getMsg(i.guildId, type);
  const vars = { membre: `${i.user}`, serveur: i.guild.name, pseudo: i.user.displayName, role: '@Role', rolenom: '4L' };
  await say(i, 'ok', 'Message mis à jour', `**Aperçu du texte**\n${fmt(m.text, vars)}\n\n**Aperçu du titre**\n${fmt(m.title, vars)}`);
}

// ---------- Commandes : verrouillage ----------
const LOCK_PERMS = ['SendMessages', 'AddReactions', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'];
const snapshot = (ow) =>
  Object.fromEntries(LOCK_PERMS.map((p) => [p, ow?.allow.has(p) ? true : ow?.deny.has(p) ? false : null]));

async function cmdLock(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const ch = i.options.getChannel('salon') || i.channel;
  const raison = i.options.getString('raison');
  const data = load();
  const locks = (data._locks ||= {});
  if (locks[ch.id]) return say(i, 'warn', 'Déjà verrouillé', `${ch} est déjà verrouillé.`);

  const before = snapshot(ch.permissionOverwrites.cache.get(i.guild.id));
  await ch.permissionOverwrites.edit(
    i.guild.id,
    Object.fromEntries(LOCK_PERMS.map((p) => [p, false])),
    { reason: `Verrouillé par ${i.user.username}` }
  );
  locks[ch.id] = before;
  save(data);

  await ch
    .send({
      embeds: [embed('warn', 'Salon verrouillé', `Plus personne ne peut écrire ici pour le moment.${raison ? `\n\n**Raison :** ${raison}` : ''}`)],
    })
    .catch(() => {});
  await say(i, 'ok', 'Salon verrouillé', `${ch} est verrouillé. Utilise \`/deverrouiller\` pour le rouvrir.`);
}

async function cmdUnlock(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const ch = i.options.getChannel('salon') || i.channel;
  const data = load();
  const before = data._locks?.[ch.id] || Object.fromEntries(LOCK_PERMS.map((p) => [p, null]));
  await ch.permissionOverwrites.edit(i.guild.id, before, { reason: `Déverrouillé par ${i.user.username}` });
  if (data._locks) delete data._locks[ch.id];
  save(data);

  await ch.send({ embeds: [embed('ok', 'Salon rouvert', 'Vous pouvez de nouveau écrire ici.')] }).catch(() => {});
  await say(i, 'ok', 'Salon déverrouillé', `${ch} est de nouveau ouvert.`);
}

// ---------- Commandes : soutien ----------
async function cmdSupport(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const data = load();
  const g = (data[i.guildId] ||= {});

  if (i.options.getBoolean('desactiver')) {
    delete g.support;
    save(data);
    return say(i, 'ok', 'Soutien désactivé', 'Le bot ne donne plus ni ne retire le rôle de soutien.');
  }
  const texte = i.options.getString('texte');
  if (!texte) return say(i, 'warn', 'Texte manquant', 'Indique le texte à afficher dans le statut personnalisé.');

  const role = i.options.getRole('role') || (await getOrCreateRole(i.guild, 'support'));
  if (role.managed || role.id === i.guild.id) {
    return say(i, 'err', 'Rôle invalide', 'Choisis un autre rôle (pas un rôle de bot ni @everyone).');
  }
  g.support = { text: texte, roleId: role.id };
  save(data);

  await say(
    i,
    'ok',
    'Soutien activé',
    `Les membres qui portent le **tag du serveur** ou qui écrivent **${texte}** dans leur statut recevront le rôle ${role}. Ils le perdent s'ils l'enlèvent.\n\nVérification en cours, puis régulière.`
  );
  syncSupportGuild(i.guild).catch(() => {});
}

// ---------- Commandes : classement ----------
const rankRow = (owner, page, pages) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rk:${owner}:${page - 1}`).setLabel('Précédent').setStyle(ButtonStyle.Primary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`rk:${owner}:i`).setLabel(`Page ${page + 1} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`rk:${owner}:${page + 1}`).setLabel('Suivant').setStyle(ButtonStyle.Primary).setDisabled(page >= pages - 1)
  );

async function renderRank(guild, owner, page) {
  const ranked = await getRanked(guild);
  const pages = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const start = page * PAGE_SIZE;
  const file = await makeRankCard(guild, ranked.slice(start, start + PAGE_SIZE), start, page, pages);
  return { files: [file], attachments: [], components: pages > 1 ? [rankRow(owner, page, pages)] : [] };
}

async function cmdRank(i) {
  if (!isOn(i.guildId, 'rank')) {
    return say(i, 'warn', 'Module désactivé', 'Le classement est désactivé. Réactive-le avec `/modules`.');
  }
  await i.deferReply();
  const ranked = await getRanked(i.guild);
  if (!ranked.length) {
    return i.editReply({ embeds: [embed('info', 'Classement des boosts', 'Personne ne booste ce serveur pour le moment.')] });
  }
  const data = load();
  (data[i.guildId] ||= {}).rankOn = true;
  save(data);

  await syncTopBoostRoles(i.guild, ranked);
  await i.editReply(await renderRank(i.guild, i.user.id, 0));
}

// Boutons de page : réservés à la personne qui a lancé la commande
async function rankButton(i) {
  const [, owner, pageStr] = i.customId.split(':');
  if (owner !== i.user.id) {
    return say(i, 'err', 'Boutons réservés', 'Seule la personne qui a lancé la commande peut changer de page. Lance `/classement-boosts` pour avoir les tiens.');
  }
  const page = parseInt(pageStr, 10);
  if (Number.isNaN(page)) return i.deferUpdate();
  await i.deferUpdate();
  await i.editReply(await renderRank(i.guild, owner, page));
}

// ---------- Commandes : modules, badges, anti-pub ----------
const cmdModules = (i) => i.reply({ ...modulesPanel(i.guildId), flags: MessageFlags.Ephemeral });

async function moduleButton(i) {
  if (!i.inGuild()) return;
  if (!i.memberPermissions.has(P.ManageGuild)) {
    return say(i, 'err', 'Accès refusé', 'Seuls les administrateurs peuvent modifier les modules.');
  }
  const key = i.customId.slice(3);
  if (!MODULES.some(([k]) => k === key)) return;
  const data = load();
  const g = (data[i.guildId] ||= {});
  const mods = (g.modules ||= {});
  const wasOn = mods[key] !== false;
  mods[key] = !wasOn;
  save(data);
  await i.update(modulesPanel(i.guildId));
  if (key === 'adpub') {
    if (wasOn) releaseAllAdPub(i.guild).catch(console.error);
    else ensureAdSetup(i.guild).then(() => scanGuild(i.guild)).catch(console.error);
  }
}

async function cmdAdPub(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const data = load();
  ((data[i.guildId] ||= {}).modules ||= {}).adpub = true;
  save(data);
  await ensureAdSetup(i.guild);
  await say(
    i,
    'ok',
    'Anti-pub activé',
    "Les membres qui affichent un lien d'invitation dans leur statut perdent l'accès aux salons et ne voient plus que le salon **retirer-la-pub**. Leurs rôles leur sont rendus dès que la pub disparaît.\n\nLes administrateurs et les bots sont ignorés. Désactive-le à tout moment avec `/modules`."
  );
  scanGuild(i.guild).catch(console.error);
}

// ---------- Commandes : panneau de rôles ----------
async function cmdPanel(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const roles = [1, 2, 3, 4, 5].map((n) => i.options.getRole(`role${n}`)).filter(Boolean);
  const unique = [...new Map(roles.map((r) => [r.id, r])).values()];
  const me = i.guild.members.me;

  for (const r of unique) {
    if (r.managed || r.id === i.guild.id) {
      return say(i, 'err', 'Rôle invalide', `Le rôle ${r.name} ne peut pas être donné par un bouton.`);
    }
    if (me.roles.highest.comparePositionTo(r) <= 0) {
      return say(i, 'err', 'Rôle trop haut', `Place le rôle du bot AU-DESSUS de ${r.name} dans les paramètres du serveur.`);
    }
  }
  const couleur = i.options.getString('couleur');
  const color = couleur && /^#?[0-9a-f]{6}$/i.test(couleur) ? parseInt(couleur.replace('#', ''), 16) : 0x5865f2;

  const panel = new EmbedBuilder()
    .setTitle(i.options.getString('titre', true))
    .setDescription(i.options.getString('message', true).replace(/\\n/g, '\n'))
    .setColor(color);
  const row = new ActionRowBuilder().addComponents(
    unique.map((r) =>
      new ButtonBuilder().setCustomId(`rr:${r.id}`).setLabel(r.name.slice(0, 80)).setStyle(ButtonStyle.Secondary)
    )
  );
  await i.channel.send({ embeds: [panel], components: [row] });
  await say(i, 'ok', 'Panneau envoyé', `${unique.length} bouton${unique.length > 1 ? 's' : ''} actif${unique.length > 1 ? 's' : ''} dans ce salon.`);
}

async function onButton(i) {
  if (i.customId.startsWith('rk:')) return rankButton(i);
  if (i.customId.startsWith('md:')) return moduleButton(i);
  if (!i.customId.startsWith('rr:') || !i.inGuild()) return;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const role = i.guild.roles.cache.get(i.customId.slice(3));
  if (!role) return say(i, 'err', 'Rôle introuvable', "Ce rôle n'existe plus.");
  try {
    if (i.member.roles.cache.has(role.id)) {
      await i.member.roles.remove(role);
      await say(i, 'info', 'Rôle retiré', `Tu n'as plus le rôle ${role}.`);
    } else {
      await i.member.roles.add(role);
      await say(i, 'ok', 'Rôle ajouté', `Tu as maintenant le rôle ${role}.`);
    }
  } catch (e) {
    console.error(e);
    await say(i, 'err', 'Impossible', "Je n'ai pas pu modifier ce rôle. Préviens un administrateur.");
  }
}

// ---------- Tribunal ----------
const timers = new Map();

function schedule(c) {
  clearTimers(c.voiceId);
  const now = Date.now();
  timers.set(c.voiceId, [
    setTimeout(() => restrictAbsent(c.voiceId).catch(console.error), Math.max(0, c.createdAt + RESTRICT_AFTER - now)),
    setTimeout(() => kickAbsent(c.voiceId).catch(console.error), Math.max(0, c.createdAt + KICK_AFTER - now)),
  ]);
}

function clearTimers(id) {
  (timers.get(id) || []).forEach(clearTimeout);
  timers.delete(id);
}

const absentTargets = (c) =>
  TRIBUNAL_PENALIZED.map((k) => c[k]).filter((id) => id && !c.arrived.includes(id));

// 5 minutes : les absents ne voient plus aucun autre vocal
async function restrictAbsent(voiceId) {
  const c = loadT()[voiceId];
  if (!c || c.closed) return;
  const guild = client.guilds.cache.get(c.guildId);
  if (!guild) return;
  const targets = absentTargets(c);
  if (!targets.length) return;

  if (!c.hidden) {
    for (const [, ch] of guild.channels.cache.filter((x) => x.isVoiceBased() && x.id !== c.voiceId)) {
      await ch.permissionOverwrites.edit(c.roleId, { ViewChannel: false }).catch(() => {});
    }
  }
  const done = [];
  for (const id of targets) {
    const m = await guild.members.fetch(id).catch(() => null);
    if (m) {
      await m.roles.add(c.roleId, 'Absent au tribunal').catch(() => {});
      done.push(id);
    }
  }
  const t = loadT();
  if (t[voiceId]) {
    t[voiceId].hidden = true;
    t[voiceId].restricted = [...new Set([...t[voiceId].restricted, ...done])];
    saveT(t);
  }
}

// 1 heure : les absents sont expulsés
async function kickAbsent(voiceId) {
  const c = loadT()[voiceId];
  if (!c || c.closed) return;
  const guild = client.guilds.cache.get(c.guildId);
  if (!guild) return;
  for (const id of absentTargets(c)) {
    const m = await guild.members.fetch(id).catch(() => null);
    if (!m) continue;
    if (!m.kickable) {
      console.error(`Tribunal : impossible d'expulser ${m.user.username} (rôle trop haut ?)`);
      continue;
    }
    await m
      .send({ embeds: [embed('err', 'Expulsion', `Tu as été expulsé de **${guild.name}** : tu ne t'es pas présenté à ta convocation au tribunal.`)] })
      .catch(() => {});
    await m.kick('Absent à la convocation du tribunal').catch(console.error);
    await guild.channels.cache
      .get(c.channelId)
      ?.send({ embeds: [embed('err', 'Absence au tribunal', `**${m.user.username}** ne s'est pas présenté et a été expulsé.`)] })
      .catch(() => {});
  }
}

async function summon(i, p, voice) {
  const url = `https://discord.com/channels/${i.guildId}/${voice.id}`;
  const warn = TRIBUNAL_PENALIZED.includes(p.key)
    ? "\n\nTu as **5 minutes** pour rejoindre la salle. Passé ce délai, tu ne verras plus aucun autre vocal. Sans présence au bout d'**1 heure**, tu seras expulsé du serveur."
    : '';
  const e = embed('warn', 'Convocation au tribunal', `Tu es convoqué sur **${i.guild.name}** en tant que **${p.label}**.\n\nRejoins la salle d'audience : ${url}${warn}`);
  try {
    await p.member.send({ embeds: [e] });
  } catch {
    await i.channel.send({ content: `${p.member}`, embeds: [e] }).catch(() => {});
  }
}

async function cmdTribunal(i) {
  if (!isOn(i.guildId, 'tribunal')) {
    return say(i, 'warn', 'Module désactivé', 'Le tribunal est désactivé. Réactive-le avec `/modules`.');
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const defs = [
    ['juge', 'judge', 'Juge'],
    ['avocat', 'lawyer', 'Avocat'],
    ['victime', 'victim', 'Victime'],
    ['temoin', 'witness', 'Témoin'],
  ];
  const people = [];
  for (const [opt, key, label] of defs) {
    const member = i.options.getMember(opt);
    if (!member) {
      if (opt === 'temoin' && !i.options.getUser(opt)) continue;
      return say(i, 'err', 'Membre introuvable', `Le ${label.toLowerCase()} doit être présent sur le serveur.`);
    }
    if (member.user.bot) return say(i, 'err', 'Membre invalide', 'Un bot ne peut pas être convoqué.');
    people.push({ key, label, member });
  }
  const ids = people.map((p) => p.member.id);
  if (new Set(ids).size !== ids.length) {
    return say(i, 'err', 'Doublon', 'Chaque rôle doit être attribué à une personne différente.');
  }

  const guild = i.guild;
  const overwrites = [
    { id: guild.id, deny: [P.ViewChannel] },
    { id: client.user.id, allow: [P.ViewChannel, P.Connect, P.ManageChannels, P.MoveMembers] },
    ...people.map((p) => ({
      id: p.member.id,
      allow: [P.ViewChannel, P.Connect, P.Speak, ...(p.key === 'judge' ? [P.MuteMembers, P.MoveMembers] : [])],
    })),
  ];
  const category = await guild.channels.create({
    name: '━━━  TRIBUNAL  ━━━',
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
  });
  const voice = await guild.channels.create({
    name: "⚖・Salle d'audience",
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: overwrites,
  });
  const role = await guild.roles.create({ name: '⚖️ Convoqué (tribunal)', color: 0x95a5a6, reason: 'Audience du tribunal' });

  const c = {
    guildId: guild.id,
    channelId: i.channelId,
    categoryId: category.id,
    voiceId: voice.id,
    roleId: role.id,
    createdAt: Date.now(),
    judge: people[0].member.id,
    lawyer: people[1].member.id,
    victim: people[2].member.id,
    witness: people[3]?.member.id || null,
    arrived: [],
    restricted: [],
    hidden: false,
    closed: false,
  };
  const t = loadT();
  t[voice.id] = c;
  saveT(t);
  schedule(c);

  for (const p of people) await summon(i, p, voice);

  const list = people.map((p) => `**${p.label} :** ${p.member}`).join('\n');
  await say(i, 'ok', 'Audience ouverte', `${list}\n\nSalle : ${voice}\nLes convoqués ont été prévenus. Utilise \`/tribunal-cloturer\` pour tout fermer.`);
}

async function cmdTribunalClose(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const t = loadT();
  const mine = Object.values(t).filter((x) => x.guildId === i.guildId);
  const c =
    mine.find((x) => i.channelId === x.voiceId || i.channel?.parentId === x.categoryId) ||
    (mine.length === 1 ? mine[0] : null);
  if (!c) {
    return say(i, 'warn', 'Aucune audience', mine.length ? 'Plusieurs audiences sont ouvertes : lance la commande depuis le salon de celle à fermer.' : "Aucune audience n'est ouverte.");
  }
  clearTimers(c.voiceId);
  delete t[c.voiceId];
  saveT(t);
  await say(i, 'ok', 'Audience clôturée', 'Les salons temporaires et le rôle de convocation sont supprimés.');

  const g = i.guild;
  await g.channels.cache.get(c.voiceId)?.delete('Fin du tribunal').catch(() => {});
  await g.channels.cache.get(c.categoryId)?.delete('Fin du tribunal').catch(() => {});
  await g.roles.cache.get(c.roleId)?.delete('Fin du tribunal').catch(() => {});
}

client.on('voiceStateUpdate', async (oldS, newS) => {
  if (!newS.channelId || oldS.channelId === newS.channelId) return;
  const t = loadT();
  const c = t[newS.channelId];
  if (!c || c.closed) return;
  if (!c.arrived.includes(newS.id)) c.arrived.push(newS.id);
  const wasRestricted = c.restricted.includes(newS.id);
  c.restricted = c.restricted.filter((x) => x !== newS.id);
  saveT(t);
  if (wasRestricted) await newS.member?.roles.remove(c.roleId).catch(() => {});
});

// ---------- Routage des commandes ----------
const HANDLERS = {
  accueil: setup('welcome', 'Les messages de bienvenue seront envoyés dans ce salon.', setupWelcome),
  'annonce-boost': setup('boost', 'Les annonces de boost seront envoyées dans ce salon.'),
  'pseudos-rares': setup(
    'tag',
    'Les pseudos rares seront accueillis dans ce salon (rôle automatique + ping).',
    setupTag
  ),
  'messages-perso': cmdMessages,
  verrouiller: cmdLock,
  deverrouiller: cmdUnlock,
  soutien: cmdSupport,
  'classement-boosts': cmdRank,
  'classement-fond': async (i) => {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const lines = [];
    const problems = [];
    await handleBanners(i, 'rank', lines, problems);
    if (!lines.length && !problems.length) lines.push('Ajoute une image avec `banniere`, ou supprime-les avec `vider_bannieres`.');
    await say(i, problems.length ? 'warn' : 'ok', 'Fond du classement', [...lines, ...problems].join('\n'));
  },
  'panneau-roles': cmdPanel,
  'badges-rares': setup('badges', 'Les badges rares seront annoncés dans ce salon.'),
  'anti-pub': cmdAdPub,
  modules: cmdModules,
  tribunal: cmdTribunal,
  'tribunal-cloturer': cmdTribunalClose,
};

client.on('interactionCreate', async (i) => {
  try {
    if (i.isButton()) return await onButton(i);
    if (!i.isChatInputCommand() || !i.guild) return;
    const handler = HANDLERS[i.commandName];
    if (handler) await handler(i);
  } catch (e) {
    console.error(e);
    const payload = { embeds: [embed('err', 'Erreur', "Une erreur est survenue. Vérifie mes permissions et réessaie.")] };
    if (i.deferred || i.replied) await i.editReply(payload).catch(() => {});
    else await i.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ---------- Events ----------
client.once('clientReady', async () => {
  await client.application.commands.set(commands);
  console.log(`Connecté en tant que ${client.user.tag}`);
  console.log('Commandes :', commands.map((c) => '/' + c.name).join(', '));

  // Reprise des audiences en cours après un redémarrage
  for (const c of Object.values(loadT())) if (!c.closed) schedule(c);

  // Vérifications régulières (soutien + rôles Top Boost)
  setInterval(() => {
    const data = load();
    for (const guild of client.guilds.cache.values()) {
      const g = data[guild.id] || {};
      if (g.support || g.adpub || g.badges) scanGuild(guild).catch(() => {});
      if (g.rankOn) refreshRank(guild);
    }
  }, 5 * 60 * 1000);
});

client.on('presenceUpdate', (_old, presence) => {
  if (!presence.member) return;
  syncSupport(presence.member).catch(() => {});
  syncAdPub(presence.member).catch(() => {});
});

// Les nouveaux salons restent invisibles pour les membres isolés
client.on('channelCreate', (ch) => {
  const ad = ch.guild && load()[ch.guild.id]?.adpub;
  if (ad?.roleId && ch.id !== ad.channelId && isOn(ch.guild.id, 'adpub')) {
    ch.permissionOverwrites.edit(ad.roleId, { ViewChannel: false }).catch(() => {});
  }
});

// Nouveau membre
client.on('guildMemberAdd', async (member) => {
  const guild = member.guild;
  const cfg = load()[guild.id] || {};
  const info = classifyName(member.user.username);

  // 1) Rôle automatique de /accueil
  if (cfg.joinRole) {
    await member.roles
      .add(cfg.joinRole, "Rôle automatique à l'arrivée")
      .catch((e) => console.error('Rôle auto impossible :', e.message));
  }

  // 2) Rôle de pseudo rare
  let tagRole = null;
  if (info && isOn(guild.id, 'tag')) {
    try {
      tagRole = await getOrCreateRole(guild, 'tag:' + info.label);
      await member.roles.add(tagRole);
    } catch (e) {
      console.error('Rôle pseudo rare impossible :', e.message);
      tagRole = null;
    }
  }

  // 3) Soutien, badges rares, anti-pub
  syncSupport(member).catch(() => {});
  syncBadges(member, true).catch((e) => console.error('Badges :', e.message));
  syncAdPub(member).catch(() => {});

  // 4) Bienvenue
  try {
    const channel = getChannel(guild, 'welcome');
    if (channel && isOn(guild.id, 'welcome')) {
      const vars = { membre: `${member}`, serveur: guild.name, pseudo: member.displayName };
      const m = getMsg(guild.id, 'welcome');
      await sendCard(channel, member, { title: fmt(m.title, vars), content: fmt(m.text, vars), layout: 'center', type: 'welcome' });
    }
  } catch (e) {
    console.error(e);
  }

  // 5) Carte pseudo rare
  try {
    const tagChannel = getChannel(guild, 'tag');
    if (tagRole && tagChannel && isOn(guild.id, 'tag')) {
      const vars = {
        membre: `${member}`,
        serveur: guild.name,
        pseudo: member.displayName,
        role: `${tagRole}`,
        rolenom: info.label,
      };
      const m = getMsg(guild.id, 'tag');
      await sendCard(tagChannel, member, { title: fmt(m.title, vars), content: fmt(m.text, vars), layout: 'profile', type: 'tag' });
    }
  } catch (e) {
    console.error(e);
  }
});

// Nouveau boost / changement de tag
client.on('guildMemberUpdate', async (oldM, newM) => {
  syncSupport(newM).catch(() => {});

  if (!!oldM.premiumSince !== !!newM.premiumSince && load()[newM.guild.id]?.rankOn) {
    refreshRank(newM.guild);
  }
  if (oldM.premiumSince || !newM.premiumSince) return;
  try {
    const channel = getChannel(newM.guild, 'boost');
    if (!channel || !isOn(newM.guild.id, 'boost')) return;
    const vars = { membre: `${newM}`, serveur: newM.guild.name, pseudo: newM.displayName };
    const m = getMsg(newM.guild.id, 'boost');
    await sendCard(channel, newM, { title: fmt(m.title, vars), content: fmt(m.text, vars), layout: 'center', type: 'boost' });
  } catch (e) {
    console.error(e);
  }
});

client.login(TOKEN);
