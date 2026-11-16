const {
  Client, GatewayIntentBits, Événements, SlashCommandBuilder, EmbedBuilder,
  Indicateurs de message, constructeur de pièces jointes, constructeur de lignes d'action, constructeur de boutons,
  Style de bouton, constructeur de menu de sélection de chaîne, constructeur de modale, constructeur de saisie de texte,
  TextInputStyle,
} = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const { DatabaseSync } = require('node:sqlite');
const WebSocket = require('ws');

// ======================================================================
// CONFIGURATION
// ======================================================================
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
  os : 'Windows',
  navigateur : « Client Discord »,
  release_channel: 'stable',
  client_version: '1.0.9255',
  os_version: '10.0.19045',
  os_arch: 'x64',
  system_locale: 'fr',
  numéro_de_build_client : 382306,
})).toString('base64');

const QUEST_TASKS = ['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE', 'PLAY_ON_DESKTOP', 'PLAY_ACTIVITY'];
const TASK_LABELS = {
  WATCH_VIDEO : 'Vidéo',
  REGARDER_LA_VIDÉO_SUR_MOBILE : 'Vidéo Mobile',
  PLAY_ON_DESKTOP : 'Jeu PC',
  PLAY_ACTIVITY : 'Activité',
};
const STATUS_ICONS = {
  attendre : '⏳',
  s'inscrire : '📝',
  exécuter : '▶️',
  fait : '🎁',
  échec : '❌',
  ignorer : '🛑',
  revendiqué : '✅',
};

// ======================================================================
// BASE DE DONNEES SQLITE (PROPRE & SÉCURISÉE)
// ======================================================================
const db = new DatabaseSync(process.env.DB_PATH || 'bot_data.db');
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CRÉER LA TABLE IF NOT EXISTS user_tokens (
    owner_id TEXT NON NULL,
    jeton TEXTE NON NUL,
    account_id TEXTE,
    Nom d'utilisateur TEXTE,
    ajouté_à INTEGER NOT NULL,
    CLÉ PRIMAIRE (owner_id, token)
  );
  CRÉER LA TABLE SI ELLE N'EXISTE PAS saved_entities (
    owner_id TEXT NON NULL,
    catégorie TEXTE NON NUL,
    entity_id TEXT NOT NULL,
    nom TEXTE NON NUL,
    CLÉ PRIMAIRE (owner_id, category, entity_id)
  );
