#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["curl_cffi>=0.7", "yt-dlp"]
# ///
"""dj-fetch: get DJ-ready tracks from a track list.

For each track: look up the release on Beatport to learn the target version and
length (extended mix, else original, else the only release), skip it if it's
already in a library folder, take SoundCloud-native tracks from the uploader's
free download, and otherwise search Soulseek through slskd, rank every file it
returns, and download from the best peers until a copy of the right length
arrives. State lives in <library_root>/<list>/_state/state.sqlite, so a run can
be stopped and resumed.
"""
import argparse, csv, hashlib, json, os, re, shutil, sqlite3, subprocess, sys, threading, time, tomllib, unicodedata, urllib.error, urllib.parse, urllib.request, uuid
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
PREFS = tomllib.loads((SKILL_DIR / "preferences.toml").read_text())
CONFIG_PATH = Path(os.environ.get("DJ_FETCH_CONFIG", "~/.config/dj-fetch/config.toml")).expanduser()
PACE_DB = Path("~/.local/share/dj-fetch/pace.sqlite").expanduser()
AUDIO_EXTS = {"mp3", "m4a", "aac", "flac", "wav", "aiff", "aif", "alac", "ogg", "opus"}
TERMINAL = ("done", "have", "review", "missing", "gate")
ACTIVE = ("pending", "sc", "search", "searching", "transfer")

STOP = {"the", "a", "an", "and", "of", "feat", "ft", "featuring", "with", "vs", "x"}
VERSION_WORDS = re.compile(r"\b(remix|bootleg|mashup|edit|flip|vip|remake|rework|refix|dub|mix|version|rerub|redrum|cover|extended|acapella|acappella|instrumental)\b", re.I)
VERSION_SET = {"extended", "remix", "bootleg", "mashup", "edit", "flip", "vip", "remake", "rework", "refix", "dub", "mix", "version", "rerub", "redrum", "cover"}
GENERIC_MIX = {"extended", "original", "mix", "club", "main", "version", "full", "length", "radio", "edit", "remix", "vocal"}
TRAILING_FEAT = re.compile(r"\s+(?:feat\.?|ft\.?|featuring)\s+.*$", re.I)
FEAT = re.compile(r"\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^\)\]]*[\)\]]", re.I)
ARTIST_SPLIT = re.compile(r"\s*(?:,|&|\+|\bx\b|\bvs\.?|\bfeat\.?|\bft\.?|\bfeaturing\b|\band\b|\bwith\b)\s*", re.I)


# ---------------------------------------------------------------- text

