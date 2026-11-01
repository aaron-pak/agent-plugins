#!/usr/bin/env python3
"""Install slskd as an always-on macOS agent and write dj-fetch's machine config.

Idempotent: keeps an existing slskd.yml and dj-fetch config unless --rewrite is
given. Credentials come from --username/--password, or from an existing
Sockseek or Nicotine+ config on this Mac.
"""
import argparse, ast, configparser, hashlib, json, os, platform, plistlib, re, secrets, shutil, subprocess, sys, tempfile, time, urllib.request, zipfile
from pathlib import Path

HOME = Path.home()
OPT = HOME / ".local/opt/slskd"
BIN = HOME / ".local/bin/slskd"
APP_DIR = HOME / ".local/share/slskd"
YML = APP_DIR / "slskd.yml"
WRAPPER = APP_DIR / "run-slskd.sh"
PLIST = HOME / "Library/LaunchAgents/com.aaronpak.slskd.plist"
LABEL = "com.aaronpak.slskd"
DJ_CONFIG = HOME / ".config/dj-fetch/config.toml"
ICLOUD_MUSIC = HOME / "Library/Mobile Documents/com~apple~CloudDocs/Music/library"


def log(msg):
    print(msg, flush=True)


def existing_credentials():
    sock = HOME / ".config/sockseek/sockseek.conf"
    if sock.exists():
        vals = dict(re.findall(r"^\s*([\w-]+)\s*=\s*(.*?)\s*$", sock.read_text(), re.M))
        if vals.get("username") and vals.get("password"):
            return vals["username"], vals["password"]
    nic = HOME / ".config/nicotine/config"
    if nic.exists():
        cp = configparser.RawConfigParser()
        cp.read(nic)
        try:
            u, p = cp.get("server", "login"), cp.get("server", "passw")
            if u and p:
                return u, p
        except (configparser.Error, KeyError):
            pass
    return None, None


def nicotine_shares():
    nic = HOME / ".config/nicotine/config"
    if not nic.exists():
        return []
    cp = configparser.RawConfigParser()
    cp.read(nic)
    try:
        return [path for _, path in ast.literal_eval(cp.get("transfers", "shared"))]
    except Exception:
        return []


def install_binary(version):
    arch = "arm64" if platform.machine() == "arm64" else "x64"
    rel = json.load(urllib.request.urlopen(
        f"https://api.github.com/repos/slskd/slskd/releases/{'latest' if version == 'latest' else 'tags/' + version}", timeout=30))
    tag = rel["tag_name"]
    dest = OPT / tag
    if (dest / "slskd").exists():
        log(f"slskd {tag} already installed")
    else:
        asset = next(a for a in rel["assets"] if a["name"] == f"slskd-{tag}-osx-{arch}.zip")
        with tempfile.TemporaryDirectory() as tmp:
            zpath = Path(tmp) / asset["name"]
            urllib.request.urlretrieve(asset["browser_download_url"], zpath)
            digest = "sha256:" + hashlib.sha256(zpath.read_bytes()).hexdigest()
            if asset.get("digest") and asset["digest"] != digest:
                sys.exit(f"checksum mismatch for {asset['name']}: {digest} != {asset['digest']}")
            dest.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(zpath) as z:
                z.extractall(dest)
        (dest / "slskd").chmod(0o755)
        subprocess.run(["xattr", "-dr", "com.apple.quarantine", str(dest)], check=False)
        log(f"installed slskd {tag} to {dest}")
    BIN.parent.mkdir(parents=True, exist_ok=True)
    if BIN.is_symlink() or BIN.exists():
        BIN.unlink()
    BIN.symlink_to(dest / "slskd")
    return tag


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def write_yml(args, username, password, api_key, library_root):
    incoming = library_root / ".incoming"
    incoming.mkdir(parents=True, exist_ok=True)
    (APP_DIR / "incomplete").mkdir(parents=True, exist_ok=True)
    shares = [f"[DJ Fetch]{library_root}"] + [f"!{library_root / d}" for d in (".incoming", "_rejected")]
    for path in nicotine_shares():
        if Path(path).exists() and Path(path) != library_root:
            shares.append(f"[{Path(path).name}]{path}")
    ui_password = secrets.token_urlsafe(18)
    lines = [
        "# Written by dj-fetch setup_slskd.py. The agent drives slskd through its API.",
        "remote_file_management: true",
        "directories:",
        f"  downloads: {q(incoming)}",
        f"  incomplete: {q(APP_DIR / 'incomplete')}",
        "shares:",
        "  directories:",
        *[f"    - {q(s)}" for s in shares],
        "  filters:",
        "    - '[\\\\/]_state[\\\\/]'",
        "    - '[\\\\/]\\.incoming'",
        "    - '[\\\\/]_rejected[\\\\/]'",
        "    - '\\.(sqlite|sqlite-wal|sqlite-shm|md|csv|json|log|tmp|part)$'",
        "soulseek:",
        f"  username: {q(username)}",
        f"  password: {q(password)}",
        f"  listen_port: {args.listen_port}",
        "  description: 'House and techno. Sharing my downloads.'",
        "web:",
        "  port: 5030",
        "  ip_address: 127.0.0.1",
        "  https:",
        "    disabled: true",
        "  authentication:",
        "    username: slskd",
        f"    password: {q(ui_password)}",
        "    api_keys:",
        "      dj_fetch:",
        f"        key: {q(api_key)}",
        "        role: administrator",
        "        cidr: 127.0.0.1/32,::1/128",
        "",
    ]
    YML.write_text("\n".join(lines))
    YML.chmod(0o600)
    log(f"wrote {YML} (web UI user slskd, password in that file)")


