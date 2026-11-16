const {
  Client, GatewayIntentBits, Events, SlashCommandBuilder, EmbedBuilder,
  MessageFlags, AttachmentBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const { DatabaseSync } = require('node:sqlite');
const WebSocket = require('ws');

const TOKEN = process.env.DISCORD_TOKEN;
const YOUTUBE_URL = process.env.YOUTUBE_URL || 'https://youtube.com/@TonChaineYouTube';
if (!TOKEN) {
  console.error('❌ Variable DISCORD_TOKEN manquante');
  process.exit(1);
}

const API_V9 = 'https://discord.com/api/v9';
const API_V10 = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

const SUPER_PROPS = Buffer.from(JSON.stringify({
  os: 'Windows',
  browser: 'Discord Client',
  release_channel: 'stable',
  client_version: '1.0.9255',
  os_version: '10.0.19045',
  os_arch: 'x64',
  system_locale: 'fr',
  client_build_number: 382306,
})).toString('base64');

const QUEST_TASKS = ['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE', 'PLAY_ON_DESKTOP', 'PLAY_ACTIVITY'];
const TASK_LABELS = {
  WATCH_VIDEO: 'Vidéo',
  WATCH_VIDEO_ON_MOBILE: 'Vidéo Mobile',
  PLAY_ON_DESKTOP: 'Jeu PC',
  PLAY_ACTIVITY: 'Activité',
};
const STATUS_ICONS = {
  wait: '⏳', enroll: '📝', run: '▶️', done: '🎁', fail: '❌', skip: '🛑', claimed: '✅',
};

const db = new DatabaseSync(process.env.DB_PATH || 'bot_data.db');
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS user_tokens (
    owner_id TEXT NOT NULL,
    token TEXT NOT NULL,
    account_id TEXT,
    username TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, token)
  );