def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = s.replace("'", "").replace("’", "")
    s = re.sub(r"(?<![a-z])(?:[a-z]\.){2,}", lambda m: m.group().replace(".", ""), s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def tokens(s):
    s = re.sub(r"\S*\*\S*", " ", s or "")  # censored words ("F*re") can't be matched
    return [t for t in norm(s).split() if t not in STOP and (len(t) > 1 or t.isdigit())]


def tokset(s):
    return set(norm(s).split())


def has_phrase(normed, phrase):
    return re.search(r"(?<![a-z0-9])" + re.escape(norm(phrase)) + r"(?![a-z0-9])", normed) is not None


class Request:
    """A requested track, split into the parts matching needs."""

    def __init__(self, artist, title):
        self.artist, self.title = artist.strip(), title.strip()
        t = FEAT.sub(" ", self.title)
        labels, core = [], t
        for m in re.finditer(r"[\(\[]([^\(\)\[\]]*)[\)\]]", t):
            if VERSION_WORDS.search(m.group(1)):
                labels.append(m.group(1))
                core = core.replace(m.group(0), " ")
            else:
                core = core.replace(m.group(0), " " + m.group(1) + " ")
        dash = re.match(r"(.*?)\s+-\s+(.*\b(?:remix|mix|edit|bootleg|flip|vip|rework|version)\b.*)$", core, re.I)
        if dash:
            core, labels = dash.group(1), labels + [dash.group(2)]
        self.label = " ".join(labels)
        self.core = " ".join(core.split())
        self.core_tokens = tokens(self.core)
        label_norm = norm(self.label)
        self.kind = next((w for w in ("mashup", "bootleg", "flip", "rework", "remake", "refix", "vip", "dub", "edit", "remix") if has_phrase(label_norm, w)), "")
        self.remixer_tokens = [t for t in tokens(self.label) if t not in GENERIC_MIX and t not in VERSION_SET]
        self.label_words = set(label_norm.split())
        self.artists = [a for a in ARTIST_SPLIT.split(self.artist) if tokens(a)]
        self.primary = self.artists[0] if self.artists else self.artist

    @property
    def wants_named_version(self):
        return bool(self.remixer_tokens) or self.kind in ("mashup", "bootleg", "flip", "rework", "remake", "refix", "vip", "dub")

    def queries(self):
        a, c, r = " ".join(tokens(self.primary)), " ".join(self.core_tokens), " ".join(self.remixer_tokens)
        distinctive = len(self.core_tokens) >= 2 and len(c) >= 8
        out = [f"{a} {c} {r}"]
        if r:
            out.append(f"{c} {r}")
        elif distinctive:
            out.append(c)
        for other in self.artists[1:3]:
            out.append(f"{' '.join(tokens(other))} {c} {r}")
        if r and distinctive:
            out.append(c)
        seen, res = set(), []
        for qy in out:
            qy = " ".join(qy.split())
            if qy and qy not in seen:
                seen.add(qy)
                res.append(qy)
        return res


def track_id(artist, title):
    return hashlib.sha1(f"{norm(artist)}|{norm(title)}".encode()).hexdigest()[:12]


def safe_name(s):
    return re.sub(r"[/:\\\0]", "-", s).strip().rstrip(".")[:180]


# ---------------------------------------------------------------- config

def load_config():
    if not CONFIG_PATH.exists():
        sys.exit(f"Missing {CONFIG_PATH}. Run scripts/setup_slskd.py first.")
    cfg = tomllib.loads(CONFIG_PATH.read_text())
    cfg["library_root"] = Path(cfg["library_root"]).expanduser()
    cfg["have_dirs"] = [Path(p).expanduser() for p in cfg.get("have_dirs", [])]
    return cfg


# ---------------------------------------------------------------- matching

def file_basename(path):
    return re.split(r"[\\/]", path)[-1]


def evaluate(req, f, target_len, peer=None):
    """Judge one Soulseek file for a request. Returns (ok, score, notes)."""
    prefs_f, prefs_v = PREFS["formats"], PREFS["versions"]
    path = f.get("filename", "")
    base = file_basename(path)
    stem, _, ext = base.rpartition(".")
    ext = (f.get("extension") or ext).lower().lstrip(".")
    notes, score = [], 0.0
    if ext not in prefs_f["order"]:
        return False, 0, [f"format {ext or '?'} not accepted"]
    lossless = ext in prefs_f["lossless"]
    br = f.get("bitRate")
    if not br and f.get("size") and f.get("length"):
        br = int(f["size"] * 8 / f["length"] / 1000)  # peers often omit bitrate; size/length is close enough
    if not lossless:
        if br and br < prefs_f["min_lossy_kbps"]:
            return False, 0, [f"{br} kbps"]
        if not br and "320" not in path:
            return False, 0, ["lossy with unknown bitrate"]
    full_norm, name_norm = norm(path), norm(stem)
    for m in prefs_v["rip_markers"]:
        if has_phrase(full_norm, m):
            return False, 0, [f"looks like a rip ({m})"]
    full_set, name_set = set(full_norm.split()), set(name_norm.split())
    if not any(all(t in full_set for t in tokens(a)) for a in req.artists):
        return False, 0, ["artist not in path"]
    if not all(t in name_set for t in req.core_tokens):
        return False, 0, ["title not in filename"]
    if req.remixer_tokens and not all(t in name_set for t in req.remixer_tokens):
        return False, 0, ["requested version not in filename"]
    extra = name_set - set(req.core_tokens) - set(req.remixer_tokens) - set(norm(req.artist).split())
    for m in prefs_v["unrequested_markers"]:
        if has_phrase(name_norm, m) and not has_phrase(norm(req.label), m) and not has_phrase(norm(req.core), m):
            if m == "edit" and has_phrase(name_norm, "extended edit"):
                continue
            return False, 0, [f"different version ({m})"]
    if not req.wants_named_version and re.search(r"[\(\[][^\)\]]*\b(?:remix|bootleg|edit|flip|mashup)\b", stem, re.I):
        return False, 0, ["different version (named remix/edit)"]
    length = f.get("length")
    if target_len:
        if length:
            d = abs(length - target_len)
            if d <= prefs_v["length_tolerance_seconds"]:
                score += 1000
            elif d <= prefs_v["review_tolerance_seconds"]:
                score += 200
                notes.append(f"length off by {d:.0f}s")
            else:
                return False, 0, [f"length {length}s vs target {target_len:.0f}s"]
        else:
            notes.append("length unknown; checked after download")
    else:
        if length and length < 120:
            return False, 0, [f"too short ({length}s)"]
        if length:
            score += min(length, 600) / 6
        if "extended" in name_set:
            score += 100
    if "extended" in name_set:
        score += 40
    elif "original" in name_set:
        score += 15
    order = prefs_f["order"]
    score += (len(order) - order.index(ext)) * 25
    if br and not lossless:
        score += min(br, 320) / 32
    if peer:
        if peer.get("hasFreeUploadSlot"):
            score += 60
        score -= min(peer.get("queueLength") or 0, 50) * 2
        score += min((peer.get("uploadSpeed") or 0) / 1_000_000 * 5, 30)
    if extra - GENERIC_MIX - {"mp3", "wav", "flac", "aiff", "320", "kbps", "www"} and len(extra) > 6:
        notes.append("extra words in filename")
        score -= 10
    return True, score, notes


# ---------------------------------------------------------------- beatport

_bp_lock = threading.Lock()
_bp_last = [0.0]


def beatport_search(text):
    from curl_cffi import requests
    with _bp_lock:
        wait = PREFS["beatport"]["request_interval_seconds"] - (time.time() - _bp_last[0])
        if wait > 0:
            time.sleep(wait)
        _bp_last[0] = time.time()
    for attempt in range(3):
        try:
            r = requests.get("https://www.beatport.com/search/tracks", params={"q": text, "per_page": 50}, impersonate="chrome", timeout=30)
            if r.status_code == 200:
                break
        except Exception:
            pass
        time.sleep(3 * (attempt + 1))
    else:
        raise RuntimeError(f"Beatport search failed for {text!r}")
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', r.text, re.S)
    if not m:
        return []
    hits, seen = [], set()

    def walk(o):
        if isinstance(o, dict):
            if "mix_name" in o and ("length" in o or "length_ms" in o) and ("track_name" in o or "name" in o):
                tid = o.get("track_id") or o.get("id")
                if tid not in seen:
                    seen.add(tid)
                    hits.append(o)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(json.loads(m.group(1)))
    return hits


def beatport_track(url):
    """The track behind a Beatport track URL, in the same shape as a search hit."""
    from curl_cffi import requests
    with _bp_lock:
        wait = PREFS["beatport"]["request_interval_seconds"] - (time.time() - _bp_last[0])
        if wait > 0:
            time.sleep(wait)
        _bp_last[0] = time.time()
    r = requests.get(url, impersonate="chrome", timeout=30)
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', r.text, re.S) if r.status_code == 200 else None
    if not m:
        return None
    t = (json.loads(m.group(1)).get("props", {}).get("pageProps", {}) or {}).get("track")
    if not t or not t.get("track_length_ms"):
        return None
    artists = [{"artist_name": a.get("name", ""), "artist_type_name": "Artist"} for a in t.get("artists") or []]
    artists += [{"artist_name": a.get("name", ""), "artist_type_name": "Remixer"} for a in t.get("remixers") or []]
    return {"track_id": t.get("track_id"), "track_name": t.get("track_name", ""), "mix_name": t.get("mix_name", ""),
            "length": t["track_length_ms"], "bpm": t.get("bpm"), "key_name": t.get("key"), "artists": artists}


def bp_length(h):
    v = h.get("length_ms") or h.get("length")
    if isinstance(v, str) and ":" in v:
        mm, ss = v.split(":")[-2:]
        return int(mm) * 60 + int(ss)
    if isinstance(v, (int, float)):
        return v / 1000 if v > 10000 else v
    return None


def bp_rank(mix):
    m = norm(mix)
    if "extended" in m:
        return 0
    if re.search(r"\b(radio|short)\b", m) or m.endswith("edit"):
        return 3
    if re.search(r"\b(original|club|main|full)\b", m):
        return 1
    return 2


def beatport_match(req, hits):
    out = []
    for h in hits:
        name = h.get("track_name") or h.get("name") or ""
        mix = h.get("mix_name") or ""
        names = " ".join(a.get("artist_name", "") for a in h.get("artists") or [])
        name_core = TRAILING_FEAT.sub("", re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", FEAT.sub(" ", name)))
        hc, rc = set(tokens(name_core)), set(req.core_tokens)
        if not rc or not rc <= hc or len(hc - rc) > 1:
            continue
        if not any(set(tokens(a)) <= set(norm(names).split()) for a in req.artists):
            continue
        version_text = norm(f"{name} {mix} " + " ".join(a.get("artist_name", "") for a in h.get("artists") or [] if a.get("artist_type_name") == "Remixer"))
        if req.remixer_tokens:
            if not all(t in version_text.split() for t in req.remixer_tokens):
                continue
        else:
            extra = set(tokens(mix)) - GENERIC_MIX
            if extra or re.search(r"[\(\[][^\)\]]*\b(remix|edit|bootleg|flip|vip)\b", name, re.I):
                continue
            if "remix" in norm(mix).split() and not req.kind:
                continue
        length = bp_length(h)
        if not length:
            continue
        out.append({"track_id": h.get("track_id") or h.get("id"), "name": name, "mix_name": mix, "length": length,
                    "bpm": h.get("bpm"), "key": h.get("key_name"), "artists": names,
                    "rank": bp_rank(mix), "release_date": h.get("release_date")})
    if not out:
        return None
    out.sort(key=lambda x: (x["rank"], -x["length"]))
    best = out[0]
    best["url"] = f"https://www.beatport.com/track/{re.sub(r'[^a-z0-9]+', '-', norm(best['name']))}/{best['track_id']}"
    best["other_versions"] = sorted({(o["mix_name"], round(o["length"])) for o in out[1:]})
    return best


def resolve_beatport(req, row=None):
    """Find the version to target. Links in the input row are used first, then Beatport search."""
    linked = []
    for url in re.split(r"\s*\|\s*", (row or {}).get("beatport") or "")[:3]:
        if re.match(r"https?://(?:www\.)?beatport\.com/track/", url):
            try:
                hit = beatport_track(url)
            except Exception:
                hit = None
            if hit:
                linked.append(hit)
    queries = [" ".join([*tokens(req.primary), *req.core_tokens, *req.remixer_tokens])]
    if req.remixer_tokens:
        queries.append(" ".join([*req.core_tokens, *req.remixer_tokens]))
    queries.append(" ".join([*tokens(req.primary), *req.core_tokens]))
    best = None
    for qy in dict.fromkeys(queries):
        best = beatport_match(req, linked + beatport_search(qy))
        if best and best["rank"] == 0:
            return best
        if best:
            break
    return best or beatport_match(req, linked)


# ---------------------------------------------------------------- audio

def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration,bit_rate:stream=codec_type,codec_name,sample_rate",
                        "-of", "json", str(path)], capture_output=True, text=True)
    if r.returncode:
        return None
    info = json.loads(r.stdout)
    audio = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    dur = float(info.get("format", {}).get("duration") or 0)
    if not audio or dur <= 0:
        return None
    return {"duration": dur, "codec": audio[0].get("codec_name"), "bit_rate": int(info["format"].get("bit_rate") or 0)}


