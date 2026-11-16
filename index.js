const {
  Client, GatewayIntentBits, Events, SlashCommandBuilder, EmbedBuilder,
  PermissionFlagsBits, MessageFlags, AttachmentBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ComponentType,
} = require('discord.js');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { DatabaseSync } = require('node:sqlite');

// ======================================================================
// Config
// ======================================================================
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

const BJ_LIMIT = 21;            // score à ne pas dépasser (mets 30 si tu veux)
const BJ_DEALER_STAND = BJ_LIMIT - 4; // le croupier s'arrête à partir de ce score
const BJ_NATURAL_CHANCE = 1 / 50;     // 1 chance sur 50 de blackjack instantané
const BJ_TIMEOUT = 120_000;

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];

// Police (sur Linux : installe "fonts-dejavu" ou donne FONT_PATH=/chemin/vers/police.ttf)
let FONT = 'sans-serif';
if (process.env.FONT_PATH) {
  GlobalFonts.registerFromPath(process.env.FONT_PATH, 'BotFont');
  FONT = 'BotFont';
}
const font = (weight, size) => `${weight} ${size}px ${FONT}`;

// ======================================================================
// Boutique
// ======================================================================
const ITEMS = {
  // Thèmes de carte
  auto:    { cat: 'theme', name: 'Auto (ta bannière)', free: true },
  sunset:  { cat: 'theme', name: 'Coucher de soleil', price: 2000, colors: ['#ff9966', '#3a1c71'] },
  ocean:   { cat: 'theme', name: 'Océan & Corail', price: 2000, colors: ['#0575e6', '#ff7e5f'] },
  neon:    { cat: 'theme', name: 'Néon', price: 3000, colors: ['#ff00cc', '#00ffa3'] },
  forest:  { cat: 'theme', name: 'Forêt dorée', price: 2500, colors: ['#134e5e', '#f2b134'] },
  galaxy:  { cat: 'theme', name: 'Galaxie', price: 4000, colors: ['#4b0082', '#00e5ff'] },
  // Cadres de photo
  classic: { cat: 'frame', name: 'Classique', free: true, colors: ['#ffffff', '#cfd8e3'] },
  gold:    { cat: 'frame', name: 'Or', price: 3000, colors: ['#f9d423', '#ff8c00'] },
  neonf:   { cat: 'frame', name: 'Néon', price: 2500, colors: ['#00f5ff', '#ff00e5'] },
  fire:    { cat: 'frame', name: 'Feu', price: 4000, colors: ['#ff0000', '#ffd000'] },
  diamond: { cat: 'frame', name: 'Diamant', price: 6000, colors: ['#a1c4fd', '#c2ffd8'] },
  // Titres
  none:      { cat: 'title', name: 'Aucun', free: true },
  t_rich:    { cat: 'title', name: 'Le Riche', price: 2500, text: 'LE RICHE' },
  t_gambler: { cat: 'title', name: 'Parieur fou', price: 3500, text: 'PARIEUR FOU' },
  t_boss:    { cat: 'title', name: 'Le Patron', price: 5000, text: 'LE PATRON' },
  t_legend:  { cat: 'title', name: 'Légende', price: 10000, text: 'LÉGENDE' },
};
const CATS = { theme: '🎨 Thèmes de carte', frame: '⭕ Cadres de photo', title: '🏷️ Titres' };

// ======================================================================
// Base de données
// ======================================================================
const db = new DatabaseSync(process.env.DB_PATH || 'bank.db');
db.exec('PRAGMA journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  wallet INTEGER NOT NULL DEFAULT ${START_MONEY},
  bank INTEGER NOT NULL DEFAULT 0,
  last_daily INTEGER NOT NULL DEFAULT 0,
  last_work INTEGER NOT NULL DEFAULT 0
)`);
// Migration : nouvelles colonnes (ignorées si elles existent déjà)
for (const [col, def] of [['theme', 'auto'], ['frame', 'classic'], ['title', 'none']]) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT NOT NULL DEFAULT '${def}'`); } catch { /* existe déjà */ }
}
db.exec(`CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
)`);