`);

const getOwnerTokens = (ownerId) =>
  db.prepare('SELECT * FROM user_tokens WHERE owner_id = ? ORDER BY added_at ASC').all(ownerId);

function addOwnerToken(ownerId, token, accountId = null, username = 'Inconnu') {
  db.prepare(`
    INSERT INTO user_tokens (owner_id, token, account_id, username, added_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, token) DO UPDATE SET account_id = excluded.account_id, username = excluded.username
  `).run(ownerId, token.trim(), accountId, username, Date.now());
}

const removeOwnerToken = (ownerId, token) =>
  db.prepare('DELETE FROM user_tokens WHERE owner_id = ? AND token = ?').run(ownerId, token);

const clearOwnerTokens = (ownerId) =>
  db.prepare('DELETE FROM user_tokens WHERE owner_id = ?').run(ownerId);

const activeVoiceSessions = new Map();
const activeQuestBatches = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randFloat = (min, max) => Math.random() * (max - min) + min;

function userHeaders(token, fullClient = false) {
  const h = {
    Authorization: token.trim(),
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9255 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36',
  };
  if (fullClient) {
    h['X-Super-Properties'] = SUPER_PROPS;
    h['X-Discord-Locale'] = 'fr';
  }
  return h;
}

async function discordApi(token, method, path, body = null, apiBase = API_V9, fullClient = true) {
  try {
    const opts = { method, headers: userHeaders(token, fullClient) };
    if (body !== null) opts.body = JSON.stringify(body);
    const res = await fetch(`${apiBase}${path}`, opts);
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 429) {
      const wait = data?.retry_after ? Number(data.retry_after) * 1000 : 5000;
      await sleep(Math.min(wait, 15000));
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: {} };
  }
}

async function verifyToken(token) {
  const { status, data } = await discordApi(token, 'GET', '/users/@me', null, API_V10, false);
  if (status === 200 && data?.id) {
    return { valid: true, id: data.id, username: data.username || 'Inconnu' };
  }
  return { valid: false };
}

async function getOrbsBalance(token) {
  const { status, data } = await discordApi(token, 'GET', '/users/@me/virtual-currency/balance', null, API_V9, true);
  if (status !== 200) return null;
  if (typeof data === 'number') return Math.floor(data);
  for (const k of ['balance', 'amount', 'orbs']) {
    if (typeof data?.[k] === 'number') return Math.floor(data[k]);
  }
  return null;
}

const fetchUserGuilds = async (token) => {
  const { status, data } = await discordApi(token, 'GET', '/users/@me/guilds', null, API_V10, false);
  return status === 200 && Array.isArray(data) ? data : [];
};

const fetchGuildChannels = async (token, guildId) => {
  const { status, data } = await discordApi(token, 'GET', `/guilds/${guildId}/channels`, null, API_V10, false);
  return status === 200 && Array.isArray(data) ? data : [];
};

// ======================================================================
// Génération d'image : Solde Discord Orbs (conservée intacte)
// ======================================================================
function generateOrbsBalanceImage(accountsData) {
  const rowHeight = 62;
  const headerH = 210;
  const footerH = 70;
  const rowsCount = Math.max(1, accountsData.length);
  const W = 900;
  const H = headerH + rowsCount * rowHeight + footerH;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#4c1d95');
  bg.addColorStop(0.5, '#3b82f6');
  bg.addColorStop(1, '#1e1b4b');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 32);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 32);
  ctx.clip();

  const glow1 = ctx.createRadialGradient(140, 80, 10, 140, 80, 280);
  glow1.addColorStop(0, 'rgba(168, 85, 247, 0.55)');
  glow1.addColorStop(1, 'rgba(168, 85, 247, 0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, W, H);

  const glow2 = ctx.createRadialGradient(W - 140, H - 80, 10, W - 140, H - 80, 300);
  glow2.addColorStop(0, 'rgba(56, 189, 248, 0.5)');
  glow2.addColorStop(1, 'rgba(56, 189, 248, 0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(10, 12, 28, 0.35)';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(196, 181, 253, 0.45)';
  ctx.beginPath();
  ctx.roundRect(2, 2, W - 4, H - 4, 30);
  ctx.stroke();

  const totalOrbs = accountsData.reduce((acc, a) => acc + (a.orbs || 0), 0);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ddd6fe';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText('🔮 SOLDE TOTAL DISCORD ORBS', W / 2, 55);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 74px sans-serif';
  ctx.shadowColor = 'rgba(139, 92, 246, 0.8)';
  ctx.shadowBlur = 20;
  ctx.fillText(`${totalOrbs.toLocaleString('fr-FR')} ORBS`, W / 2, 135);
  ctx.shadowBlur = 0;

  ctx.fillStyle = 'rgba(224, 242, 254, 0.85)';
  ctx.font = '600 20px sans-serif';
  ctx.fillText(`Détail par compte (${accountsData.length} actif${accountsData.length > 1 ? 's' : ''})`, W / 2, 178);

  let y = headerH;
  for (const acc of accountsData) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.beginPath();
    ctx.roundRect(50, y, W - 100, 48, 14);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = acc.valid ? '#ffffff' : '#fca5a5';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(acc.valid ? `@${acc.username}` : 'Token invalide', 75, y + 31);

    ctx.textAlign = 'right';
    ctx.fillStyle = acc.valid ? '#7dd3fc' : '#f87171';
    ctx.font = 'bold 24px sans-serif';
    const valStr = acc.valid ? `${(acc.orbs ?? 0).toLocaleString('fr-FR')} Orbs` : 'Erreur';
    ctx.fillText(valStr, W - 75, y + 32);

    y += rowHeight;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.font = '600 17px sans-serif';
  ctx.fillText('Kiozi créateur • Système Orbs & Quêtes', W / 2, H - 25);

  return canvas.encode('png');
}

function parseQuest(q) {
  const cfg = q.config || {};
  const tcfg = cfg.task_config_v2 || cfg.taskConfigV2 || cfg.task_config || {};
  const st = q.user_status || {};
  const tasks = tcfg.tasks || {};
  const task = QUEST_TASKS.find((k) => k in tasks) || null;
  const info = task ? tasks[task] : {};
  const apps = info.applications || [{}];
  const expiresAt = cfg.expires_at ? Date.parse(cfg.expires_at) : Infinity;

  return {
    id: q.id,
    name: cfg.messages?.quest_name || q.id,
    task,
    target: Number(info.target || 0),
    appId: apps[0]?.id || null,
    enrolledAt: st.enrolled_at || null,
    value: Number(st.progress?.[task]?.value ?? 0),
    done: Boolean(st.completed_at),
    claimed: Boolean(st.claimed_at),
    expired: expiresAt < Date.now(),
    sealed: q.traffic_metadata_sealed || null,
  };
}

async function fetchUserQuests(token) {
  const { status, data } = await discordApi(token, 'GET', '/quests/@me', null, API_V9, true);
  if (status !== 200) return [];
  const rawList = Array.isArray(data) ? data : (data?.quests || []);
  return rawList.map(parseQuest);
}

async function claimQuestReward(token, quest) {
  const body = { location: 11, is_targeted: false };
  if (quest.sealed) body.traffic_metadata_sealed = quest.sealed;
  const { status, data } = await discordApi(token, 'POST', `/quests/${quest.id}/claim-reward`, body, API_V9, true);
  if (status === 200) return { ok: true, msg: 'Réclamée !' };
  if (data?.captcha_key) return { ok: false, msg: 'Captcha requis (réclame à la main)' };
  return { ok: false, msg: `Refusé (${status})` };
}

async function runVideoQuest(token, job, signal) {
  const enrolledMs = job.enrolledAt ? Date.parse(job.enrolledAt) : Date.now();
  while (job.value < job.target && !signal.aborted) {
    if ((Date.now() - enrolledMs) / 1000 + 10 - job.value >= 7) {
      job.value = Math.min(job.target, job.value + randFloat(7.0, 9.5));
      const { status, data } = await discordApi(
        token, 'POST', `/quests/${job.id}/video-progress`,
        { timestamp: Number(job.value.toFixed(6)) }, API_V9, true
      );
      if (status === 200 && data?.completed_at) return true;
      await sleep(randFloat(7000, 9500));
    } else {
      await sleep(1000);
    }
  }
  if (signal.aborted) return false;
  await discordApi(token, 'POST', `/quests/${job.id}/video-progress`, { timestamp: job.target }, API_V9, true);
  return true;
}

async function runHeartbeatQuest(token, job, baseBody, signal) {
  let fails = 0;
  let stalls = 0;
  while (job.value < job.target && !signal.aborted) {
    const { status, data } = await discordApi(
      token, 'POST', `/quests/${job.id}/heartbeat`,
      { ...baseBody, terminated: false }, API_V9, true
    );
    if (status !== 200) {
      fails += 1;
      job.note = `Heartbeat refusé (${fails}/3)`;
      if (fails >= 3) return false;
    } else {
      fails = 0;
      job.note = '';
      const newVal = Number(data?.progress?.[job.task]?.value ?? job.value);
      stalls = newVal <= job.value ? stalls + 1 : 0;
      job.value = Math.max(job.value, newVal);
      if (data?.completed_at) break;
      if (stalls >= 5) {
        job.note = 'Discord ne crédite pas la progression';
        return false;
      }
    }
    for (let i = 0; i < 60 && !signal.aborted; i++) await sleep(1000);
  }
  if (signal.aborted) return false;
  await discordApi(token, 'POST', `/quests/${job.id}/heartbeat`, { ...baseBody, terminated: true }, API_V9, true);
  return true;
}

async function executeQuestJob(job, signal, logs) {
  const token = job.token;
  try {
    if (!job.enrolledAt) {
      job.status = 'enroll';
      const body = { location: 11, is_targeted: false };
      if (job.sealed) body.traffic_metadata_sealed = job.sealed;
      const { status, data } = await discordApi(token, 'POST', `/quests/${job.id}/enroll`, body, API_V9, true);
      if (status !== 200) {
        job.status = 'fail';
        job.note = `Acceptation refusée (${status})`;
        return;
      }
      job.enrolledAt = data?.enrolled_at || new Date().toISOString();
    }
    if (signal.aborted) { job.status = 'skip'; job.note = 'Arrêtée'; return; }

    job.status = 'run';
    let success = false;
    if (job.task.startsWith('WATCH')) {
      success = await runVideoQuest(token, job, signal);
    } else if (job.task === 'PLAY_ACTIVITY') {
      const { status, data } = await discordApi(token, 'GET', '/users/@me/channels', null, API_V9, true);
      const dm = status === 200 && Array.isArray(data) ? data.find((c) => c.type === 1 || c.type === 3) : null;
      if (!dm || !job.appId) { job.status = 'fail'; job.note = 'Salon MP ou App introuvable'; return; }
      success = await runHeartbeatQuest(token, job, {
        stream_key: `call:${dm.id}:${job.userId}`,
        application_id: job.appId,
      }, signal);
    } else {
      if (!job.appId) { job.status = 'fail'; job.note = 'Application ID introuvable'; return; }
      success = await runHeartbeatQuest(token, job, { application_id: job.appId }, signal);
    }

    if (signal.aborted) { job.status = 'skip'; job.note = 'Arrêtée'; return; }
    if (!success) { job.status = 'fail'; return; }

    job.value = job.target;
    job.status = 'done';
    job.note = 'Réclamation automatique...';
    await sleep(randFloat(3000, 5000));

    const freshList = await fetchUserQuests(token);
    const freshQuest = freshList.find((x) => x.id === job.id) || job;
    const claimRes = await claimQuestReward(token, freshQuest);
    if (claimRes.ok) {
      job.status = 'claimed';
      job.note = '';
      logs.push(`✅ **@${job.username}** : ${job.name.slice(0, 25)} réclamée !`);
    } else {
      job.note = claimRes.msg;
      logs.push(`⚠️ **@${job.username}** : ${job.name.slice(0, 25)} (${claimRes.msg})`);
    }
  } catch (err) {
    job.status = signal.aborted ? 'skip' : 'fail';
    job.note = signal.aborted ? 'Arrêtée' : String(err.message || err).slice(0, 35);
  }
}

function buildQuestDashboardEmbed(batch) {
  const { jobs, logs, stopped, finished } = batch;
  const doneCount = jobs.filter((j) => j.status === 'done' || j.status === 'claimed').length;

  const lines = jobs.slice(0, 15).map((j) => {
    const pct = j.target > 0 ? Math.min(100, Math.floor((j.value / j.target) * 100)) : 0;
    const filled = Math.round((pct / 100) * 12);
    const bar = '█'.repeat(filled) + '░'.repeat(12 - filled);
    const note = j.note ? ` • *${j.note}*` : '';
    return `${STATUS_ICONS[j.status]} **@${j.username}** — **${j.name.slice(0, 24)}** (${TASK_LABELS[j.task] || j.task})\n\`${bar}\` **${pct}%** (${Math.floor(j.value)}/${Math.floor(j.target)}s)${note}`;
  });

  if (jobs.length > 15) lines.push(`\n*...et ${jobs.length - 15} autre(s) quête(s) en cours.*`);
  if (logs.length > 0) lines.push('\n**📜 Journal récent :**\n' + logs.slice(-4).join('\n'));

  let title = `📡 Auto-Quêtes Orbs en Temps Réel (${doneCount}/${jobs.length})`;
  let color = 0x5865f2;
  if (stopped) { title = `🛑 Auto-Quêtes Arrêtées (${doneCount}/${jobs.length})`; color = 0xed4245; }
  else if (finished) { title = `🏁 Auto-Quêtes Terminées (${doneCount}/${jobs.length})`; color = 0x57f287; }

  return new EmbedBuilder().setTitle(title).setDescription(lines.join('\n\n') || 'Aucune quête active.').setColor(color).setTimestamp();
}