`);

fonction getOwnerTokens(ownerId) {
  return db.prepare('SELECT * FROM user_tokens WHERE owner_id = ? ORDER BY added_at ASC').all(ownerId);
}
fonction addOwnerToken(ownerId, token, accountId = null, username = 'Inconnu') {
  db.prepare(`
    INSERT INTO user_tokens (owner_id, token, account_id, username, added_at)
    VALEURS (?, ?, ?, ?, ?)
    EN CAS DE CONFLIT (owner_id, token) FAIRE UNE MISE À JOUR : account_id = excluded.account_id, username = excluded.username
  `).run(ownerId, token.trim(), accountId, username, Date.now());
}
fonction supprimerTokenPropriétaire(ownerId, token) {
  db.prepare('DELETE FROM user_tokens WHERE owner_id = ? AND token = ?').run(ownerId, token);
}
fonction clearOwnerTokens(ownerId) {
  db.prepare('DELETE FROM user_tokens WHERE owner_id = ?').run(ownerId);
}
fonction saveEntity(ownerId, category, entityId, name) {
  db.prepare(`
    INSÉRER DANS saved_entities (owner_id, category, entity_id, name)
    VALEURS (?, ?, ?, ?)
    EN CAS DE CONFLIT (owner_id, category, entity_id) METTRE À JOUR SET name = excluded.name
  `).run(ownerId, category, entityId, name);
}
fonction getEntities(ownerId, category) {
  return db.prepare('SELECT * FROM saved_entities WHERE owner_id = ? AND category = ?').all(ownerId, category);
}

// ======================================================================
// ÉTATS ACTIFS EN MÉMOIRE (VOCAL, TRACKER, AUTO-QUÊTES)
// ======================================================================
const activeVoiceSessions = new Map(); // ownerId -> Map<token, VoiceSession>
const activeTrackers = new Map(); // ownerId -> TrackerSession
const activeQuestBatches = new Map(); // ownerId -> QuestBatch

// ======================================================================
// AIDE DISCORD API & UTILITAIRES
// ======================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randFloat = (min, max) => Math.random() * (max - min) + min;
const parseDiscordId = (str) => {
  const m = String(str || '').trim().match(/\d{17,20}/);
  retourner m ? m[0] : String(str || '').trim();
};

fonction userHeaders(token, client complet = false) {
  const h = {
    Autorisation : token.trim(),
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9255 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36',
  };
  if (fullClient) {
    h['X-Super-Properties'] = SUPER_PROPS;
    h['X-Discord-Locale'] = 'fr';
  }
  retourner h;
}

fonction asynchrone discordApi(token, méthode, chemin, corps = null, apiBase = API_V9, client_complet = vrai) {
  essayer {
    const opts = { méthode, en-têtes: userHeaders(jeton, clientcomplet) };
    si (corps !== null) opts.corps = JSON.stringify(corps);
    const res = await fetch(`${apiBase}${path}`, opts);
    soit data = {};
    try { data = await res.json(); } catch {}
    si (res.status === 429) {
      const wait = (data?.retry_after ? Number(data.retry_after) * 1000 : 5000);
      await sleep(Math.min(wait, 15000));
    }
    renvoie { statut: res.statut, données };
  } catch {
    renvoie { statut: 0, données: {} };
  }
}

fonction asynchrone verifyToken(token) {
  const { status, data } = await discordApi(token, 'GET', '/users/@me', null, API_V10, false);
  si (statut === 200 && données?.id) {
    return { valid: true, id: data.id, username: data.username || 'Inconnu', globalName: data.global_name || data.username };
  }
  retourner { valide : faux };
}

fonction asynchrone getOrbsBalance(token) {
  const { status, data } = await discordApi(token, 'GET', '/users/@me/virtual-currency/balance', null, API_V9, true);
  si (statut !== 200) retourner null ;
  si (typeof data === 'number') retourner Math.floor(data);
  pour (const k de ['balance', 'amount', 'orbs']) {
    si (typeof data?.[k] === 'number') retourner Math.floor(data[k]);
  }
  retourner null ;
}

fonction asynchrone fetchUserGuilds(token) {
  const { status, data } = await discordApi(token, 'GET', '/users/@me/guilds', null, API_V10, false);
  état de retour === 200 && Array.isArray(data) ? données : [];
}

fonction asynchrone fetchGuildChannels(token, guildId) {
  const { status, data } = await discordApi(token, 'GET', `/guilds/${guildId}/channels`, null, API_V10, false);
  état de retour === 200 && Array.isArray(data) ? données : [];
}

fonction asynchrone fetchGuildName(token, guildId) {
  const { status, data } = await discordApi(token, 'GET', `/guilds/${guildId}`, null, API_V10, false);
  return status === 200 && data?.name ? data.name : `Serveur_${guildId.slice(0, 6)}`;
}

// ======================================================================
// IMAGE TOILE : SOLDE D'ORBS (DÉGRADÉ VIOLET / BLEU)
// ======================================================================
fonction generateOrbsBalanceImage(accountsData) {
  const rowHeight = 62;
  const headerH = 210;
  const footerH = 70;
  const rowsCount = Math.max(1, accountsData.length);
  const W = 900;
  const H = headerH + rowsCount * rowHeight + footerH;

  const canvas = créerCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Dégradé principal Violet -> Bleu profond
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#4c1d95'); // Violet profond
  bg.addColorStop(0.5, '#3b82f6'); // Bleu électrique
  bg.addColorStop(1, '#1e1b4b'); // Nuit indigo
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(0, 0, L, H, 32);
  ctx.fill();

  // Halo lumineux décoratifs
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, L, H, 32);
  ctx.clip();

  const glow1 = ctx.createRadialGradient(140, 80, 10, 140, 80, 280);
  glow1.addColorStop(0, 'rgba(168, 85, 247, 0.55)');
  glow1.addColorStop(1, 'rgba(168, 85, 247, 0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, L, H);

  const glow2 = ctx.createRadialGradient(W - 140, H - 80, 10, W - 140, H - 80, 300);
  glow2.addColorStop(0, 'rgba(56, 189, 248, 0.5)');
  glow2.addColorStop(1, 'rgba(56, 189, 248, 0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, L, H);

  ctx.fillStyle = 'rgba(10, 12, 28, 0.35)';
  ctx.fillRect(0, 0, L, H);
  ctx.restore();

  // Bordure subtile
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(196, 181, 253, 0.45)';
  ctx.beginPath();
  ctx.roundRect(2, 2, L - 4, H - 4, 30);
  ctx.stroke();

  // Calcul du solde total
  const totalOrbs = accountsData.reduce((acc, a) => acc + (a.orbs || 0), 0);

  // En-tête
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ddd6fe';
  ctx.font = 'gras 22px sans-serif';
  ctx.fillText('🔮 VENDU TOTAL D'ORBES DISCORD', W / 2, 55);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'gras 74px sans-serif';
  ctx.shadowColor = 'rgba(139, 92, 246, 0.8)';
  ctx.shadowBlur = 20 ;
  ctx.fillText(`${totalOrbs.toLocaleString('fr-FR')} ORBS`, W / 2, 135);
  ctx.shadowBlur = 0;

  ctx.fillStyle = 'rgba(224, 242, 254, 0.85)';
  ctx.font = '600 20px sans-serif';
  ctx.fillText(`Détail par compte (${accountsData.length} actif${accountsData.length > 1 ? 's' : ''})`, W / 2, 178);

  // Liste des comptes
  soit y = headerH;
  pour (const acc de accountsData) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.beginPath();
    ctx.roundRect(50, y, W - 100, 48, 14);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = acc.valid ? '#ffffff' : '#fca5a5';
    ctx.font = 'gras 22px sans-serif';
    ctx.fillText(acc.valid ? `@${acc.username}` : 'Jeton invalide', 75, y + 31);

    ctx.textAlign = 'right';
    ctx.fillStyle = acc.valid ? '#7dd3fc' : '#f87171';
    ctx.font = 'gras 24px sans-serif';
    const valStr = acc.valid ? `${(acc.orbs ?? 0).toLocaleString('fr-FR')} Orbs` : 'Erreur';
    ctx.fillText(valStr, W - 75, y + 32);

    y += hauteur_de_ligne;
  }

  // Pied de page
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.font = '600 17px sans-serif';
  ctx.fillText('Kiozi Self-Panel • Système Orbs & Quêtes Automatiques', W/2, H - 25);

  return canvas.encode('png');
}

// ======================================================================
// MOTEUR 1 : AUTO-QUÊTES ORBS (TEMPS RÉEL + STOP BOUTON ROUGE)
// ======================================================================
fonction parseQuest(q) {
  const cfg = q.config || {};
  const tcfg = cfg.task_config_v2 || cfg.taskConfigV2 || cfg.task_config || {};
  const st = q.user_status || {};
  const tâches = tcfg.tâches || {};
  const tâche = QUEST_TASKS.find((k) => k dans tâches) || null;
  const info = tâche ? tâches[tâche] : {};
  const applications = info.applications || [{}];
  const progressVal = st.progress?.[task]?.value ?? 0;
  const expiresAt = cfg.expires_at ? Date.parse(cfg.expires_at) : Infinity;

  retourner {
    id: q.id,
    nom : cfg.messages?.quest_name || q.id,
    tâche,
    cible : Nombre(info.target || 0),
    appId : apps[0]?.id || null,
    inscritÀ : st.enrolled_at || null,
    valeur : Nombre(progressVal),
    terminé : booléen(st.completed_at),
    revendiqué : booléen(st.claimed_at),
    expiré : expire à < Date.now(),
    scellé : q.traffic_metadata_sealed || null,
  };
}

fonction asynchrone fetchUserQuests(token) {
  const { status, data } = await discordApi(token, 'GET', '/quests/@me', null, API_V9, true);
  si (statut !== 200) retourner [];
  const rawList = Array.isArray(data) ? data : (data?.quests || []);
  return rawList.map(parseQuest);
}

fonction asynchrone claimQuestReward(token, quest) {
  const corps = { emplacement: 11, est_ciblé: faux };
  si (quest.sealed) body.traffic_metadata_sealed = quest.sealed;
  const { status, data } = await discordApi(token, 'POST', `/quests/${quest.id}/claim-reward`, body, API_V9, true);
  if (status === 200) return { ok : true, msg : 'Réclamée !' } ;
  if (data?.captcha_key) return { ok: false, msg: 'Captcha requis (réclame à la main)' };
  return { ok : false, msg : `Refusé (${status})` };
}

fonction asynchrone runVideoQuest(token, job, signal) {
  const registeredMs = job.enrolledAt ? Date.parse(job.enrolledAt) : Date.now();
  tant que (job.value < job.target && !signal.aborted) {
    const elapsedSec = (Date.now() - registeredMs) / 1000;
    si (elapsedSec + 10 - job.value >= 7) {
      job.value = Math.min(job.target, job.value + randFloat(7.0, 9.5));
      const { statut, données } = await discordApi(
        jeton,
        'POST',
        `/quests/${job.id}/video-progress`,
        { timestamp: Number(job.value.toFixed(6)) },
        API_V9,
        vrai
      );
      si (statut === 200 && données?.completed_at) retourner vrai ;
      await sleep(randFloat(7000, 9500));
    } else {
      await sleep(1000);
    }
  }
  si (signal.aborted) retourner faux ;
  await discordApi(token, 'POST', `/quests/${job.id}/video-progress`, { timestamp: job.target }, API_V9, true);
  renvoie vrai ;
}

fonction asynchrone runHeartbeatQuest(token, job, baseBody, signal) {
  soit fails = 0 ;
  soit stalls = 0 ;

  tant que (job.value < job.target && !signal.aborted) {
    const { statut, données } = await discordApi(
      jeton,
      'POST',
      `/quests/${job.id}/heartbeat`,
      { ...baseBody, terminé : faux },
      API_V9,
      vrai
    );
    si (statut !== 200) {
      fails += 1 ;
      job.note = `Heartbeat refusé (${fails}/3)`;
      si (échecs >= 3) retourner faux ;
    } else {
      échecs = 0 ;
      job.note = '';
      const newVal = Number(data?.progress?.[job.task]?.value ?? job.value);
      stalles = nouvelleVal <= job.value ? stalles + 1 : 0;
      valeur de l'emploi = Math.max(valeur de l'emploi, nouvelleVal);
      if (data?.completed_at) break;
      si (stands >= 5) {
        job.note = 'Discord ne crédite pas la progression';
        retourner faux ;
      }
    }
    pour (soit i = 0 ; i < 60 && !signal.aborted ; i++) {
      await sleep(1000);
    }
  }

  si (signal.aborted) retourner faux ;
  await discordApi(
    jeton,
    'POST',
    `/quests/${job.id}/heartbeat`,
    { ...baseBody, terminé : vrai },
    API_V9,
    vrai
  );
  renvoie vrai ;
}

fonction asynchrone executeQuestJob(job, signal, logs) {
  const token = job.token;
  essayer {
    if (!job.enrolledAt) {
      job.status = 'enroll';
      const corps = { emplacement: 11, est_ciblé: faux };
      si (job.sealed) body.traffic_metadata_sealed = job.sealed;
      const { status, data } = await discordApi(token, 'POST', `/quests/${job.id}/enroll`, body, API_V9, true);
      si (statut !== 200) {
        job.status = 'fail';
        job.note = `Acceptation refusée (${status})`;
        retour;
      }
      job.enrolledAt = data?.enrolled_at || new Date().toISOString();
    }

    if (signal.aborted) {
      job.status = 'skip';
      job.note = 'Arrêtée';
      retour;
    }

    job.status = 'run';
    soit success = faux ;

    if (job.task.startsWith('WATCH')) {
      succès = attendre runVideoQuest(jeton, tâche, signal);
    } sinon si (job.task === 'PLAY_ACTIVITY') {
      const { status, data } = await discordApi(token, 'GET', '/users/@me/channels', null, API_V9, true);
      const dm = status === 200 && Array.isArray(data) ? data.find((c) => c.type === 1 || c.type === 3) : null;
      si (!dm || !job.appId) {
        job.status = 'fail';
        job.note = 'Salon MP ou App introuvable';
        retour;
      }
      succès = attendre runHeartbeatQuest(jeton, tâche, {
        stream_key: `call:${dm.id}:${job.userId}`,
        application_id : job.appId,
      }, signal);
    } else {
      if (!job.appId) {
        job.status = 'fail';
        job.note = 'ID d'application introuvable';
        retour;
      }
      succès = await runHeartbeatQuest(token, job, { application_id: job.appId }, signal);
    }

    if (signal.aborted) {
      job.status = 'skip';
      job.note = 'Arrêtée';
      retour;
    }

    if (!success) {
      job.status = 'fail';
      retour;
    }

    job.value = job.target;
    job.status = 'terminé';
    job.note = 'Réclamation automatique...';
    await sleep(randFloat(3000, 5000));

    const freshList = await fetchUserQuests(token);
    const freshQuest = freshList.find((x) => x.id === job.id) || job;
    const claimRes = await claimQuestReward(token, freshQuest);
    si (claimRes.ok) {
      job.status = 'revendiqué';
      job.note = '';
      logs.push(`✅ **@${job.username}** : ${job.name.slice(0, 25)} réclamée !`);
    } else {
      job.note = claimRes.msg;
      logs.push(`⚠️ **@${job.username}** : ${job.name.slice(0, 25)} (${claimRes.msg})`);
    }
  } attraper (erreur) {
    job.status = signal.aborted ? 'skip' : 'fail';
    job.note = signal.aborted ? 'Arrêtée' : String(err.message || err).slice(0, 35);
  }
}

function buildQuestDashboardEmbed(batch) {
  const { tâches, journaux, arrêté, terminé } = lot;
  const doneCount = jobs.filter((j) => j.status === 'done' || j.status === 'claimed').length;

  const lignes = jobs.slice(0, 15).map((j) => {
    const pct = j.target > 0 ? Math.min(100, Math.floor((j.value / j.target) * 100)) : 0;
    const filled = Math.round((pct / 100) * 12);
    const bar = '█'.repeat(filled) + '░'.repeat(12 - filled);
    const note = j.note ? ` • *${j.note}*` : '';
    return `${STATUS_ICONS[j.status]} **@${j.username}** — **${j.name.slice(0, 24)}** (${TASK_LABELS[j.task] || j.task})\n\`${bar}\` **${pct}%** (${Math.floor(j.value)}/${Math.floor(j.target)}s)${note}`;
  });

  si (jobs.length > 15) {
    lines.push(`\n*...et ${jobs.length - 15} autre(s) quête(s) en cours.*`);
  }

  si (logs.length > 0) {
    lignes.push('\n**📜 Journal récent :**\n' + logs.slice(-4).join('\n'));
  }

  let title = `📡 Auto-Quêtes Orbs en Temps Réel (${doneCount}/${jobs.length})`;
  soit couleur = 0x5865f2 ;
  si (arrêté) {
    title = `🛑 Auto-Quêtes Arrêtées (${doneCount}/${jobs.length})`;
    couleur = 0xed4245;
  } sinon si (terminé) {
    title = `🏁 Auto-Quêtes Terminées (${doneCount}/${jobs.length})`;
    couleur = 0x57f287;
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join('\n\n') || 'Quête Aucune active.')
    .setColor(color)
    .setTimestamp();
}

// ======================================================================
// MOTEUR 2 : GESTION VOCALE (GATEWAY MULTI-COMPTES, MUTE, SOURD, CONGÉ)
// ======================================================================
class VoiceGatewaySession {
  constructeur (jeton, nom d'utilisateur, guildId, channelId) {
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

  start() {
    this.stopped = false;
    this._connect();
  }

  _connect() {
    if (this.stopped) return;
    const ws = new WebSocket(GATEWAY_URL);
    this.ws = ws;

    ws.on('message', (raw) => {
      essayer {
        const msg = JSON.parse(raw.toString());
        si (msg.op === 10 && msg.d?.heartbeat_interval) {
          clearInterval(this.hbTimer);
          this.hbTimer = setInterval(() => {
            si (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ op: 1, d: null }));
            }
          }, msg.d.heartbeat_interval);

          ws.send(JSON.stringify({
            op: 2,
            d: {
              jeton : this.token,
              intentions : 0,
              propriétés : { os : 'linux', browser : 'pydroid', device : 'pydroid' },
            },
          }));

          setTimeout(() => this.sendVoiceState(), 600);
}
      
