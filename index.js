import asyncio, base64, json, random, time
from datetime import datetime, timezone
import aiohttp
from colorama import Fore, Style, init
init(autoreset=True)
API, CLEAR_SCREEN, CLAIM_AUTO = "https://discord.com/api/v9", True, True
R, G, C, Y, M, W, X = Fore.RED+Style.BRIGHT, Fore.GREEN+Style.BRIGHT, Fore.CYAN+Style.BRIGHT, Fore.YELLOW+Style.BRIGHT, Fore.MAGENTA+Style.BRIGHT, Fore.WHITE+Style.BRIGHT, Style.RESET_ALL
SUPER_PROPS = base64.b64encode(json.dumps({"os":"Windows","browser":"Discord Client","release_channel":"stable","client_version":"1.0.9255","os_version":"10.0.19045","os_arch":"x64","system_locale":"fr","client_build_number":382306}).encode()).decode()
TASKS = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ON_DESKTOP", "PLAY_ACTIVITY"]
LABEL = {"WATCH_VIDEO":"Vidéo","WATCH_VIDEO_ON_MOBILE":"Vidéo","PLAY_ON_DESKTOP":"Jeu","PLAY_ACTIVITY":"Activité"}
ICON = {"wait":"⏳","enroll":"📝","run":"▶️ ","done":"🎁","fail":"❌","skip":"⚠️ ","claimed":"✅"}
END = ("done", "fail", "skip", "claimed")
LOG, ACCOUNTS = [], {"tokens": [], "pseudo": "Toi"}
LETTERS = {"A":[" █████╗ ","██╔══██╗","███████║","██╔══██║","██║  ██║","╚═╝  ╚═╝"],"K":["██╗  ██╗","██║ ██╔╝","█████╔╝ ","██╔═██╗ ","██║  ██╗","╚═╝  ╚═╝"],"D":["██████╗ ","██╔══██╗","██║  ██║","██║  ██║","██████╔╝","╚═════╝ "],"T":["████████╗","╚══██╔══╝","   ██║   ","   ██║   ","   ██║   ","   ╚═╝   "]}
def clear():
    if CLEAR_SCREEN: print("\033[2J\033[H", end="")
def banner(pseudo):
    print()
    for i in range(6): print(C + "".join(LETTERS[c][i] for c in "AKDT"))
    for l, t in zip("AKDT", ["AutoCat", pseudo, "Discord", "Token"]): print(f"{M} {l}{W} = {t}")
    print(f"{C}{'=' * 34}")
async def ask(loop, prompt): return (await loop.run_in_executor(None, input, f"{C}{prompt}{X}")).strip()
class Client:
    def __init__(self, token): self.token, self.user_id, self.username, self.channel = token.strip(), None, "?", None
    def headers(self): return {"Authorization":self.token,"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9255 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36","Content-Type":"application/json","X-Super-Properties":SUPER_PROPS,"X-Discord-Locale":"fr"}
    async def req(self, s, method, path, body=None):
        try:
            async with s.request(method, f"{API}{path}", headers=self.headers(), json=body) as r:
                try: data = await r.json()
                except Exception: data = {}
                if r.status == 429: await asyncio.sleep(5)
                return r.status, data
        except Exception: return 0, {}
    async def post(self, s, path, body):
        st, d = await self.req(s, "POST", path, body)
        return d if st == 200 else None
    async def verify(self, s):
        st, d = await self.req(s, "GET", "/users/@me")
        if st == 200: self.user_id, self.username = d["id"], d.get("username", "?")
        return st == 200
    async def quests(self, s):
        st, d = await self.req(s, "GET", "/quests/@me")
        return (d.get("quests", []) if isinstance(d, dict) else d) if st == 200 else []
    async def balance(self, s):
        st, d = await self.req(s, "GET", "/users/@me/virtual-currency/balance")
        if st != 200: return None
        if isinstance(d, (int, float)): return int(d)
        for k in ("balance", "amount", "orbs"):
            if isinstance(d.get(k), (int, float)): return int(d[k])
        return None
    async def dm_channel(self, s):
        if not self.channel:
            st, d = await self.req(s, "GET", "/users/@me/channels")
            if st == 200 and d: self.channel = next((x["id"] for x in d if x.get("type") in (1, 3)), None)
        return self.channel
    async def claim(self, s, q):
        body = {"location": 11, "is_targeted": False}
        if q.get("sealed"): body["traffic_metadata_sealed"] = q["sealed"]
        st, d = await self.req(s, "POST", f"/quests/{q['id']}/claim-reward", body)
        if st == 200: return True, ""
        if isinstance(d, dict) and d.get("captcha_key"): return False, "captcha requis : réclame à la main"
        return False, f"refusé ({st})"