class VoiceGatewaySession {
  constructor(token, username, guildId, channelId) {
    this.token = token;
    this.username = username;
    this.guildId = guildId;
    this.channelId = channelId;
    this.selfMute = true;
    this.selfDeaf = false;
    this.ws = null;
    this.hbTimer = null;
    this.stopped = false;
  }

  start() { this.stopped = false; this._connect(); }

  _connect() {
    if (this.stopped) return;
    const ws = new WebSocket(GATEWAY_URL);
    this.ws = ws;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.op === 10 && msg.d?.heartbeat_interval) {
          clearInterval(this.hbTimer);
          this.hbTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: null }));
          }, msg.d.heartbeat_interval);

          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: this.token,
              intents: 0,
              properties: { os: 'linux', browser: 'pydroid', device: 'pydroid' },
            },
          }));
          setTimeout(() => this.sendVoiceState(), 600);
        }
      } catch {}
    });

    ws.on('close', () => {
      clearInterval(this.hbTimer);
      if (!this.stopped) setTimeout(() => this._connect(), 3000);
    });
    ws.on('error', () => {});
  }

  sendVoiceState(mute = this.selfMute, deaf = this.selfDeaf) {
    this.selfMute = mute;
    this.selfDeaf = deaf;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        op: 4,
        d: { guild_id: this.guildId, channel_id: this.channelId, self_mute: this.selfMute, self_deaf: this.selfDeaf },
      }));
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.hbTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ op: 4, d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false } }));
        this.ws.close();
      } catch {}
    }
  }
}

