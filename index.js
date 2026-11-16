const {
  Client, GatewayIntentBits, Events, SlashCommandBuilder,
  EmbedBuilder, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { DatabaseSync } = require('node:sqlite');

// ---------- Config ----------
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('❌ Variable DISCORD_TOKEN manquante');
  process.exit(1);
}

const START_MONEY = 500;
const DAILY = 500;
const DAILY_CD = 24 * 3600 * 1000;
const WORK_CD = 3600 * 1000;
const MIN_BET = 10;
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

// ---------- Base de données ----------
const db = new DatabaseSync(process.env.DB_PATH || 'bank.db');
db.exec('PRAGMA journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  wallet INTEGER NOT NULL DEFAULT ${START_MONEY},
  bank INTEGER NOT NULL DEFAULT 0,
  last_daily INTEGER NOT NULL DEFAULT 0,
  last_work INTEGER NOT NULL DEFAULT 0
)`);

function getUser(id) {
  db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run(id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// Règle une mise : enlève la mise, ajoute le gain total (0 si perdu)
function settle(id, bet, payout) {
  db.prepare('UPDATE users SET wallet = wallet - ? + ? WHERE id = ?').run(bet, payout, id);
  return getUser(id).wallet;
}

// ---------- Helpers ----------
const fmt = (n) => `${Number(n).toLocaleString('fr-FR')} 🪙`;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const embed = (title, desc, color = 0x5865f2) =>
  new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);
const fail = (i, msg) =>
  i.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });

function checkBet(i, bet) {
  const u = getUser(i.user.id);
  if (bet > u.wallet) {
    fail(i, `Tu n'as que ${fmt(u.wallet)} dans ton portefeuille.`);
    return false;
  }
  return true;
}

// ---------- Commandes ----------
const amountOpt = (o) =>
  o.setName('montant').setDescription('Montant').setMinValue(1).setRequired(true);
const betOpt = (o) =>
  o.setName('mise').setDescription(`Ta mise (min ${MIN_BET})`).setMinValue(MIN_BET).setRequired(true);

const commands = [
  new SlashCommandBuilder().setName('balance').setDescription('Voir ton argent')
    .addUserOption((o) => o.setName('membre').setDescription('Un autre membre')),
  new SlashCommandBuilder().setName('daily').setDescription(`Récupère ta récompense quotidienne (${DAILY} 🪙)`),
  new SlashCommandBuilder().setName('work').setDescription('Travaille pour gagner de l\'argent (1x par heure)'),
  new SlashCommandBuilder().setName('deposit').setDescription('Mets de l\'argent à la banque')
    .addIntegerOption(amountOpt),
  new SlashCommandBuilder().setName('withdraw').setDescription('Retire de l\'argent de la banque')
    .addIntegerOption(amountOpt),
  new SlashCommandBuilder().setName('pay').setDescription('Envoie de l\'argent à un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Le destinataire').setRequired(true))
    .addIntegerOption(amountOpt),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Les 10 plus riches'),
  new SlashCommandBuilder().setName('coinflip').setDescription('Pile ou face (x2)')
    .addIntegerOption(betOpt)
    .addStringOption((o) => o.setName('choix').setDescription('Pile ou face').setRequired(true)
      .addChoices({ name: 'Pile', value: 'pile' }, { name: 'Face', value: 'face' })),
  new SlashCommandBuilder().setName('slots').setDescription('Machine à sous')
    .addIntegerOption(betOpt),
  new SlashCommandBuilder().setName('dice').setDescription('Lance un dé contre le bot (x2)')
    .addIntegerOption(betOpt),
  new SlashCommandBuilder().setName('roulette').setDescription('Roulette (rouge/noir x2, vert x14)')
    .addIntegerOption(betOpt)
    .addStringOption((o) => o.setName('couleur').setDescription('Ta couleur').setRequired(true)
      .addChoices(
        { name: '🔴 Rouge', value: 'rouge' },
        { name: '⚫ Noir', value: 'noir' },
        { name: '🟢 Vert', value: 'vert' },
      )),
  new SlashCommandBuilder().setName('admin-give').setDescription('(Admin) Donner de l\'argent à un membre')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
    .addIntegerOption(amountOpt),
];