function getUser(id) {
  db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run(id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function addWallet(id, n) {
  db.prepare('UPDATE users SET wallet = wallet + ? WHERE id = ?').run(n, id);
}
// Règle une mise : enlève la mise, ajoute le gain total (0 si perdu)
function settle(id, bet, payout) {
  db.prepare('UPDATE users SET wallet = wallet - ? + ? WHERE id = ?').run(bet, payout, id);
  return getUser(id).wallet;
}
function ownedSet(id) {
  const rows = db.prepare('SELECT item_id FROM inventory WHERE user_id = ?').all(id);
  const s = new Set(rows.map((r) => r.item_id));
  for (const [k, v] of Object.entries(ITEMS)) if (v.free) s.add(k);
  return s;
}

// ======================================================================
// Helpers généraux
// ======================================================================
const fmt = (n) => `${Number(n).toLocaleString('fr-FR')} 🪙`;
const fmtImg = (n) => Number(n).toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const embed = (title, desc, color = 0x5865f2) =>
  new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);
const fail = (i, msg) => i.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
const file = (buf, name) => new AttachmentBuilder(buf, { name });
const png = (canvas) => canvas.encode('png');

function checkBet(i, bet) {
  const u = getUser(i.user.id);
  if (bet > u.wallet) {
    fail(i, `Tu n'as que ${fmt(u.wallet)} dans ton portefeuille.`);
    return false;
  }
  return true;
}

// ======================================================================
// Helpers couleurs
// ======================================================================
const hexToRgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
const rgbToHex = ([r, g, b]) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
// Rend une couleur plus vive / lisible
function vivid(rgb) {
  const [h, s, l] = rgbToHsl(...rgb);
  return rgbToHex(hslToRgb(h, Math.max(s, 0.55), Math.min(0.6, Math.max(0.38, l))));
}
function complement(rgb) {
  const [h, s, l] = rgbToHsl(...rgb);
  return rgbToHex(hslToRgb(h + 180, Math.max(s, 0.55), Math.min(0.6, Math.max(0.38, l))));
}

// Extrait 2 couleurs bien distinctes (opposées si possible) d'une image
function paletteFrom(img) {
  const S = 48;
  const c = createCanvas(S, S);
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, S, S);
  const d = x.getImageData(0, 0, S, S).data;
  const B = 18; // 18 tranches de teinte de 20°
  const buckets = Array.from({ length: B }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let total = 0;
  for (let k = 0; k < d.length; k += 4) {
    const [h, s, l] = rgbToHsl(d[k], d[k + 1], d[k + 2]);
    const w = s * (1 - Math.abs(2 * l - 1));
    if (w < 0.02) continue;
    const bk = buckets[Math.floor(h / 20) % B];
    bk.w += w; bk.r += d[k] * w; bk.g += d[k + 1] * w; bk.b += d[k + 2] * w;
    total += w;
  }
  if (total < S * S * 0.04) return null; // image quasi grise
  const avg = (b) => [b.r / b.w, b.g / b.w, b.b / b.w];
  let top = 0;
  buckets.forEach((b, k) => { if (b.w > buckets[top].w) top = k; });
  const c1 = avg(buckets[top]);
  let best = -1, bestScore = 0;
  buckets.forEach((b, k) => {
    if (!b.w) return;
    const dist = Math.min(Math.abs(k - top), B - Math.abs(k - top));
    if (dist < 3) return;
    const score = b.w * (dist / 9);
    if (b.w > buckets[top].w * 0.08 && score > bestScore) { best = k; bestScore = score; }
  });
  return best >= 0 ? [vivid(c1), vivid(avg(buckets[best]))] : [vivid(c1), complement(c1)];
}

// ======================================================================
// Profil (avatar + couleurs), mis en cache
// ======================================================================
const profileCache = new Map();
const PROFILE_TTL = 10 * 60 * 1000;

async function fetchImg(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await loadImage(Buffer.from(await r.arrayBuffer()));
  } catch { return null; }
}

