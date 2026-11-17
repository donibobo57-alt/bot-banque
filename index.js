const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require("discord.js");
const { DatabaseSync } = require("node:sqlite");
const { createCanvas } = require("@napi-rs/canvas");
const WebSocket = require("ws");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const CLIENT_ID = process.env.CLIENT_ID || "";
const YOUTUBE_URL = process.env.YOUTUBE_URL || "https://www.youtube.com/@Kiozi";

const API = "https://discord.com/api/v9";
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

const TASKS = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ON_DESKTOP", "PLAY_ACTIVITY"];
const LABEL = {
  WATCH_VIDEO: "Vidéo",
  WATCH_VIDEO_ON_MOBILE: "Vidéo",
  PLAY_ON_DESKTOP: "Jeu",
  PLAY_ACTIVITY: "Activité",
};
const ICON = {
  wait: "⏳",
  enroll: "📝",
  run: "▶️",
  done: "🎁",
  fail: "❌",
  skip: "⚠️",
  claimed: "✅",
};
const END_STATUSES = new Set(["done", "fail", "skip", "claimed"]);

const db = new DatabaseSync("auto_quete.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    username TEXT,
    token TEXT NOT NULL UNIQUE
  );
`);

const activeSessions = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function getAllAccounts() {
  return db.prepare("SELECT id, user_id, username, token FROM accounts ORDER BY id ASC").all();
}

function addAccountRecord(userId, username, token) {
  db.prepare(
    `INSERT INTO accounts (user_id, username, token)
     VALUES (?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, username = excluded.username`
  ).run(userId, username, token);
}

function deleteAccountById(id) {
  db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
}

function clearAllAccounts() {
  db.prepare("DELETE FROM accounts").run();
}

class UserQuestClient {
  constructor(token, storedId = null, storedName = "?") {
    this.token = token.trim();
    this.userId = storedId;
    this.username = storedName || "?";
    this.channel = null;
  }

  headers() {
    return {
      Authorization: this.token,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) discord/1.0.9255 Chrome/128.0.6613.186 " +
        "Electron/32.2.7 Safari/537.36",
      "Content-Type": "application/json",
      "X-Super-Properties": SUPER_PROPS,
      "X-Discord-Locale": "fr",
    };
  }

  async req(method, path, body = null) {
    try {
      const opts = { method, headers: this.headers() };
      if (body !== null && body !== undefined) {
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(`${API}${path}`, opts);
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (res.status === 429) {
        await sleep(5000);
      }
      return [res.status, data];
    } catch {
      return [0, {}];
    }
  }

  async post(path, body) {
    const [st, d] = await this.req("POST", path, body);
    return st === 200 ? d : null;
  }

  async verify() {
    const [st, d] = await this.req("GET", "/users/@me");
    if (st === 200 && d && d.id) {
      this.userId = String(d.id);
      this.username = d.username || "?";
      return true;
    }
    return false;
  }

  async quests() {
    const [st, d] = await this.req("GET", "/quests/@me");
    if (st !== 200) return [];
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.quests)) return d.quests;
    return [];
  }

  async balance() {
    const [st, d] = await this.req("GET", "/users/@me/virtual-currency/balance");
    if (st !== 200) return null;
    if (typeof d === "number") return Math.trunc(d);
    if (d && typeof d === "object") {
      for (const k of ["balance", "amount", "orbs"]) {
        if (typeof d[k] === "number") return Math.trunc(d[k]);
      }
    }
    return null;
  }

  async dmChannel() {
    if (!this.channel) {
      const [st, d] = await this.req("GET", "/users/@me/channels");
      if (st === 200 && Array.isArray(d)) {
        const found = d.find((x) => x && (x.type === 1 || x.type === 3));
        this.channel = found ? found.id : null;
      }
    }
    return this.channel;
  }

  async claim(q) {
    const body = { location: 11, is_targeted: false };
    if (q.sealed) {
      body.traffic_metadata_sealed = q.sealed;
    }
    const [st, d] = await this.req("POST", `/quests/${q.id}/claim-reward`, body);
    if (st === 200) {
      return [true, ""];
    }
    if (d && typeof d === "object" && d.captcha_key) {
      return [false, "captcha requis : réclame à la main"];
    }
    return [false, `refusé (${st})`];
  }
}

function parseQuest(q) {
  const cfg = q.config || {};
  const tcfg = cfg.task_config_v2 || cfg.taskConfigV2 || cfg.task_config || {};
  const st = q.user_status || {};
  const tasks = tcfg.tasks || {};
  const task = TASKS.find((k) => Object.prototype.hasOwnProperty.call(tasks, k)) || null;
  const info = task ? tasks[task] || {} : {};
  const apps = Array.isArray(info.applications) && info.applications.length ? info.applications : [{}];
  const progress = st.progress || {};
  const taskProg = task ? progress[task] || {} : {};
  const expiresAt = cfg.expires_at || "9999";
  const nowIso = new Date().toISOString().slice(0, 19);

  return {
    id: q.id,
    name: ((cfg.messages && cfg.messages.quest_name) || q.id),
    task,
    target: Number(info.target || 0),
    app_id: apps[0].id || null,
    enrolled_at: st.enrolled_at || null,
    value: Number(taskProg.value || 0),
    done: Boolean(st.completed_at),
    claimed: Boolean(st.claimed_at),
    expired: expiresAt < nowIso,
    sealed: q.traffic_metadata_sealed || null,
  };
}

function toTs(s) {
  try {
    const clean = String(s).split(".")[0].replace("Z", "").split("+")[0];
    const [datePart, timePart = "00:00:00"] = clean.split("T");
    const [y, m, d] = datePart.split("-").map(Number);
    const [hh, mm, ss] = timePart.split(":").map(Number);
    return Date.UTC(y, m - 1, d, hh, mm, ss) / 1000;
  } catch {
    return Date.now() / 1000;
  }
}

async function fetchAccountsData(rows) {
  return Promise.all(
    rows.map(async (row) => {
      const client = new UserQuestClient(row.token, row.user_id, row.username);
      const ok = await client.verify();
      if (ok) {
        addAccountRecord(client.userId, client.username, client.token);
      }
      const bal = ok ? await client.balance() : null;
      return { row, client, ok, bal };
    })
  );
}

async function generateOrbsBalanceImage(results) {
  const width = 900;
  const rowHeight = 58;
  const headerHeight = 190;
  const footerHeight = 70;
  const height = headerHeight + Math.max(1, results.length) * rowHeight + footerHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#1a0b2e");
  bg.addColorStop(0.5, "#2b1055");
  bg.addColorStop(1, "#0f2c59");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createLinearGradient(0, 0, width, 0);
  glow.addColorStop(0, "#7b2cbf");
  glow.addColorStop(1, "#3a86ff");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, 8);

  let total = 0;
  for (const r of results) {
    if (r.ok && typeof r.bal === "number") {
      total += r.bal;
    }
  }

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 34px Sans";
  ctx.fillText("Solde Orbs — Comptes Discord", 44, 66);

  ctx.fillStyle = "#c77dff";
  ctx.font = "bold 42px Sans";
  ctx.fillText(`Total : ${total.toLocaleString("fr-FR")} Orbs`, 44, 128);

  ctx.fillStyle = "#90e0ef";
  ctx.font = "20px Sans";
  ctx.fillText(`Comptes vérifiés : ${results.filter((r) => r.ok).length} / ${results.length}`, 44, 164);

  results.forEach((item, idx) => {
    const y = headerHeight + idx * rowHeight;
    ctx.fillStyle = idx % 2 === 0 ? "rgba(255, 255, 255, 0.07)" : "rgba(255, 255, 255, 0.03)";
    ctx.fillRect(36, y, width - 72, rowHeight - 8);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 22px Sans";
    const label = item.ok ? `@${item.client.username}` : `[Token invalide #${item.row.id}]`;
    ctx.fillText(label, 56, y + 34);

    ctx.fillStyle = item.ok ? "#72efdd" : "#ff6b6b";
    ctx.font = "bold 22px Sans";
    const rightText = item.ok ? `${item.bal === null ? "?" : item.bal.toLocaleString("fr-FR")} Orbs` : "Invalide";
    const metrics = ctx.measureText(rightText);
    ctx.fillText(rightText, width - 56 - metrics.width, y + 34);
  });

  ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
  ctx.font = "18px Sans";
  ctx.fillText("Kiozi créateur", 44, height - 26);

  return canvas.toBuffer("image/png");
}