def parse_quest(q):
    cfg = q.get("config", {})
    tcfg = cfg.get("task_config_v2") or cfg.get("taskConfigV2") or cfg.get("task_config") or {}
    st = q.get("user_status") or {}
    tasks = tcfg.get("tasks", {})
    task = next((k for k in TASKS if k in tasks), None)
    info = tasks.get(task, {})
    apps = info.get("applications") or [{}]
    return {"id":q["id"],"name":(cfg.get("messages") or {}).get("quest_name") or q["id"],"task":task,"target":float(info.get("target",0)),"app_id":apps[0].get("id"),"enrolled_at":st.get("enrolled_at"),"value":float(((st.get("progress") or {}).get(task) or {}).get("value",0)),"done":bool(st.get("completed_at")),"claimed":bool(st.get("claimed_at")),"expired":cfg.get("expires_at","9999")<time.strftime("%Y-%m-%dT%H:%M:%S"),"sealed":q.get("traffic_metadata_sealed")}
def to_ts(s):
    try:
        s = s.split(".")[0].replace("Z", "").split("+")[0]
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    except Exception: return time.time()
async def fetch_accounts(tokens):
    async with aiohttp.ClientSession() as s:
        async def one(t):
            c = Client(t); ok = await c.verify(s)
            return c, ok, (await c.balance(s) if ok else None)
        return await asyncio.gather(*[one(t) for t in tokens])
def show_balances(res):
    total = 0
    for c, ok, b in res:
        if ok: total += b or 0; print(f"  {W}@{c.username}{X}  {M}{'?' if b is None else b} Orbs")
        else: print(f"  {R}[token invalide]")
    if len(res) > 1: print(f"  {W}TOTAL{X}  {M}{total} Orbs")
async def run_video(c, s, j):
    enrolled, cur = to_ts(j["enrolled_at"]), j["value"]
    while cur < j["target"]:
        if time.time() - enrolled + 10 - cur >= 7:
            cur = min(j["target"], cur + random.uniform(7.0, 9.5))
            res = await c.post(s, f"/quests/{j['id']}/video-progress", {"timestamp": round(cur, 6)})
            j["value"] = cur
            if res and res.get("completed_at"): return True
            await asyncio.sleep(random.uniform(7, 9.5))
        else: await asyncio.sleep(1)
    await c.post(s, f"/quests/{j['id']}/video-progress", {"timestamp": j["target"]}); return True
async def run_beats(c, s, j, body):
    fails = stalls = 0
    while j["value"] < j["target"]:
        res = await c.post(s, f"/quests/{j['id']}/heartbeat", body)
        if res is None:
            fails += 1; j["note"] = f"heartbeat refusé ({fails}/3)"
            if fails >= 3: return False
        else:
            fails, j["note"] = 0, ""
            new = float((res.get("progress", {}).get(j["task"]) or {}).get("value", j["value"]))
            stalls = stalls + 1 if new <= j["value"] else 0
            j["value"] = max(j["value"], new)
            if res.get("completed_at"): break
            if stalls >= 5: j["note"] = "Discord ne crédite rien"; return False
        await asyncio.sleep(60)
    body["terminated"] = True; await c.post(s, f"/quests/{j['id']}/heartbeat", body); return True
async def claim_job(j, s):
    c = j["client"]; j["note"] = "réclamation..."
    await asyncio.sleep(random.uniform(3, 6))
    fresh = next((parse_quest(x) for x in await c.quests(s) if x["id"] == j["id"]), j)
    ok, msg = await c.claim(s, fresh)
    j["status"], j["note"] = ("claimed", "") if ok else ("done", msg)
    LOG.append(f"{'✅' if ok else '⚠️'} {j['name'][:22]} {msg or 'réclamée !'}")
async def run_job(j, s, start_at):
    c = j["client"]
    try:
        while start_at > time.time():
            left = start_at - time.time()
            j["status"], j["note"] = "wait", f"départ dans {int(left // 60)}m{int(left % 60):02d}s"
            await asyncio.sleep(min(1.0, left))
        j["note"] = ""
        if not j["enrolled_at"]:
            j["status"] = "enroll"; body = {"location": 11, "is_targeted": False}
            if j["sealed"]: body["traffic_metadata_sealed"] = j["sealed"]
            res = await c.post(s, f"/quests/{j['id']}/enroll", body)
            if res is None: j["status"], j["note"] = "fail", "acceptation refusée"; return
            j["enrolled_at"] = res.get("enrolled_at") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        j["status"] = "run"
        if j["task"].startswith("WATCH"): ok = await run_video(c, s, j)
        elif j["task"] == "PLAY_ACTIVITY":
            chan = await c.dm_channel(s)
            ok = bool(chan and j["app_id"]) and await run_beats(c, s, j, {"stream_key": f"call:{chan}:{c.user_id}", "application_id": j["app_id"], "terminated": False})
        else: ok = bool(j["app_id"]) and await run_beats(c, s, j, {"application_id": j["app_id"], "terminated": False})
        if not ok: j["status"] = "fail"; return
        j["value"], j["status"] = j["target"], "done"
        if CLAIM_AUTO: await claim_job(j, s)
    except asyncio.CancelledError: j["status"], j["note"] = "skip", "arrêtée"; raise
    except Exception as e: j["status"], j["note"] = "fail", str(e)[:28]