async function getProfile(user) {
  const hit = profileCache.get(user.id);
  if (hit && Date.now() - hit.at < PROFILE_TTL) return hit;
  let u = user;
  try { u = await user.fetch(true); } catch { /* garde l'objet d'origine */ }
  const avatar = await fetchImg(u.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }));
  const bannerUrl = u.bannerURL({ extension: 'png', size: 512, forceStatic: true });
  const banner = bannerUrl ? await fetchImg(bannerUrl) : null;
  let colors = banner ? paletteFrom(banner) : null;
  if (!colors && u.accentColor) {
    const rgb = [(u.accentColor >> 16) & 255, (u.accentColor >> 8) & 255, u.accentColor & 255];
    colors = [vivid(rgb), complement(rgb)];
  }
  if (!colors && avatar) colors = paletteFrom(avatar);
  if (!colors) colors = ['#5865f2', '#eb459e'];
  const p = { at: Date.now(), avatar, colors, name: u.globalName || u.username };
  profileCache.set(user.id, p);
  return p;
}

// ======================================================================
// Primitives de dessin
// ======================================================================
function resultBar(x, W, y, text, color) {
  x.save();
  x.fillStyle = 'rgba(0,0,0,0.6)';
  x.beginPath(); x.roundRect(40, y, W - 80, 58, 16); x.fill();
  x.lineWidth = 3; x.strokeStyle = color; x.stroke();
  x.fillStyle = color; x.font = font('bold', 30);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, W / 2, y + 30);
  x.restore();
}
const WIN = '#57f287', LOSE = '#ed4245', DRAW = '#fee75c';

function heartPath(x, cx, cy, s) {
  x.beginPath();
  x.moveTo(cx, cy + s * 0.9);
  x.bezierCurveTo(cx - s * 1.3, cy + s * 0.1, cx - s * 0.7, cy - s * 0.9, cx, cy - s * 0.3);
  x.bezierCurveTo(cx + s * 0.7, cy - s * 0.9, cx + s * 1.3, cy + s * 0.1, cx, cy + s * 0.9);
  x.closePath();
}
function drawSuit(x, suit, cx, cy, s, color) {
  x.fillStyle = color;
  if (suit === 'H') { heartPath(x, cx, cy, s); x.fill(); }
  else if (suit === 'D') {
    x.beginPath();
    x.moveTo(cx, cy - s); x.lineTo(cx + s * 0.7, cy); x.lineTo(cx, cy + s); x.lineTo(cx - s * 0.7, cy);
    x.closePath(); x.fill();
  } else if (suit === 'S') {
    x.save(); x.translate(cx, cy); x.scale(1, -1); heartPath(x, 0, 0, s); x.fill(); x.restore();
    x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx - s * 0.3, cy + s); x.lineTo(cx + s * 0.3, cy + s); x.closePath(); x.fill();
  } else {
    const r = s * 0.42;
    for (const [dx, dy] of [[0, -0.45], [-0.5, 0.2], [0.5, 0.2]]) {
      x.beginPath(); x.arc(cx + dx * s, cy + dy * s, r, 0, Math.PI * 2); x.fill();
    }
    x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx - s * 0.3, cy + s); x.lineTo(cx + s * 0.3, cy + s); x.closePath(); x.fill();
  }
}