def read_api_key():
    m = re.search(r"dj_fetch:\s*\n\s*key:\s*'([^']+)'", YML.read_text())
    return m.group(1) if m else None


def write_launchd(listen_port):
    upnpc = shutil.which("upnpc") or "/opt/homebrew/bin/upnpc"
    WRAPPER.write_text(f"""#!/bin/sh
# Map the Soulseek listen port on the router (best effort), then run slskd.
if [ -x {upnpc} ]; then {upnpc} -e slskd -r {listen_port} TCP >/dev/null 2>&1 || true; fi
exec {BIN} --app-dir {APP_DIR}
""")
    WRAPPER.chmod(0o755)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    with PLIST.open("wb") as f:
        plistlib.dump({
            "Label": LABEL,
            "ProgramArguments": ["/bin/sh", str(WRAPPER)],
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 30,
            "StandardOutPath": str(APP_DIR / "logs/launchd.out.log"),
            "StandardErrorPath": str(APP_DIR / "logs/launchd.err.log"),
        }, f)
    (APP_DIR / "logs").mkdir(parents=True, exist_ok=True)
    log(f"wrote {PLIST}")


def start():
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(PLIST)], check=True)
    log("started slskd; waiting for it to log in")


def wait_logged_in(api_key, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            req = urllib.request.Request("http://127.0.0.1:5030/api/v0/server", headers={"X-API-Key": api_key})
            state = json.load(urllib.request.urlopen(req, timeout=5))
            if state.get("isLoggedIn"):
                log(f"slskd is connected and logged in ({state.get('state')})")
                return True
        except Exception:
            pass
        time.sleep(3)
    log("slskd didn't report a login in time; check ~/.local/share/slskd/logs")
    return False


def write_dj_config(api_key, library_root):
    zen = HOME / "Library/Application Support/zen"
    profile = ""
    ini = zen / "profiles.ini"
    if ini.exists():
        cp = configparser.RawConfigParser()
        cp.read(ini)
        for sec in cp.sections():
            if sec.startswith("Install") and cp.has_option(sec, "Default"):
                profile = str(zen / cp.get(sec, "Default"))
    have = [str(p) for p in (ICLOUD_MUSIC,) if p.exists()]
    DJ_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    DJ_CONFIG.write_text(f"""# Machine settings for dj-fetch (preferences live in the skill's preferences.toml).
library_root = {json.dumps(str(library_root))}
# Folders already holding tracks; matching files are not downloaded again.
have_dirs = {json.dumps(have)}

[slskd]
url = "http://127.0.0.1:5030"
api_key = {json.dumps(api_key)}
downloads_dir = {json.dumps(str(library_root / '.incoming'))}

[soundcloud]
# Browser whose SoundCloud login yt-dlp uses for free downloads.
browser = "firefox"
profile = {json.dumps(profile)}
""")
    DJ_CONFIG.chmod(0o600)
    log(f"wrote {DJ_CONFIG}")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--version", default="latest", help="slskd release tag (default: latest)")
    p.add_argument("--username")
    p.add_argument("--password")
    p.add_argument("--listen-port", type=int, default=2234)
    p.add_argument("--library-root", default=str(HOME / "Music/DJ Fetch"))
    p.add_argument("--rewrite", action="store_true", help="rewrite slskd.yml and the dj-fetch config")
    p.add_argument("--no-start", action="store_true", help="install and configure without starting slskd")
    args = p.parse_args()

    library_root = Path(args.library_root).expanduser()
    APP_DIR.mkdir(parents=True, exist_ok=True)
    install_binary(args.version)
    if args.rewrite or not YML.exists():
        user, pw = args.username, args.password
        if not (user and pw):
            user, pw = existing_credentials()
        if not (user and pw):
            sys.exit("No Soulseek credentials: pass --username and --password")
        write_yml(args, user, pw, secrets.token_urlsafe(32), library_root)
    else:
        log(f"keeping existing {YML}")
    api_key = read_api_key()
    if not api_key:
        sys.exit(f"no dj_fetch API key in {YML}; rerun with --rewrite")
    if args.rewrite or not DJ_CONFIG.exists():
        write_dj_config(api_key, library_root)
    write_launchd(args.listen_port)
    if not args.no_start:
        start()
        wait_logged_in(api_key)


if __name__ == "__main__":
    main()
