// npm i discord.js @napi-rs/canvas
// Place ton image de fond à côté de ce fichier sous le nom banner.png
// Active "Server Members Intent" dans le portail développeur Discord.

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
} = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');

// Le token est lu dans un fichier .env (jamais dans le code)
try {
  process.loadEnvFile();
} catch {}
const TOKEN = (process.env.TOKEN || '').trim();
if (!TOKEN) {
  console.error('Token manquant : crée un fichier .env avec la ligne TOKEN=ton_token');
  process.exit(1);
}
const CONFIG_FILE = './config.json';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Sauvegarde des salons : un seul salon par type et par serveur
const load = () =>
  fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE)) : {};
const save = (data) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));

const commands = [
  new SlashCommandBuilder()
    .setName('join-membre')
    .setDescription('Définit ce salon pour les messages de bienvenue')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('join-boost')
    .setDescription('Définit ce salon pour les messages de boost')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

// Génération de la bannière avec la photo de profil au centre
async function makeBanner(user) {
  const W = 1280;
  const H = 720;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(await loadImage('./banner.png'), 0, 0, W, H);

  const avatar = await loadImage(user.displayAvatarURL({ extension: 'png', size: 512 }));
  const x = W / 2;
  const y = H / 2;
  const r = 130;

  ctx.beginPath();
  ctx.arc(x, y, r + 10, 0, Math.PI * 2);
  ctx.fillStyle = '#000000';
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(avatar, x - r, y - r, r * 2, r * 2);
  ctx.restore();

  return new AttachmentBuilder(await canvas.encode('png'), { name: 'banner.png' });
}

async function send(guild, type, member, content) {
  const channelId = load()[guild.id]?.[type];
  const channel = channelId && guild.channels.cache.get(channelId);
  if (!channel) return;
  const files = [await makeBanner(member.user)];
  channel.send({ content, files }).catch(console.error);
}

client.once('clientReady', async () => {
  await client.application.commands.set(commands);
  console.log(`Connecté en tant que ${client.user.tag}`);
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  const type = i.commandName === 'join-membre' ? 'welcome' : 'boost';
  const data = load();
  data[i.guildId] = { ...data[i.guildId], [type]: i.channelId };
  save(data);
  await i.reply({
    content:
      type === 'welcome'
        ? 'Les messages de bienvenue seront envoyés dans ce salon.'
        : 'Les messages de boost seront envoyés dans ce salon.',
    ephemeral: true,
  });
});

// Nouveau membre
client.on('guildMemberAdd', (member) => {
  send(
    member.guild,
    'welcome',
    member,
    `Bienvenue ${member} sur **${member.guild.name}**. Nous sommes ravis de t'accueillir parmi nous.`
  );
});

// Nouveau boost
client.on('guildMemberUpdate', (oldM, newM) => {
  if (!oldM.premiumSince && newM.premiumSince) {
    send(
      newM.guild,
      'boost',
      newM,
      `Merci ${newM} d'avoir boosté **${newM.guild.name}**. Ton soutien compte énormément pour nous.`
    );
  }
});

client.login(TOKEN);