// ======================================================================
// Image : carte banque / portefeuille
// ======================================================================
async function bankCard(user, u) {
  const p = await getProfile(user);
  const theme = ITEMS[u.theme];
  const [c1, c2] = theme?.colors ?? p.colors;
  const frame = ITEMS[u.frame]?.colors ?? ITEMS.classic.colors;
  const W = 900, H = 420;
  const c = createCanvas(W, H);
  const x = c.getContext('2d');

  // Fond dégradé + petites taches de couleur
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, c1); g.addColorStop(1, c2);
  x.fillStyle = g;
  x.beginPath(); x.roundRect(0, 0, W, H, 36); x.fill();
  x.save();
  x.clip();
  const blobs = [[0.1, 0.9, 260, c2], [0.9, 0.1, 280, c1], [0.55, 0.85, 200, c1], [0.35, 0.05, 180, c2], [0.95, 0.9, 160, c2]];
  for (const [bx, by, br, col] of blobs) {
    const rg = x.createRadialGradient(bx * W, by * H, 0, bx * W, by * H, br);
    rg.addColorStop(0, rgba(col, 0.75)); rg.addColorStop(1, rgba(col, 0));
    x.fillStyle = rg; x.fillRect(0, 0, W, H);
  }
  x.fillStyle = 'rgba(0,0,0,0.22)'; x.fillRect(0, 0, W, H); // assombrit pour la lisibilité
  x.restore();

  // Avatar rond + cercle
  const ax = 50, ay = 40, as = 120;
  const cx = ax + as / 2, cy = ay + as / 2;
  x.save();
  x.beginPath(); x.arc(cx, cy, as / 2, 0, Math.PI * 2); x.clip();
  if (p.avatar) x.drawImage(p.avatar, ax, ay, as, as);
  else { x.fillStyle = '#2b2d31'; x.fillRect(ax, ay, as, as); }
  x.restore();
  const rg = x.createLinearGradient(ax, ay, ax + as, ay + as);
  rg.addColorStop(0, frame[0]); rg.addColorStop(1, frame[1]);
  x.lineWidth = 8; x.strokeStyle = rg;
  x.beginPath(); x.arc(cx, cy, as / 2 + 6, 0, Math.PI * 2); x.stroke();
  x.lineWidth = 2; x.strokeStyle = 'rgba(255,255,255,0.35)';
  x.beginPath(); x.arc(cx, cy, as / 2 + 14, 0, Math.PI * 2); x.stroke();

  // Nom + titre
  x.fillStyle = '#fff'; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
  x.font = font('bold', 40);
  x.fillText(p.name.slice(0, 22), 210, 92);
  const title = ITEMS[u.title]?.text;
  if (title) {
    x.font = font('bold', 20);
    const tw = x.measureText(title).width + 28;
    x.fillStyle = 'rgba(0,0,0,0.35)';
    x.beginPath(); x.roundRect(210, 108, tw, 34, 17); x.fill();
    x.fillStyle = frame[0]; x.fillText(title, 224, 132);
  }

  // Montant total au centre
  const total = fmtImg(u.wallet + u.bank);
  x.textAlign = 'center'; x.fillStyle = 'rgba(255,255,255,0.8)';
  x.font = font('bold', 22); x.fillText('SOLDE TOTAL', W / 2, 225);
  x.font = font('bold', 92);
  const tw = x.measureText(total).width;
  const coinR = 34, gap = 22;
  const startX = W / 2 - (tw + coinR * 2 + gap) / 2;
  // pièce
  const coinX = startX + coinR, coinY = 285;
  const cg = x.createRadialGradient(coinX - 10, coinY - 10, 4, coinX, coinY, coinR);
  cg.addColorStop(0, '#fff3a0'); cg.addColorStop(1, '#e0a100');
  x.fillStyle = cg; x.beginPath(); x.arc(coinX, coinY, coinR, 0, Math.PI * 2); x.fill();
  x.lineWidth = 4; x.strokeStyle = '#b57b00'; x.stroke();
  x.fillStyle = '#b57b00'; x.font = font('bold', 38); x.fillText('$', coinX, coinY + 13);
  // texte
  x.textAlign = 'left'; x.fillStyle = '#fff'; x.font = font('bold', 92);
  x.shadowColor = 'rgba(0,0,0,0.45)'; x.shadowBlur = 14;
  x.fillText(total, startX + coinR * 2 + gap, 318);
  x.shadowBlur = 0;

  // Pastilles portefeuille / banque
  const pill = (px, label, val) => {
    x.fillStyle = 'rgba(0,0,0,0.32)';
    x.beginPath(); x.roundRect(px, 345, 390, 56, 28); x.fill();
    x.textAlign = 'left'; x.fillStyle = 'rgba(255,255,255,0.75)'; x.font = font('bold', 20);
    x.fillText(label, px + 24, 380);
    x.textAlign = 'right'; x.fillStyle = '#fff'; x.font = font('bold', 26);
    x.fillText(fmtImg(val), px + 366, 382);
  };
  pill(50, 'Portefeuille', u.wallet);
  pill(460, 'Banque', u.bank);
  return png(c);
}