async function connectTokensToVoice(ownerId, tokens, guildId, channelId) {
  let map = activeVoiceSessions.get(ownerId);
  if (!map) { map = new Map(); activeVoiceSessions.set(ownerId, map); }
  const nameByToken = new Map(getOwnerTokens(ownerId).map((r) => [r.token, r.username || 'Compte']));
  for (const t of tokens) {
    if (map.has(t)) map.get(t).stop();
    const sess = new VoiceGatewaySession(t, nameByToken.get(t) || 'Compte', guildId, channelId);
    sess.start();
    map.set(t, sess);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot connecté en tant que ${c.user.tag}`);
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Ouvre le panneau de contrôle'),
    new SlashCommandBuilder().setName('help').setDescription('Affiche l’aide du bot'),
  ];
  await c.application.commands.set(commands);
  console.log('✅ Commandes /panel et /help enregistrées !');
});

function buildMainPanel(ownerId) {
  const tokens = getOwnerTokens(ownerId);
  const voiceCount = activeVoiceSessions.get(ownerId)?.size || 0;
  const questBatch = activeQuestBatches.get(ownerId);
  const questsRunning = questBatch && !questBatch.finished && !questBatch.stopped;

  const emb = new EmbedBuilder()
    .setTitle('🎛️ Panneau de Contrôle')
    .setDescription('Gère tes comptes, ton solde **Discord Orbs**, tes **auto-quêtes** ou ta **gestion vocale**.')
    .setColor(0x5865f2)
    .addFields(
      { name: '🔑 Comptes', value: `**${tokens.length}**`, inline: true },
      { name: '🔊 Vocal actif', value: `**${voiceCount}**`, inline: true },
      { name: '🎁 Auto-Quêtes', value: questsRunning ? '🟢 En cours' : '⚪ Inactif', inline: true },
    )
    .setFooter({ text: 'Kiozi créateur' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nav:tokens').setLabel('Gestion des comptes').setEmoji('🔑').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('nav:orbs_bal').setLabel('Solde Orbs').setEmoji('🔮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav:quests').setLabel('Auto-Quêtes').setEmoji('🎁').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('nav:voice').setLabel('Vocal').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('YouTube').setURL(YOUTUBE_URL).setStyle(ButtonStyle.Link),
  );
  return { embeds: [emb], components: [row1, row2] };
}

function buildTokensPanel(ownerId) {
  const rows = getOwnerTokens(ownerId);
  const desc = rows.length
  