// ---------- Logique des commandes ----------
const handlers = {
  balance(i) {
    const target = i.options.getUser('membre') ?? i.user;
    if (target.bot) return fail(i, 'Les bots n\'ont pas de compte.');
    const u = getUser(target.id);
    return i.reply({
      embeds: [embed(`💰 Compte de ${target.username}`, '')
        .addFields(
          { name: 'Portefeuille', value: fmt(u.wallet), inline: true },
          { name: 'Banque', value: fmt(u.bank), inline: true },
          { name: 'Total', value: fmt(u.wallet + u.bank), inline: true },
        )],
    });
  },

  daily(i) {
    const u = getUser(i.user.id);
    const now = Date.now();
    if (now - u.last_daily < DAILY_CD) {
      const next = Math.floor((u.last_daily + DAILY_CD) / 1000);
      return fail(i, `Reviens <t:${next}:R> pour ta récompense.`);
    }
    db.prepare('UPDATE users SET wallet = wallet + ?, last_daily = ? WHERE id = ?').run(DAILY, now, i.user.id);
    return i.reply({ embeds: [embed('🎁 Récompense quotidienne', `Tu as reçu **${fmt(DAILY)}** !`, 0x57f287)] });
  },

  work(i) {
    const u = getUser(i.user.id);
    const now = Date.now();
    if (now - u.last_work < WORK_CD) {
      const next = Math.floor((u.last_work + WORK_CD) / 1000);
      return fail(i, `Tu es fatigué, reviens <t:${next}:R>.`);
    }
    const gain = rand(100, 300);
    const job = pick(['livré des pizzas 🍕', 'codé un site 💻', 'tondu une pelouse 🌱', 'réparé un vélo 🚲', 'streamé toute la nuit 🎮']);
    db.prepare('UPDATE users SET wallet = wallet + ?, last_work = ? WHERE id = ?').run(gain, now, i.user.id);
    return i.reply({ embeds: [embed('💼 Travail', `Tu as ${job} et gagné **${fmt(gain)}**.`, 0x57f287)] });
  },

  deposit(i) {
    const m = i.options.getInteger('montant');
    const u = getUser(i.user.id);
    if (m > u.wallet) return fail(i, `Tu n'as que ${fmt(u.wallet)} dans ton portefeuille.`);
    db.prepare('UPDATE users SET wallet = wallet - ?, bank = bank + ? WHERE id = ?').run(m, m, i.user.id);
    return i.reply({ embeds: [embed('🏦 Dépôt', `Tu as déposé **${fmt(m)}** à la banque.`, 0x57f287)] });
  },

  withdraw(i) {
    const m = i.options.getInteger('montant');
    const u = getUser(i.user.id);
    if (m > u.bank) return fail(i, `Tu n'as que ${fmt(u.bank)} à la banque.`);
    db.prepare('UPDATE users SET wallet = wallet + ?, bank = bank - ? WHERE id = ?').run(m, m, i.user.id);
    return i.reply({ embeds: [embed('🏦 Retrait', `Tu as retiré **${fmt(m)}** de la banque.`, 0x57f287)] });
  },

  pay(i) {
    const target = i.options.getUser('membre');
    const m = i.options.getInteger('montant');
    if (target.bot) return fail(i, 'Tu ne peux pas payer un bot.');
    if (target.id === i.user.id) return fail(i, 'Tu ne peux pas te payer toi-même.');
    const u = getUser(i.user.id);
    if (m > u.wallet) return fail(i, `Tu n'as que ${fmt(u.wallet)} dans ton portefeuille.`);
    getUser(target.id);
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE users SET wallet = wallet - ? WHERE id = ?').run(m, i.user.id);
      db.prepare('UPDATE users SET wallet = wallet + ? WHERE id = ?').run(m, target.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return i.reply({ embeds: [embed('💸 Virement', `${i.user} a envoyé **${fmt(m)}** à ${target}.`, 0x57f287)] });
  },

  async leaderboard(i) {
    const rows = db.prepare('SELECT id, wallet + bank AS total FROM users ORDER BY total DESC LIMIT 10').all();
    if (!rows.length) return fail(i, 'Personne n\'a encore de compte.');
    const medals = ['🥇', '🥈', '🥉'];
    const text = rows.map((r, n) => `${medals[n] ?? `**${n + 1}.**`} <@${r.id}> — ${fmt(r.total)}`).join('\n');
    return i.reply({ embeds: [embed('🏆 Classement des plus riches', text, 0xfee75c)] });
  },

  coinflip(i) {
    const bet = i.options.getInteger('mise');
    const choix = i.options.getString('choix');
    if (!checkBet(i, bet)) return;
    const result = Math.random() < 0.5 ? 'pile' : 'face';
    const win = result === choix;
    const wallet = settle(i.user.id, bet, win ? bet * 2 : 0);
    return i.reply({
      embeds: [embed(
        '🪙 Pile ou face',
        `La pièce tombe sur **${result}**.\n${win ? `✅ Tu gagnes **${fmt(bet)}** !` : `❌ Tu perds **${fmt(bet)}**.`}\nPortefeuille : ${fmt(wallet)}`,
        win ? 0x57f287 : 0xed4245,
      )],
    });
  },

  slots(i) {
    const bet = i.options.getInteger('mise');
    if (!checkBet(i, bet)) return;
    const symbols = ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣'];
    const reels = [pick(symbols), pick(symbols), pick(symbols)];
    const unique = new Set(reels).size;
    let mult = 0;
    if (unique === 1) mult = 10;      // 3 identiques
    else if (unique === 2) mult = 1.5; // 2 identiques
    const payout = Math.floor(bet * mult);
    const wallet = settle(i.user.id, bet, payout);
    const diff = payout - bet;
    const msg = diff > 0 ? `✅ Tu gagnes **${fmt(diff)}** !` : diff === 0 ? 'Tu récupères ta mise.' : `❌ Tu perds **${fmt(-diff)}**.`;
    return i.reply({
      embeds: [embed('🎰 Machine à sous', `**[ ${reels.join(' | ')} ]**\n${msg}\nPortefeuille : ${fmt(wallet)}`, diff > 0 ? 0x57f287 : 0xed4245)],
    });
  },

  dice(i) {
    const bet = i.options.getInteger('mise');
    if (!checkBet(i, bet)) return;
    const you = rand(1, 6);
    const bot = rand(1, 6);
    let payout = 0;
    let msg;
    if (you > bot) { payout = bet * 2; msg = `✅ Tu gagnes **${fmt(bet)}** !`; }
    else if (you === bot) { payout = bet; msg = 'Égalité, mise remboursée.'; }
    else msg = `❌ Tu perds **${fmt(bet)}**.`;
    const wallet = settle(i.user.id, bet, payout);
    return i.reply({
      embeds: [embed('🎲 Dé', `Toi : **${you}** — Bot : **${bot}**\n${msg}\nPortefeuille : ${fmt(wallet)}`, you > bot ? 0x57f287 : you === bot ? 0xfee75c : 0xed4245)],
    });
  },

  roulette(i) {
    const bet = i.options.getInteger('mise');
    const choix = i.options.getString('couleur');
    if (!checkBet(i, bet)) return;
    const n = rand(0, 36);
    const color = n === 0 ? 'vert' : RED.has(n) ? 'rouge' : 'noir';
    const emoji = { rouge: '🔴', noir: '⚫', vert: '🟢' }[color];
    const win = color === choix;
    const mult = choix === 'vert' ? 14 : 2;
    const wallet = settle(i.user.id, bet, win ? bet * mult : 0);
    return i.reply({
      embeds: [embed(
        '🎡 Roulette',
        `La bille tombe sur **${n}** ${emoji}\n${win ? `✅ Tu gagnes **${fmt(bet * (mult - 1))}** !` : `❌ Tu perds **${fmt(bet)}**.`}\nPortefeuille : ${fmt(wallet)}`,
        win ? 0x57f287 : 0xed4245,
      )],
    });
  },

  'admin-give'(i) {
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return fail(i, 'Réservé aux administrateurs.');
    }
    const target = i.options.getUser('membre');
    const m = i.options.getInteger('montant');
    if (target.bot) return fail(i, 'Les bots n\'ont pas de compte.');
    getUser(target.id);
    db.prepare('UPDATE users SET wallet = wallet + ? WHERE id = ?').run(m, target.id);
    return i.reply({ embeds: [embed('🛠️ Admin', `${target} a reçu **${fmt(m)}**.`, 0xfee75c)] });
  },
};

// ---------- Client Discord ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(commands.map((cmd) => cmd.toJSON()));
  console.log(`✅ Connecté en tant que ${c.user.tag} — ${commands.length} commandes slash enregistrées`);
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  const handler = handlers[i.commandName];
  if (!handler) return;
  try {
    await handler(i);
  } catch (err) {
    console.error(`Erreur dans /${i.commandName}:`, err);
    const payload = { content: '❌ Une erreur est survenue.', flags: MessageFlags.Ephemeral };
    if (i.replied || i.deferred) await i.followUp(payload).catch(() => {});
    else await i.reply(payload).catch(() => {});
  }
});

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

client.login(TOKEN);