async function runVideo(client, job, signal) {
  const enrolled = toTs(job.enrolled_at);
  let cur = job.value;
  while (cur < job.target) {
    if (signal.aborted) return false;
    const now = Date.now() / 1000;
    if (now - enrolled + 10 - cur >= 7) {
      cur = Math.min(job.target, cur + randRange(7.0, 9.5));
      const res = await client.post(`/quests/${job.id}/video-progress`, {
        timestamp: Number(cur.toFixed(6)),
      });
      job.value = cur;
      if (res && res.completed_at) {
        return true;
      }
      await sleep(randRange(7000, 9500));
    } else {
      await sleep(1000);
    }
  }
  await client.post(`/quests/${job.id}/video-progress`, { timestamp: job.target });
  return true;
}

async function runBeats(client, job, body, signal) {
  let fails = 0;
  let stalls = 0;
  while (job.value < job.target) {
    if (signal.aborted) return false;
    const res = await client.post(`/quests/${job.id}/heartbeat`, body);
    if (res === null) {
      fails += 1;
      job.note = `heartbeat refusé (${fails}/3)`;
      if (fails >= 3) {
        return false;
      }
    } else {
      fails = 0;
      job.note = "";
      const prog = (res.progress && res.progress[job.task]) || {};
      const nextVal = Number(prog.value !== undefined ? prog.value : job.value);
      stalls = nextVal <= job.value ? stalls + 1 : 0;
      job.value = Math.max(job.value, nextVal);
      if (res.completed_at) {
        break;
      }
      if (stalls >= 5) {
        job.note = "Discord ne crédite rien";
        return false;
      }
    }
    for (let i = 0; i < 60; i++) {
      if (signal.aborted) return false;
      await sleep(1000);
    }
  }
  const endBody = { ...body, terminated: true };
  await client.post(`/quests/${job.id}/heartbeat`, endBody);
  return true;
}