// ======================================================================
// Image : pile ou face
// ======================================================================
async function coinImage(result, choix, win) {
  const W = 640, H = 360;
  const c = createCanvas(W, H), x = c.getContext('2d');
  const bg = x.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1e2230'); bg.addColorStop(1, '#2d3350');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  const cx = W / 2, cy = 150, R = 105;
  x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = 25; x.shadowOffsetY = 10;
  const cg = x.createRadialGradient(cx - 30, cy - 30, 10, cx, cy, R);
  cg.addColorStop(0, '#fff3a0'); cg.addColorStop(0.6, '#f2b705'); cg.addColorStop(1, '#c78a00');
  x.fillStyle = cg; x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.fill();
  x.shadowColor = 'transparent';
  x.lineWidth = 8; x.strokeStyle = '#b57b00'; x.stroke();
  x.lineWidth = 3; x.strokeStyle = 'rgba(181,123,0,0.7)';
  x.beginPath(); x.arc(cx, cy, R - 16, 0, Math.PI * 2); x.stroke();
  x.fillStyle = '#8a5d00'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = font('bold', 50); x.fillText(result.toUpperCase(), cx, cy);
  x.font = font('bold', 20); x.fillStyle = 'rgba(255,255,255,0.8)';
  x.fillText(`Ton choix : ${choix.toUpperCase()}`, cx, 285 - 22);
  resultBar(x, W, 285, win ? 'GAGNÉ  x2' : 'PERDU', win ? WIN : LOSE);
  return png(c);
}

// ======================================================================
// Image : dé
// ======================================================================
const PIPS = {
  1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]], 5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
};
function drawDie(x, px, py, s, n, accent) {
  x.save();
  x.shadowColor = 'rgba(0,0,0,0.45)'; x.shadowBlur = 18; x.shadowOffsetY = 8;
  x.fillStyle = '#fafafa'; x.beginPath(); x.roundRect(px, py, s, s, 26); x.fill();
  x.restore();
  x.lineWidth = 4; x.strokeStyle = accent; x.beginPath(); x.roundRect(px, py, s, s, 26); x.stroke();
  x.fillStyle = '#1b1b1f';
  for (const [i, j] of PIPS[n]) {
    x.beginPath(); x.arc(px + s * (0.25 + i * 0.25), py + s * (0.25 + j * 0.25), s * 0.085, 0, Math.PI * 2); x.fill();
  }
}
async function diceImage(you, bot, state) {
  const W = 640, H = 360;
  const c = createCanvas(W, H), x = c.getContext('2d');
  const bg = x.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1e2230'); bg.addColorStop(1, '#2d3350');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  x.fillStyle = '#fff'; x.font = font('bold', 26); x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('TOI', 185, 40); x.fillText('BOT', 455, 40);
  drawDie(x, 110, 70, 150, you, state === 'win' ? WIN : state === 'draw' ? DRAW : LOSE);
  drawDie(x, 380, 70, 150, bot, state === 'lose' ? WIN : state === 'draw' ? DRAW : LOSE);
  resultBar(x, W, 270, state === 'win' ? 'GAGNÉ  x2' : state === 'draw' ? 'ÉGALITÉ — MISE REMBOURSÉE' : 'PERDU',
    state === 'win' ? WIN : state === 'draw' ? DRAW : LOSE);
  return png(c);
}

// ======================================================================
// Image : machine à sous
// ======================================================================
function drawSymbol(x, sym, cx, cy, s) {
  x.save();
  switch (sym) {
    case 'cherry':
      x.strokeStyle = '#2e8b3d'; x.lineWidth = 6;
      x.beginPath(); x.moveTo(cx - s * 0.3, cy + s * 0.15); x.quadraticCurveTo(cx - s * 0.1, cy - s * 0.5, cx + s * 0.2, cy - s * 0.7); x.stroke();
      x.beginPath(); x.moveTo(cx + s * 0.3, cy + s * 0.2); x.quadraticCurveTo(cx + s * 0.3, cy - s * 0.4, cx + s * 0.2, cy - s * 0.7); x.stroke();
      x.fillStyle = '#e0283a';
      x.beginPath(); x.arc(cx - s * 0.3, cy + s * 0.3, s * 0.27, 0, Math.PI * 2); x.fill();
      x.beginPath(); x.arc(cx + s * 0.3, c