def render(jobs, pseudo, multi):
    clear(); banner(pseudo)
    fin = sum(j["status"] in ("done", "claimed") for j in jobs)
    print(f"{W}📡 DIRECT — {fin}/{len(jobs)} terminée(s)")
    print()
    for j in jobs:
        if j["status"] == "claimed": continue
        who = f"@{j['client'].username} " if multi else ""
        p = min(1.0, j["value"] / j["target"]) if j["target"] else 0
        bar = "█" * int(p * 16) + "░" * (16 - int(p * 16))
        print(f"{ICON[j['status']]} {W}{who}{j['name'][:24]}{X} ({LABEL[j['task']]})")
        print(f"   {C}{bar}{X} {int(p * 100)}%  {int(j['value'])}/{int(j['target'])}s")
        if j["note"]: print(f"   {Y}{j['note']}")
    for line in LOG[-4:]: print(line)
async def manage_accounts_button(loop):
    tokens = ACCOUNTS["tokens"]
    print(f"\n{M}--- BOUTON GESTION COMPTES ---\n{X}1. Ajouter\n2. Supprimer\n3. Tout vider\n4. Nettoyer invalides")
    ch = await ask(loop, "Choix ➔ ")
    if ch == "1":
        t = await ask(loop, "Token ➔ ")
        if t: tokens.append(t); print(f"{G}✅ Compte ajouté.")
    elif ch == "2" and tokens:
        for i, (c, ok, _) in enumerate(await fetch_accounts(tokens), 1):
            print(f"[{i}] {G}@{c.username}" if ok else f"[{i}] {R}[Token invalide]")
        n = await ask(loop, "Numéro ➔ ")
        if n.isdigit() and 1 <= int(n) <= len(tokens): tokens.pop(int(n) - 1); print(f"{G}🗑️ Compte retiré.")
    elif ch == "3": tokens.clear(); print(f"{G}🗑️ Tous les comptes retirés.")
    elif ch == "4":
        res = await fetch_accounts(tokens)
        ACCOUNTS["tokens"] = [t for t, (_, ok, _) in zip(tokens, res) if ok]
        print(f"{G}🧹 {len(ACCOUNTS['tokens'])} compte(s) valide(s).")
async def main():
    loop = asyncio.get_running_loop()
    while True:
        tokens, pseudo = ACCOUNTS["tokens"], ACCOUNTS["pseudo"]
        clear(); banner(pseudo)
        print(f"{Y}💰 Soldes des comptes :")
        show_balances(await fetch_accounts(tokens) if tokens else [])
        print(f"\n  {C}1.{X} Lancer quêtes\n  {C}2.{X} Réclamer quêtes finies\n  {C}3.{X} [Bouton] Gestion des comptes\n  {R}0.{X} Quitter")
        ch = await ask(loop, "\nChoix ➔ ")
        if ch == "1" and tokens:
            async with aiohttp.ClientSession() as s:
                jobs = [dict(q, client=c, status="wait", note="") for t in tokens if (c := Client(t)) and await c.verify(s) for q in (parse_quest(x) for x in await c.quests(s)) if not q["done"] and not q["expired"] and q["task"]]
                if jobs:
                    workers = [asyncio.create_task(run_job(j, s, time.time())) for j in jobs]
                    while not all(j["status"] in END for j in jobs):
                        render(jobs, pseudo, len(tokens) > 1); await asyncio.sleep(3)
                    await asyncio.gather(*workers, return_exceptions=True)
                    await ask(loop, "\nEntrée pour continuer ➔ ")
        elif ch == "2" and tokens:
            async with aiohttp.ClientSession() as s:
                for t in tokens:
                    c = Client(t)
                    if await c.verify(s):
                        for q in (parse_quest(x) for x in await c.quests(s)):
                            if q["done"] and not q["claimed"]: await c.claim(s, q)
            await ask(loop, "\nEntrée pour continuer ➔ ")
        elif ch == "3":
            await manage_accounts_button(loop); await ask(loop, "\nEntrée pour continuer ➔ ")
        elif ch == "0": break
if __name__ == "__main__": asyncio.run(main())
      