async function runPlay(client, job, signal) {
  if (!job.app_id) {
    job.note = "application_id introuvable";
    return false;
  }
  return runBeats(client, job, { application_id: job.app_id, terminated: false }, signal);
}

async function runActivity(client, job, signal) {
  const chan = await client.dmChannel();
  if (!chan || !job.app_id) {
    job.note = "salon ou application introuvable";
    return false;
  }
  const body = {
    stream_key: `call:${chan}:${client.userId}`,
    application_id: job.app_id,
    terminated: false,
  };
  return runBeats(client, job, body, signal);
}

async function claimJob(job) {
  const client = job.client;
  job.note = "réclamation...";
  await sleep(randRange(3000, 6000));
  const rawQuests = await client.quests();
  const found = rawQuests.find((x) => x.id === job.id);
  const fresh = found ? parseQuest(found) : job;
  const [ok, msg] = await client.claim(fresh);
  if (ok) {
    job.status = "claimed";
    job.note = "";
    job.log = `✅ ${String(job.name).slice(0, 22)} réclamée !`;
  } else {
    job.status = "done";
    job.note = msg;
    job.log = `⚠️ ${String(job.name).slice(0, 22)} : ${msg}`;
  }
}

async function runJob(job, signal) {
  const client = job.client;
  try {
    if (signal.aborted) {
      job.status = "skip";
      job.note = "arrêtée";
      return;
    }
    job.note = "";
    if (!job.enrolled_at) {
      job.status = "enroll";
      const body = { location: 11, is_targeted: false };
      if (job.sealed) {
        body.traffic_metadata_sealed = job.sealed;
      }
      const res = await client.post(`/quests/${job.id}/enroll`, body);
      if (res === null) {
        job.status = "fail";
        job.note = "acceptation refusée";
        return;
      }
      job.enrolled_at = res.enrolled_at || new Date().toISOString();
    }
    job.status = "run";
    let ok = false;
    if (job.task && job.task.startsWith("WATCH")) {
      ok = await runVideo(client, job, signal);
    } else if (job.task === "PLAY_ACTIVITY") {
      ok = await runActivity(client, job, signal);
    } else {
      ok = await runPlay(client, job, signal);
    }
    if (!ok) {
      job.status = signal.aborted ? "skip" : "fail";
      if (signal.aborted) job.note = "arrêtée";
      return;
    }
    job.value = job.target;
    job.status = "done";
    if (CLAIM_AUTO) {
      await claimJob(job);
    } else {
      job.note = "à réclamer";
    }
  } catch (err) {
    if (signal.aborted) {
      job.status = "skip";
      job.note = "arrêtée";
    } else {
      job.status = "fail";
      job.note = String(err && err.message ? err.message : err).slice(0, 28);
    }
  }
}