# ---------------------------------------------------------------- slskd

class SlskdUnavailable(RuntimeError):
    pass


class Slskd:
    def __init__(self, url, key):
        self.url, self.key = url.rstrip("/"), key

    def call(self, method, path, body=None, timeout=30):
        req = urllib.request.Request(self.url + "/api/v0" + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"X-API-Key": self.key, "Content-Type": "application/json"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    data = r.read()
                    return json.loads(data) if data else None
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                if e.code >= 500 and attempt < 3 and method == "GET":
                    time.sleep(2 * (attempt + 1))
                    continue
                raise RuntimeError(f"slskd {method} {path}: {e.code} {e.read().decode(errors='replace')[:300]}") from None
            except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
                # Connection resets happen when slskd is busy; GETs are safe to repeat, writes are not.
                if attempt < 3 and method == "GET":
                    time.sleep(2 * (attempt + 1))
                    continue
                raise SlskdUnavailable(f"slskd {method} {path}: {e}") from None

    def server(self):
        return self.call("GET", "/server")

    def start_search(self, text):
        sid = str(uuid.uuid4())
        # searchTimeout is left at slskd's default: the API documents it in seconds, but 0.26 passes it
        # to Soulseek.NET as milliseconds, so small values end searches instantly.
        self.call("POST", "/searches", {"id": sid, "searchText": text, "responseLimit": 500,
                                        "fileLimit": 20000, "filterResponses": True})
        return sid

    def search_state(self, sid):
        return self.call("GET", f"/searches/{sid}")

    def responses(self, sid):
        return self.call("GET", f"/searches/{sid}/responses") or []

    def delete_search(self, sid):
        try:
            self.call("DELETE", f"/searches/{sid}")
        except RuntimeError:
            pass

    def enqueue(self, username, filename, size):
        u = urllib.parse.quote(username, safe="")
        res = self.call("POST", f"/transfers/downloads/{u}", [{"filename": filename, "size": size}], timeout=90) or {}
        enq = res.get("enqueued") or res.get("Enqueued") or []
        if enq:
            return enq[0].get("id")
        failed = res.get("failed") or res.get("Failed") or ["enqueue failed"]
        raise RuntimeError(str(failed[0])[:200])

    def downloads(self, username):
        u = urllib.parse.quote(username, safe="")
        res = self.call("GET", f"/transfers/downloads/{u}") or {}
        return {f["id"]: f for d in res.get("directories", []) for f in d.get("files", [])}

    def cancel(self, username, tid):
        u = urllib.parse.quote(username, safe="")
        try:
            self.call("DELETE", f"/transfers/downloads/{u}/{tid}?remove=true")
        except RuntimeError:
            pass


class Pace:
    """Soulseek search pacing shared across processes."""

    def __init__(self):
        PACE_DB.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(PACE_DB, timeout=30, isolation_level=None)
        self.db.execute("create table if not exists searches (t real)")
        p = PREFS["soulseek"]
        self.limit, self.window = p["searches_per_window"], p["window_seconds"]

    def take(self):
        """Reserve a search slot if one is free now. Returns True when reserved."""
        now = time.time()
        self.db.execute("begin immediate")
        try:
            self.db.execute("delete from searches where t < ?", (now - 3600,))
            n = self.db.execute("select count(*) from searches where t > ?", (now - self.window,)).fetchone()[0]
            if n >= self.limit:
                self.db.execute("commit")
                return False
            self.db.execute("insert into searches values (?)", (now,))
            self.db.execute("commit")
            return True
        except Exception:
            self.db.execute("rollback")
            raise


# ---------------------------------------------------------------- state

SCHEMA = """
create table if not exists tracks (id text primary key, artist text, title text, row_json text, pos integer,
  status text, target_json text, sc_json text, qidx integer default 0, sc_tried integer default 0,
  source text, final_path text, note text, updated real);
create table if not exists searches (track text, query text, search_id text, files integer, ok integer, created real);
create table if not exists candidates (track text, username text, filename text, size integer, length integer,
  bitrate integer, ext text, ok integer, score real, notes text, peer_json text, primary key (track, username, filename));
create table if not exists attempts (track text, username text, filename text, transfer_id text, state text,
  started real, ended real, detail text, primary key (track, username, filename));
"""


def open_db(list_dir):
    (list_dir / "_state").mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(list_dir / "_state/state.sqlite", timeout=60, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("pragma journal_mode=wal")
    db.executescript(SCHEMA)
    return db


def set_status(db, tid, status, **fields):
    fields["status"], fields["updated"] = status, time.time()
    cols = ", ".join(f"{k}=?" for k in fields)
    db.execute(f"update tracks set {cols} where id=?", (*fields.values(), tid))
    db.commit()


def read_rows(path):
    p = Path(path).expanduser()
    if p.suffix.lower() == ".csv":
        rows = list(csv.DictReader(p.open(newline="", encoding="utf-8-sig")))
        lower = [{k.lower().strip(): (v or "").strip() for k, v in r.items() if k} for r in rows]
        return [r for r in lower if r.get("artist") and r.get("title")]
    out = []
    for line in p.read_text().splitlines():
        if " - " in line.strip():
            a, t = line.strip().split(" - ", 1)
            out.append({"artist": a, "title": t})
    return out


def add_tracks(db, rows):
    pos = db.execute("select coalesce(max(pos), 0) from tracks").fetchone()[0]
    added = 0
    for r in rows:
        tid = track_id(r["artist"], r["title"])
        if db.execute("select 1 from tracks where id=?", (tid,)).fetchone():
            continue
        pos += 1
        db.execute("insert into tracks (id, artist, title, row_json, pos, status, updated) values (?,?,?,?,?, 'pending', ?)",
                   (tid, r["artist"], r["title"], json.dumps(r), pos, time.time()))
        added += 1
    db.commit()
    return added


# ---------------------------------------------------------------- library index

def build_have_index(dirs, exclude):
    idx = []
    for d in dirs:
        if not d.exists():
            continue
        for root, subdirs, files in os.walk(d):
            subdirs[:] = [s for s in subdirs if not s.startswith(".") and s not in ("_rejected", "_state")]
            if any(Path(root).is_relative_to(e) for e in exclude):
                continue
            for fn in files:
                stem, _, ext = fn.rpartition(".")
                if ext.lower() in AUDIO_EXTS:
                    idx.append((set(norm(stem).split()), norm(stem), Path(root) / fn))
    return idx


def find_have(req, idx, target_len):
    tol = PREFS["versions"]["length_tolerance_seconds"]
    need = set(req.core_tokens) | set(req.remixer_tokens)
    for name_set, name_norm, path in idx:
        if not need <= name_set:
            continue
        if not any(set(tokens(a)) <= name_set for a in req.artists):
            continue
        ok, _, _ = evaluate(req, {"filename": path.name, "bitRate": 320}, None)
        if not ok:
            continue
        info = probe(path)
        if not info:
            continue
        if target_len and abs(info["duration"] - target_len) > tol:
            continue
        return path, info
    return None, None


# ---------------------------------------------------------------- soundcloud

def sc_urls(row):
    out = []
    for raw in re.split(r"\s*\|\s*", row.get("soundcloud") or ""):
        if not raw:
            continue
        if "w.soundcloud.com/player" in raw:
            u = urllib.parse.parse_qs(urllib.parse.urlparse(raw).query).get("url", [""])[0]
            raw = u
        if "soundcloud.com" in raw:
            out.append(raw)
    return out


def sc_matches(req, info):
    text = norm(f"{info.get('title', '')} {info.get('uploader', '')}")
    words = set(text.split())
    if not all(t in words for t in req.core_tokens):
        return False
    if req.remixer_tokens and not all(t in words for t in req.remixer_tokens):
        return False
    return any(set(tokens(a)) <= words for a in req.artists) or bool(req.remixer_tokens)


GATE_HOSTS = re.compile(r"https?://(?:www\.)?(?:hypeddit\.com|toneden\.io|fanlink\.to|ffm\.to|lnk\.to|bit\.ly|gate\.fm|edmdisc\.com|smarturl\.it|feature\.fm|pumpyoursound|show\.co|dl\.)[^\s\"')]*", re.I)


def soundcloud_fetch(req, row, dest_dir, cfg):
    """Return ('done', path, info) | ('gate', url, None) | ('none', None, None)."""
    import yt_dlp
    sc = cfg.get("soundcloud", {})
    base = {"quiet": True, "no_warnings": True, "ignoreerrors": True, "noprogress": True}
    if sc.get("profile"):
        base["cookiesfrombrowser"] = (sc.get("browser", "firefox"), sc["profile"], None, None)
    candidates = []
    with yt_dlp.YoutubeDL(base) as y:
        urls = sc_urls(row)
        if not urls:
            qy = f"{req.artist} {req.core} {req.label}".strip()
            res = y.extract_info(f"scsearch8:{qy}", download=False, process=False) or {}
            urls = [e.get("url") for e in (res.get("entries") or []) if e and e.get("url")]
        for u in urls[:8]:
            try:
                info = y.extract_info(u, download=False)
            except Exception:
                info = None
            if info and (sc_urls(row) or sc_matches(req, info)):
                candidates.append(info)
    downloadable = [i for i in candidates if any(f.get("format_id") == "download" for f in i.get("formats") or [])]
    if downloadable:
        linked = {u.split("?")[0].rstrip("/") for u in sc_urls(row)}
        own = set(req.remixer_tokens) or set(tokens(req.primary))

        def rank(i):
            uploader = set(norm(f"{i.get('uploader', '')} {i.get('uploader_id', '')} {i.get('webpage_url', '')}").split())
            return (str(i.get("webpage_url", "")).split("?")[0].rstrip("/") in linked or str(i.get("id")) in " ".join(linked),
                    "extended" in norm(i.get("title", "")), bool(own & uploader), i.get("duration") or 0)
        downloadable.sort(key=rank, reverse=True)
        info = downloadable[0]
        tmp = dest_dir / ".incoming-sc"
        tmp.mkdir(parents=True, exist_ok=True)
        opts = dict(base, format="download", outtmpl=str(tmp / "%(id)s.%(ext)s"))
        with yt_dlp.YoutubeDL(opts) as y:
            y.download([info["webpage_url"]])
        files = sorted(tmp.glob(f"{info['id']}.*"), key=lambda p: p.stat().st_mtime, reverse=True)
        if files and (pinfo := probe(files[0])):
            try:
                tmp.rmdir()
            except OSError:
                pass
            return "done", files[0], {"title": info.get("title"), "url": info.get("webpage_url"), **pinfo}
    for info in candidates:
        m = GATE_HOSTS.search(info.get("description") or "")
        if m:
            return "gate", m.group(0), None
        if re.search(r"free\s*(?:download|dl)", info.get("title", ""), re.I):
            return "gate", info.get("webpage_url"), None
    return "none", None, None


# ---------------------------------------------------------------- the run

class Runner:
    def __init__(self, cfg, list_name, args):
        self.cfg, self.args = cfg, args
        self.dir = cfg["library_root"] / safe_name(list_name)
        for sub in ("", "_review", "_rejected", "_state"):
            (self.dir / sub).mkdir(parents=True, exist_ok=True)
        self.db = open_db(self.dir)
        self.lock = threading.Lock()
        self.slsk = Slskd(cfg["slskd"]["url"], cfg["slskd"]["api_key"])
        self.incoming = Path(cfg["slskd"]["downloads_dir"]).expanduser()
        self.prefs = PREFS["soulseek"]
        self.log_file = (self.dir / "_state/run.log").open("a")
        self.bad_peers = {}

    def log(self, msg):
        line = time.strftime("%H:%M:%S ") + msg
        print(line, flush=True)
        self.log_file.write(line + "\n")
        self.log_file.flush()

    def q(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            rows = cur.fetchall()
            self.db.commit()
            return rows

    def status(self, tid, status, **fields):
        with self.lock:
            set_status(self.db, tid, status, **fields)

    def req_of(self, row):
        return Request(row["artist"], row["title"])

    def target(self, row):
        return json.loads(row["target_json"]) if row["target_json"] else None

    def dest_name(self, row, ext):
        title = row["title"]
        t = self.target(row)
        if t and t.get("mix_name") and norm(t["mix_name"]) not in norm(title):
            mix = t["mix_name"]
            if not (Request(row["artist"], title).remixer_tokens and "remix" in norm(mix)):
                title = f"{title} ({mix})"
        return safe_name(f"{row['artist']} - {title}") + "." + ext.lower()

    def place(self, row, src, sub=""):
        dest_dir = self.dir / sub if sub else self.dir
        dest = dest_dir / self.dest_name(row, src.suffix.lstrip("."))
        i = 2
        while dest.exists():
            dest = dest.with_name(f"{dest.stem} ({i}){dest.suffix}")
            i += 1
        shutil.move(str(src), dest)
        parent = src.parent
        while parent != self.incoming and parent.is_relative_to(self.incoming) and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent
        return dest

    def place_rejected(self, src):
        dest = self.dir / "_rejected" / src.name
        shutil.move(str(src), dest)
        parent = src.parent
        while parent != self.incoming and parent.is_relative_to(self.incoming) and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent

    # ---- phase 1: resolve (Beatport + library check), in a thread
    def resolver(self):
        excl = [self.dir / "_rejected", self.dir / "_review", self.incoming]
        idx = None if self.args.no_have else build_have_index([*self.cfg["have_dirs"], *self.extra_have], excl)
        adopt = build_have_index(self.adopt_dirs, excl) if self.adopt_dirs else None
        while True:
            rows = self.q("select * from tracks where status='pending' order by pos limit 20")
            if not rows:
                return
            for row in rows:
                req = self.req_of(row)
                try:
                    target = resolve_beatport(req, json.loads(row["row_json"]))
                except Exception as e:
                    target = None
                    self.log(f"beatport error for {row['artist']} - {row['title']}: {e}")
                tlen = target["length"] if target else None
                if adopt:
                    path, info = find_have(req, adopt, tlen)
                    if path:
                        adopt[:] = [e for e in adopt if e[2] != path]
                        row = self.q("select * from tracks where id=?", (row["id"],))[0]
                        self.q("update tracks set target_json=? where id=?", (json.dumps(target) if target else None, row["id"]))
                        row = self.q("select * from tracks where id=?", (row["id"],))[0]
                        dest = self.place(row, path)
                        self.status(row["id"], "done", final_path=str(dest), source="adopted",
                                    note=f"{info['codec']} {info['duration']:.0f}s, moved from {path.parent}" + (f", matches Beatport {target['mix_name']}" if target else ""))
                        self.log(f"adopted   {row['artist']} - {row['title']}")
                        continue
                if idx is not None:
                    path, info = find_have(req, idx, tlen)
                    if path:
                        self.status(row["id"], "have", target_json=json.dumps(target) if target else None,
                                    final_path=str(path), source="library", note=f"{info['duration']:.0f}s already in library")
                        self.log(f"have      {row['artist']} - {row['title']}")
                        continue
                if target:
                    nxt, note = "search", f"Beatport: {target['mix_name']} {target['length']:.0f}s"
                elif self.args.no_soundcloud:
                    nxt, note = "search", "not on Beatport"
                else:
                    nxt, note = "sc", "not on Beatport; SoundCloud first"
                self.status(row["id"], nxt, target_json=json.dumps(target) if target else None, note=note)
                self.log(f"resolved  {row['artist']} - {row['title']}: {note}")

    # ---- SoundCloud worker thread
    def soundcloud_worker(self, resolver_thread):
        while True:
            rows = self.q("select * from tracks where status='sc' order by pos limit 1")
            if not rows:
                if not resolver_thread.is_alive() and not self.q("select 1 from tracks where status in ('pending','sc') limit 1"):
                    if not self.q("select 1 from tracks where status in ('search','searching','transfer') limit 1"):
                        return
                time.sleep(3)
                continue
            row = rows[0]
            req = self.req_of(row)
            try:
                kind, val, info = soundcloud_fetch(req, json.loads(row["row_json"]), self.dir, self.cfg)
            except Exception as e:
                kind, val, info = "none", None, None
                self.log(f"soundcloud error for {row['artist']} - {row['title']}: {e}")
            soulseek_done = row["qidx"] >= len(req.queries())
            if kind == "done":
                dest = self.place(row, val)
                self.status(row["id"], "done", final_path=str(dest), source="soundcloud", sc_tried=1,
                            note=f"SoundCloud free download, {info['codec']} {info['duration']:.0f}s ({info['url']})")
                self.log(f"done      {row['artist']} - {row['title']} [soundcloud]")
            elif soulseek_done:
                self.status(row["id"], "gate" if kind == "gate" else "missing", sc_tried=1,
                            sc_json=json.dumps({"gate": val}) if val else None,
                            note=f"free download behind a gate: {val}" if kind == "gate" else "not found on Soulseek or SoundCloud")
            else:
                self.status(row["id"], "search", sc_tried=1, sc_json=json.dumps({"gate": val}) if val else None)

    # ---- Soulseek main loop
    def finish_unfound(self, row, why):
        req = self.req_of(row)
        sc = json.loads(row["sc_json"]) if row["sc_json"] else {}
        review = self.q("select final_path from tracks where id=?", (row["id"],))[0]["final_path"]
        if review and Path(review).exists():
            self.status(row["id"], "review", note=f"closest copy kept in _review ({why})")
        elif not row["sc_tried"] and not self.args.no_soundcloud:
            self.status(row["id"], "sc", qidx=len(req.queries()))
        elif sc.get("gate"):
            self.status(row["id"], "gate", note=f"free download behind a gate: {sc['gate']}")
        else:
            self.status(row["id"], "missing", note=why)
            self.log(f"missing   {row['artist']} - {row['title']}: {why}")

    def handle_results(self, row, query, sid):
        req, target = self.req_of(row), self.target(row)
        tlen = target["length"] if target else None
        responses = self.slsk.responses(sid)
        self.slsk.delete_search(sid)
        files = ok = 0
        with self.lock:
            for resp in responses:
                peer = {k: resp.get(k) for k in ("username", "hasFreeUploadSlot", "queueLength", "uploadSpeed")}
                for f in resp.get("files") or []:
                    files += 1
                    good, score, notes = evaluate(req, f, tlen, peer)
                    ok += good
                    self.db.execute("insert or replace into candidates values (?,?,?,?,?,?,?,?,?,?,?)",
                                    (row["id"], resp["username"], f["filename"], f.get("size"), f.get("length"), f.get("bitRate"),
                                     (f.get("extension") or f["filename"].rpartition(".")[2]).lower(), int(good), score,
                                     "; ".join(notes), json.dumps(peer)))
            self.db.execute("insert into searches values (?,?,?,?,?,?)", (row["id"], query, sid, files, ok, time.time()))
            self.db.commit()
        self.log(f"searched  {row['artist']} - {row['title']} [{query}]: {files} files, {ok} usable")
        self.status(row["id"], "transfer" if ok else "search", qidx=row["qidx"] + 1)

    def next_candidate(self, tid):
        tried = {(r["username"], r["filename"]) for r in self.q("select username, filename from attempts where track=?", (tid,))}
        peers_tried = {u for u, _ in tried}
        if len(peers_tried) >= self.prefs["max_peers_per_track"]:
            return None
        for c in self.q("select * from candidates where track=? and ok=1 order by score desc", (tid,)):
            if (c["username"], c["filename"]) in tried or c["username"] in peers_tried:
                continue
            if self.bad_peers.get(c["username"], 0) >= 3:
                continue
            return c
        return None

    def start_transfer(self, row, active):
        c = self.next_candidate(row["id"])
        if not c:
            req = self.req_of(row)
            if row["qidx"] < len(req.queries()):
                self.status(row["id"], "search")
            else:
                self.finish_unfound(row, "no usable copy transferred")
            return
        try:
            tid = self.slsk.enqueue(c["username"], c["filename"], c["size"])
            state, detail = "active", None
        except Exception as e:
            tid, state, detail = None, "failed", str(e)
            self.bad_peers[c["username"]] = self.bad_peers.get(c["username"], 0) + 1
        self.q("insert or replace into attempts values (?,?,?,?,?,?,?,?)",
               (row["id"], c["username"], c["filename"], tid, state, time.time(), None if tid else time.time(), detail))
        if tid:
            active[row["id"]] = {"username": c["username"], "filename": c["filename"], "id": tid,
                                 "started": time.time(), "bytes": -1, "moved": time.time()}
            self.log(f"transfer  {row['artist']} - {row['title']} <- {c['username']}: {file_basename(c['filename'])}")

    def locate_download(self, filename, started):
        base = file_basename(filename)
        parent = re.split(r"[\\/]", filename)[-2] if re.search(r"[\\/]", filename) else ""
        hits = [Path(r) / fn for r, _, fs in os.walk(self.incoming) for fn in fs if fn == base]
        hits = [p for p in hits if p.stat().st_mtime >= started - 5]
        hits.sort(key=lambda p: (p.parent.name != parent, -p.stat().st_mtime))
        return hits[0] if hits else None

    def finish_transfer(self, row, a, state, detail=None):
        self.q("update attempts set state=?, ended=?, detail=? where track=? and username=? and filename=?",
               (state, time.time(), detail, row["id"], a["username"], a["filename"]))

    def poll_transfers(self, active):
        by_user = {}
        for tid_track, a in list(active.items()):
            row = self.q("select * from tracks where id=?", (tid_track,))[0]
            if a["username"] not in by_user:
                try:
                    by_user[a["username"]] = self.slsk.downloads(a["username"])
                except Exception as e:
                    self.log(f"slskd poll error: {e}")
                    continue
            t = by_user[a["username"]].get(a["id"])
            now = time.time()
            if t is None:
                if now - a["started"] > 60:
                    self.finish_transfer(row, a, "failed", "transfer disappeared")
                    del active[tid_track]
                continue
            state = t.get("state", "")
            got = t.get("bytesTransferred") or 0
            if got != a["bytes"]:
                a["bytes"], a["moved"] = got, now
            if "Succeeded" in state:
                del active[tid_track]
                self.verify(row, a)
            elif "Completed" in state:
                reason = state.replace("Completed, ", "") + (f": {t.get('exception')}" if t.get("exception") else "")
                self.bad_peers[a["username"]] = self.bad_peers.get(a["username"], 0) + 1
                self.finish_transfer(row, a, "failed", reason)
                self.log(f"failed    {row['artist']} - {row['title']} <- {a['username']}: {reason}")
                del active[tid_track]
            else:
                limit = None
                if "Queued" in state and now - a["started"] > self.prefs["remote_queue_timeout_minutes"] * 60:
                    limit = "remote queue too slow"
                elif "InProgress" in state and now - a["moved"] > self.prefs["stalled_timeout_minutes"] * 60:
                    limit = "transfer stalled"
                elif ("Requested" in state or "Initializing" in state) and now - a["started"] > 180:
                    limit = "peer never answered"
                if limit:
                    self.slsk.cancel(a["username"], a["id"])
                    self.finish_transfer(row, a, "failed", limit)
                    self.log(f"gave up   {row['artist']} - {row['title']} <- {a['username']}: {limit}")
                    del active[tid_track]

    def verify(self, row, a):
        src = self.locate_download(a["filename"], a["started"])
        info = probe(src) if src else None
        if not info:
            self.finish_transfer(row, a, "failed", "downloaded file missing or unreadable")
            if src:
                self.place_rejected(src)
            return
        target = self.target(row)
        d = abs(info["duration"] - target["length"]) if target else 0
        pv = PREFS["versions"]
        if d <= pv["length_tolerance_seconds"]:
            old = row["final_path"]
            if old and Path(old).exists() and "/_review/" in old:
                shutil.move(old, self.dir / "_rejected" / Path(old).name)
            dest = self.place(row, src)
            note = (f"{info['codec']} {info['duration']:.0f}s" + (f", matches Beatport {target['mix_name']}" if target else ", no Beatport release to compare"))
            self.finish_transfer(row, a, "succeeded", str(dest))
            self.status(row["id"], "done", final_path=str(dest), source=f"soulseek:{a['username']}", note=note)
            self.log(f"done      {row['artist']} - {row['title']} ({note})")
        elif d <= pv["review_tolerance_seconds"] and not row["final_path"]:
            dest = self.place(row, src, "_review")
            self.finish_transfer(row, a, "review", f"off by {d:.0f}s")
            self.q("update tracks set final_path=? where id=?", (str(dest), row["id"]))
            self.log(f"review    {row['artist']} - {row['title']}: off by {d:.0f}s, still looking")
        else:
            self.place_rejected(src)
            self.finish_transfer(row, a, "rejected", f"{info['duration']:.0f}s vs target {target['length']:.0f}s")
            self.log(f"rejected  {row['artist']} - {row['title']}: {info['duration']:.0f}s vs {target['length']:.0f}s")

    def run(self):
        srv = self.slsk.server()
        if not srv or not srv.get("isLoggedIn"):
            sys.exit(f"slskd isn't logged in to Soulseek ({srv}). Check `launchctl print gui/$UID/com.aaronpak.slskd`.")
        self.extra_have = [Path(p).expanduser() for p in self.args.have or []]
        self.adopt_dirs = [Path(p).expanduser() for p in getattr(self.args, "adopt", None) or []]
        self.q("update tracks set status='search' where status='searching'")
        active = {}
        for r in self.q("select * from attempts where state='active'"):
            active[r["track"]] = {"username": r["username"], "filename": r["filename"], "id": r["transfer_id"],
                                  "started": r["started"], "bytes": -1, "moved": time.time()}
        resolver = threading.Thread(target=self.resolver, daemon=True)
        resolver.start()
        sc_thread = None
        if not self.args.no_soundcloud:
            sc_thread = threading.Thread(target=self.soundcloud_worker, args=(resolver,), daemon=True)
            sc_thread.start()
        pace, inflight = Pace(), {}
        last_report = 0
        while True:
            try:
                self.step(pace, inflight, active)
            except SlskdUnavailable as e:
                self.log(f"slskd unavailable, retrying in 15s: {e}")
                time.sleep(15)
                continue
            if time.time() - last_report > 60:
                write_report(self.db, self.dir)
                last_report = time.time()
            busy = self.q("select count(*) from tracks where status in ('pending','sc','search','searching','transfer')")[0][0]
            if not busy and not active and not inflight and not resolver.is_alive() and not (sc_thread and sc_thread.is_alive()):
                break
            if self.args.limit_minutes and time.time() - self.t0 > self.args.limit_minutes * 60:
                self.log("time limit reached; rerun the same command to resume")
                break
            time.sleep(2)
        write_report(self.db, self.dir)
        self.log(f"finished. report: {self.dir / 'report.md'}")

    def step(self, pace, inflight, active):
        # searches: finish completed ones, start new ones within the pacing budget
        for sid, (tid, query, t0) in list(inflight.items()):
            st = self.slsk.search_state(sid) or {}
            if st.get("isComplete") or "Completed" in (st.get("state") or "") or time.time() - t0 > 90:
                del inflight[sid]
                self.handle_results(self.q("select * from tracks where id=?", (tid,))[0], query, sid)
        while len(inflight) < self.prefs["max_inflight_searches"]:
            rows = self.q("select * from tracks where status='search' order by pos limit 1")
            if not rows:
                break
            row = rows[0]
            queries = self.req_of(row).queries()
            if row["qidx"] >= len(queries):
                if self.q("select 1 from candidates where track=? and ok=1 limit 1", (row["id"],)) and self.next_candidate(row["id"]):
                    self.status(row["id"], "transfer")
                else:
                    self.finish_unfound(row, f"no usable copy in {len(queries)} searches")
                continue
            if not pace.take():
                break
            query = queries[row["qidx"]]
            try:
                sid = self.slsk.start_search(query)
            except Exception as e:
                self.log(f"search error: {e}")
                break
            inflight[sid] = (row["id"], query, time.time())
            self.status(row["id"], "searching")
        # transfers
        self.poll_transfers(active)
        for row in self.q("select * from tracks where status='transfer' order by pos"):
            if len(active) >= self.prefs["max_active_transfers"]:
                break
            if row["id"] not in active:
                self.start_transfer(row, active)


# ---------------------------------------------------------------- reporting

def write_report(db, list_dir):
    rows = db.execute("select * from tracks order by pos").fetchall()
    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    lines = [f"# {list_dir.name}", "", f"Updated {time.strftime('%Y-%m-%d %H:%M')}. " +
             ", ".join(f"**{counts.get(s, 0)}** {s}" for s in ("done", "have", "review", "gate", "missing") if counts.get(s)) +
             (f", {sum(counts.get(s, 0) for s in ACTIVE)} still in progress" if any(counts.get(s) for s in ACTIVE) else ""), ""]
    sections = [("review", "Needs a listen (in _review/)"), ("gate", "Free downloads behind a gate"),
                ("missing", "Not found"), ("done", "Downloaded"), ("have", "Already in your library")]
    for status, heading in sections:
        sel = [r for r in rows if r["status"] == status]
        if not sel:
            continue
        lines += [f"## {heading} ({len(sel)})", ""]
        for r in sel:
            t = json.loads(r["target_json"]) if r["target_json"] else None
            tgt = f" · target {t['mix_name']} {t['length'] // 60:.0f}:{t['length'] % 60:02.0f}" if t else ""
            path = f" · `{Path(r['final_path']).name}`" if r["final_path"] and status in ("done", "review", "have") else ""
            lines.append(f"- {r['artist']} – {r['title']}{tgt}{path} — {r['note'] or ''}")
        lines.append("")
    tmp = list_dir / "report.md.tmp"
    tmp.write_text("\n".join(lines))
    os.replace(tmp, list_dir / "report.md")
    with (list_dir / "_state/report.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["artist", "title", "status", "source", "target_mix", "target_length", "path", "note"])
        for r in rows:
            t = json.loads(r["target_json"]) if r["target_json"] else {}
            w.writerow([r["artist"], r["title"], r["status"], r["source"], t.get("mix_name"), t.get("length"), r["final_path"], r["note"]])


# ---------------------------------------------------------------- commands

def cmd_run(args):
    cfg = load_config()
    runner = Runner(cfg, args.list, args)
    rows = []
    for inp in args.input or []:
        rows += read_rows(inp)
    for t in args.track or []:
        if " - " not in t:
            sys.exit(f"--track needs 'Artist - Title': {t}")
        a, ti = t.split(" - ", 1)
        rows.append({"artist": a, "title": ti})
    if args.limit:
        rows = rows[:args.limit]
    added = add_tracks(runner.db, rows)
    if args.retry:
        n = runner.db.execute("update tracks set status='pending', qidx=0, sc_tried=0 where status in ('missing','gate','review')").rowcount
        runner.db.commit()
        runner.log(f"retrying {n} unfinished tracks")
    runner.log(f"{added} tracks added; list folder {runner.dir}")
    runner.t0 = time.time()
    runner.run()


def open_list(name):
    cfg = load_config()
    d = cfg["library_root"] / safe_name(name)
    if not (d / "_state/state.sqlite").exists():
        sys.exit(f"No list named {name!r} in {cfg['library_root']}")
    return d, open_db(d)


def cmd_status(args):
    d, db = open_list(args.list)
    for s, n in db.execute("select status, count(*) from tracks group by status order by 2 desc"):
        print(f"{s:10} {n}")
    act = db.execute("select t.artist, t.title, a.username from attempts a join tracks t on t.id=a.track where a.state='active'").fetchall()
    for r in act:
        print(f"  downloading {r['artist']} - {r['title']} <- {r['username']}")
    write_report(db, d)
    print(f"report: {d / 'report.md'}")


def find_track(db, needle):
    rows = db.execute("select * from tracks where id=? or lower(artist || ' - ' || title) like ?", (needle, f"%{needle.lower()}%")).fetchall()
    if not rows:
        sys.exit(f"no track matches {needle!r}")
    if len(rows) > 1:
        for r in rows[:20]:
            print(f"{r['id']}  {r['artist']} - {r['title']}  [{r['status']}]")
        sys.exit("several tracks match; pass the id")
    return rows[0]


def cmd_candidates(args):
    d, db = open_list(args.list)
    row = find_track(db, args.track)
    print(f"{row['artist']} - {row['title']}  [{row['status']}] {row['note'] or ''}")
    if row["target_json"]:
        t = json.loads(row["target_json"])
        print(f"target: {t['mix_name']} {t['length']:.0f}s  {t.get('url', '')}  others: {t.get('other_versions')}")
    for s in db.execute("select query, files, ok from searches where track=?", (row["id"],)):
        print(f"search [{s['query']}]: {s['files']} files, {s['ok']} usable")
    sql = "select * from candidates where track=? " + ("" if args.all else "and ok=1 ") + "order by ok desc, score desc limit ?"
    for c in db.execute(sql, (row["id"], args.n)):
        a = db.execute("select state, detail from attempts where track=? and username=? and filename=?", (row["id"], c["username"], c["filename"])).fetchone()
        tried = f"  [{a['state']}: {a['detail'] or ''}]" if a else ""
        print(f"{'OK ' if c['ok'] else 'NO '}{c['score']:7.1f} {c['length'] or '?':>4}s {c['ext']:4} {c['bitrate'] or '':>4} "
              f"{c['username']}: {c['filename']}  {c['notes'] or ''}{tried}")


def cmd_pick(args):
    """Download one specific file for a track, bypassing the ranking, and verify it like any other."""
    cfg = load_config()
    runner = Runner(cfg, args.list, argparse.Namespace(no_have=True, no_soundcloud=True, have=[], adopt=[], limit_minutes=0))
    row = find_track(runner.db, args.track)
    c = runner.db.execute("select size from candidates where track=? and username=? and filename=?", (row["id"], args.peer, args.file)).fetchone()
    size = (c["size"] if c else None) or args.size
    if not size:
        sys.exit("unknown file size; pass --size")
    if row["status"] == "done" and not args.replace:
        sys.exit(f"already done ({row['final_path']}); pass --replace to fetch this copy anyway")
    tid = runner.slsk.enqueue(args.peer, args.file, size)
    runner.q("insert or replace into attempts values (?,?,?,?,?,?,?,?)", (row["id"], args.peer, args.file, tid, "active", time.time(), None, "picked by hand"))
    runner.status(row["id"], "transfer", final_path=None if args.replace else row["final_path"])
    active = {row["id"]: {"username": args.peer, "filename": args.file, "id": tid, "started": time.time(), "bytes": -1, "moved": time.time()}}
    runner.log(f"transfer  {row['artist']} - {row['title']} <- {args.peer}: {file_basename(args.file)}")
    while active:
        time.sleep(3)
        runner.poll_transfers(active)
    row = runner.q("select * from tracks where id=?", (row["id"],))[0]
    if row["status"] == "transfer":
        runner.status(row["id"], "review" if row["final_path"] else "missing", note="hand-picked copy failed; see candidates")
    write_report(runner.db, runner.dir)
    a = runner.q("select state, detail from attempts where track=? and username=? and filename=?", (row["id"], args.peer, args.file))[0]
    print(f"{a['state']}: {a['detail']}")


def cmd_search(args):
    """Raw Soulseek search, paced like everything else. Prints every file as JSON lines."""
    cfg = load_config()
    slsk, pace = Slskd(cfg["slskd"]["url"], cfg["slskd"]["api_key"]), Pace()
    while not pace.take():
        time.sleep(5)
    sid = slsk.start_search(args.text)
    t0 = time.time()
    while time.time() - t0 < 90:
        st = slsk.search_state(sid) or {}
        if st.get("isComplete") or "Completed" in (st.get("state") or ""):
            break
        time.sleep(2)
    req = Request(args.artist, args.title) if args.artist and args.title else None
    for resp in slsk.responses(sid):
        peer = {k: resp.get(k) for k in ("username", "hasFreeUploadSlot", "queueLength", "uploadSpeed")}
        for f in resp.get("files") or []:
            rec = {**peer, **{k: f.get(k) for k in ("filename", "size", "length", "bitRate", "extension")}}
            if req:
                rec["ok"], rec["score"], rec["notes"] = evaluate(req, f, args.length, peer)
            print(json.dumps(rec))
    slsk.delete_search(sid)


def cmd_doctor(args):
    cfg = load_config()
    ok = True
    try:
        srv = Slskd(cfg["slskd"]["url"], cfg["slskd"]["api_key"]).server()
        print(f"slskd: {'logged in' if srv and srv.get('isLoggedIn') else 'NOT logged in'} ({(srv or {}).get('state')})")
        ok &= bool(srv and srv.get("isLoggedIn"))
    except Exception as e:
        print(f"slskd: unreachable ({e})")
        ok = False
    print(f"ffprobe: {shutil.which('ffprobe') or 'MISSING'}")
    try:
        r = resolve_beatport(Request("John Summit", "Where You Are"))
        print(f"beatport: ok ({r['mix_name']} {r['length']:.0f}s)" if r else "beatport: reachable, no match for the test track")
    except Exception as e:
        print(f"beatport: FAILED ({e})")
        ok = False
    prof = cfg.get("soundcloud", {}).get("profile")
    cookies = Path(prof or "/nonexistent") / "cookies.sqlite"
    print(f"soundcloud cookies: {cookies if cookies.exists() else 'MISSING (free downloads that need sign-in will fail)'}")
    print(f"library: {cfg['library_root']}")
    sys.exit(0 if ok else 1)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="add tracks to a list and fetch everything not yet finished")
    r.add_argument("list", help="list name; becomes the folder under library_root")
    r.add_argument("--input", action="append", help="CSV with artist,title (+ optional soundcloud, beatport) or 'Artist - Title' lines")
    r.add_argument("--track", action="append", help="'Artist - Title'; repeatable")
    r.add_argument("--limit", type=int, help="only add the first N rows")
    r.add_argument("--retry", action="store_true", help="retry tracks that ended missing, gated or in review")
    r.add_argument("--have", action="append", help="extra folder of tracks already owned; repeatable")
    r.add_argument("--adopt", action="append", help="folder of earlier downloads: files matching a track (right name and length) are moved into the list; repeatable")
    r.add_argument("--no-have", action="store_true", help="don't skip tracks found in library folders")
    r.add_argument("--no-soundcloud", action="store_true")
    r.add_argument("--limit-minutes", type=float, default=0, help="stop after this long; rerun to resume")
    r.set_defaults(fn=cmd_run)
    s = sub.add_parser("status", help="counts and active transfers; refreshes report.md")
    s.add_argument("list")
    s.set_defaults(fn=cmd_status)
    c = sub.add_parser("candidates", help="every file Soulseek returned for a track, with verdicts")
    c.add_argument("list")
    c.add_argument("track", help="track id or part of 'Artist - Title'")
    c.add_argument("--all", action="store_true", help="include rejected files and why")
    c.add_argument("-n", type=int, default=40)
    c.set_defaults(fn=cmd_candidates)
    k = sub.add_parser("pick", help="download a specific peer's file for a track")
    k.add_argument("list")
    k.add_argument("track")
    k.add_argument("--peer", required=True)
    k.add_argument("--file", required=True)
    k.add_argument("--size", type=int)
    k.add_argument("--replace", action="store_true", help="fetch even if the track is already done")
    k.set_defaults(fn=cmd_pick)
    q = sub.add_parser("search", help="raw paced Soulseek search, JSON lines")
    q.add_argument("text")
    q.add_argument("--artist")
    q.add_argument("--title")
    q.add_argument("--length", type=float, help="target length in seconds for --artist/--title scoring")
    q.set_defaults(fn=cmd_search)
    sub.add_parser("doctor", help="check slskd, ffprobe, Beatport and SoundCloud cookies").set_defaults(fn=cmd_doctor)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