function buildQuestProgressEmbed(session) {
  const fin = session.jobs.filter((j) => j.status === "done" || j.status === "claimed").length;
  const lines = session.jobs.map((j) => {
    const who = session.multi ? `@${j.client.username} ` : "";
    const pct = j.target ? Math.min(1, j.value / j.target) : 0;
    const filled = Math.floor(pct * 16);
    const bar = "█".repeat(filled) + "░".repeat(16 - filled);
    const notePart = j.note ? `\n   ↳ *${j.note}*` : "";
    return `${ICON[j.status] || "•"} **${who}${String(j.name).slice(0, 24)}** (${LABEL[j.task] || j.task})\n   \`${bar}\` ${Math.floor(pct * 100)}% (${Math.floor(j.value)}/${Math.floor(j.target)}s)${notePart}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`📡 Auto-Quête — ${fin}/${session.jobs.length} terminée(s)`)
    .setColor(session.stopped ? 0xe74c3c : 0x5865f2)
    .setDescription(lines.join("\n").slice(0, 4000) || "Aucune quête en cours.")
    .setFooter({ text: session.stopped ? "Arrêté par l'utilisateur • Kiozi créateur" : "Mise à jour en temps réel • Kiozi créateur" });

  return embed;
}

function buildStopRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("quest_stop")
      .setLabel("Arrêter les quêtes")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setTitle("📖 Aide — Bot Auto-Quête Discord")
    .setColor(0x7b2cbf)
    .setDescription(`🎬 **Chaîne YouTube :** ${YOUTUBE_URL}`)
    .addFields(
      {
        name: "1️⃣ Tutoriel applications & récupération de token",
        value: [
          "**Applications externes à installer (via Google) :** `PhantomMail` (`Phantom Hub`), `Clone Hub` et `Bluecord APK`.",
          "⚠️ *Précision importante : ces trois applications ne m'appartiennent pas, ce sont des applications externes.*",
          "1. Génère une adresse email jetable avec **PhantomMail** (*c'est une adresse email jetable : il n'y aura pas de mot de passe d'accès à cette boîte email*).",
          "2. Ouvre **Clone Hub**, clone **Discord**, crée un nouveau compte Discord avec cet email et **retiens bien le mot de passe créé**.",
          "3. Clone **Bluecord** dans **Clone Hub**, puis connecte-toi avec les identifiants du nouveau compte cloné.",
          "4. Ouvre les **Paramètres Bluecord**, prends la **3ème option en partant du bas**, copie le token, puis ajoute-le dans **Gestion des comptes** du `/panel`.",
          "5. **Compte principal :** pour récupérer le token de ton propre compte principal, mets simplement ton email et ton mot de passe sur l'application **Bluecord**.",
        ].join("\n"),
      },
      {
        name: "2️⃣ Gestion des comptes",
        value:
          "Dans `/panel` → **Gestion des comptes**, tu peux ajouter un compte (vérifié via `/users/@me` avec enregistrement de l'ID et du pseudo), supprimer un token précis, nettoyer les tokens invalides ou tout supprimer.",
      },
      {
        name: "3️⃣ Solde Orbs",
        value:
          "Dans `/panel` → **Solde Orbs**, le bot vérifie chaque compte enregistré, récupère son solde (`/users/@me/virtual-currency/balance`) et génère une image dégradée violet/bleu avec le total et le détail par compte.",
      },
      {
        name: "4️⃣ Gestion Auto-Quête",
        value:
          "Dans `/panel` → **Gestion Auto-Quête**, choisis un compte précis ou tous les comptes, lance les quêtes Orbs (`WATCH_VIDEO`, `WATCH_VIDEO_ON_MOBILE`, `PLAY_ON_DESKTOP`, `PLAY_ACTIVITY`) en mode toutes quêtes (acceptation auto) ou uniquement déjà acceptées, suis l'avancement en temps réel et utilise le bouton rouge pour arrêter à tout moment.",
      },
      {
        name: "5️⃣ Gestion Vocale",
        value:
          "Système Bluecord : le compte doit **déjà avoir rejoint le serveur** avant de rejoindre en vocal, avec un fonctionnement façon Pydroid 3 / Gateway.",
      }
    )
    .setFooter({ text: "Kiozi créateur" });
}

function buildMainPanelEmbed(accountsCount) {
  return new EmbedBuilder()
    .setTitle("🎛️ Panneau de contrôle — Auto-Quête")
    .setColor(0x3a86ff)
    .setDescription(
      [
        `Comptes enregistrés : **${accountsCount}** (minimum 1 requis pour lancer les modules).`,
        "Sélectionne une action ci-dessous :",
      ].join("\n")
    )
    .setFooter({ text: "Kiozi créateur" });
}

function buildMainPanelRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel_accounts").setLabel("Gestion des comptes").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel_orbs").setLabel("Solde Orbs").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_quests").setLabel("Gestion Auto-Quête").setStyle(ButtonStyle.Success)
  );
  return [row1];
}

function buildAccountsEmbed(accounts) {
  const list =
    accounts.length === 0
      ? "Aucun compte enregistré."
      : accounts.map((a) => `• **#${a.id}** — @${a.username || "?"} (\`${a.user_id || "?"}\`)`).join("\n");
  return new EmbedBuilder()
    .setTitle("👤 Gestion des comptes (Tokens)")
    .setColor(0x5865f2)
    .setDescription(list)
    .setFooter({ text: "Kiozi créateur" });
}

function buildAccountsRows(accounts) {
  const rows = [];
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("acc_add").setLabel("Ajouter un compte").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("acc_clean").setLabel("Nettoyer les invalides").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("acc_delete_all").setLabel("Tout supprimer").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("panel_back").setLabel("Retour").setStyle(ButtonStyle.Secondary)
    )
  );

  if (accounts.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("acc_delete_one")
      .setPlaceholder("Supprimer un token précis...")
      .addOptions(
        accounts.slice(0, 25).map((a) => ({
          label: `#${a.id} — @${a.username || "?"}`.slice(0, 100),
          description: `ID: ${a.user_id || "inconnu"}`.slice(0, 100),
          value: String(a.id),
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(menu));
  }

    return rows;                                                                                                                                                                 }
