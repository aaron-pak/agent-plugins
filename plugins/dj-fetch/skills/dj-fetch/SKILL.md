---
name: dj-fetch
description: Get DJ-ready tracks for Aaron from a tracklist, playlist, 1001Tracklists export or a few named songs. Finds the extended version (however it's labeled) using Beatport lengths, takes free SoundCloud downloads, and gets the rest from Soulseek through slskd. Use whenever Aaron asks to download, find, grab or get tracks or songs, fill gaps in a list, or work with Soulseek, Nicotine+, slskd or SoundCloud downloads.
---

# dj-fetch

You are Aaron's interface to Soulseek. He doesn't use Nicotine+; slskd runs headless on his MacBook as the always-on client (it also shares his downloads, which keeps the account in good standing), and you drive it through `scripts/djfetch.py`. Don't open Nicotine+ or click through any Soulseek GUI.

## Standing preferences and permissions

These are Aaron's decisions. Follow them without asking again.

- **Version.** Get the extended version of the track. It may be labeled Extended, Original, or nothing at all; the label doesn't matter. Beatport tells you which release is the extended (full-length) one and how long it is, and a file counts as right when its length matches. An unlabeled file of the right length is correct; a file called "Extended" of the wrong length is not.
- **Requested versions win.** "X (Y Remix)" means Y's remix, extended if Beatport has an extended one. Never substitute another remix, a radio edit, an intro/clean DJ-pool edit, a live recording or a radio-show/set rip.
- **SoundCloud-native tracks** (bootlegs, flips, edits, mashups and anything not on Beatport): take the uploader's free download from SoundCloud. If there are several versions, keep the extended one; otherwise keep what's there. Never rip a stream.
- **Free download gates** (Hypeddit, ToneDen and similar follow/like gates): you may complete them in Zen, where Aaron is signed in to SoundCloud and Google. Signing in with his accounts and accepting a site's terms to do it don't need his approval. Never pay for anything.
- **Browser.** Use Zen (via cua-driver) for anything that needs a browser session. The T3 browser can't do Google popups.
- **Formats.** AIFF/WAV/FLAC first, then MP3 320 or 256+ AAC. `preferences.toml` holds the exact order and thresholds.
- **Pacing.** Never exceed Soulseek's search pacing (25 searches per 220 s, shared by every process). djfetch enforces it; don't run searches any other way.
- **Where files go.** `~/Music/DJ Fetch/<list>/`: finished tracks at the top, `_review/` for near-misses, `_rejected/` for wrong versions, and `report.md`. Aaron imports the list folder into rekordbox himself.
- **Updates.** Start long runs in the background and report when they finish, with counts and the report link. Don't send progress messages unless something needs Aaron.

Tunable values (formats, length tolerance, version markers, pacing, peer timeouts) live in `preferences.toml` next to this file. Change them there.

## Running it

`djfetch.py` is a uv script; run it directly (`uv` fetches its dependencies).

```sh
D=<this skill's directory>/scripts
$D/djfetch.py doctor                                  # slskd logged in, Beatport reachable, cookies present
$D/djfetch.py run "John Summit 6mo" --input export.csv # any CSV with artist,title columns; extra columns are used if present
$D/djfetch.py run "Friday" --track "Dom Dolla - Dreamin" --track "John Summit - Shiver"
$D/djfetch.py status "John Summit 6mo"
```

- Turn whatever Aaron gives you into a CSV with `artist,title` (a 1001Tracklists export works as is; its `beatport` and `soundcloud` link columns make matching better), or pass `--track` lines. Pick a short list name; it becomes the folder.
- `run` is resumable and idempotent: rerun the same command to continue, add more `--input`/`--track` to grow a list, and add `--retry` to try again the tracks that ended missing, gated or in review.
- Tracks already in Aaron's library folders (`have_dirs` in `~/.config/dj-fetch/config.toml`, plus `--have <dir>`) are skipped when their length matches the target.
- For big lists run it in the background. Soulseek search pacing is the floor: about 7 searches a minute, and a track takes 1 to 4 searches. Transfers, Beatport and SoundCloud run alongside the searches.

### What it does per track

1. **Beatport:** finds the release (from the row's Beatport link, else search) and takes its extended version, the full-length one, whatever it's labeled, matching any requested remixer. Records its length, BPM and key.
2. **Library:** skips the track if a file with the right name and length is already there.
3. **SoundCloud** (tracks not on Beatport): downloads the uploader's free original file through yt-dlp with Zen's cookies. Reports a gate link if the download is gated.
4. **Soulseek:** searches with progressively looser queries, scores every returned file (the right length first, then format, then peers with free slots and short queues), and downloads from the best peers in turn. It cancels peers that stall or queue too long, checks each file's real length with ffprobe, and keeps only a match.

### When a track isn't found

Read `report.md`, then use the raw tools before telling Aaron it's unavailable:

```sh
$D/djfetch.py candidates "<list>" "shiver" --all     # every file Soulseek returned, with the reason each was rejected
$D/djfetch.py search "summit shiver" --artist "John Summit" --title "Shiver" --length 293   # one ad-hoc paced search
$D/djfetch.py pick "<list>" "shiver" --peer <user> --file '<full remote path>'           # download a copy you chose
```

Use judgment: try other spellings (Tokyo/Tokio, "&" vs "and", the remixer's alias), the title without the artist, or a peer's other files. When a rule in `preferences.toml` rejected a copy that's actually right, `pick` it, and change the rule if it's wrong in general. For gated SoundCloud downloads, complete the gate in Zen and move the file into the list folder. Then rerun `status` so the report is current.

## Setup and upkeep

- `scripts/setup_slskd.py` installs slskd (checksum-verified from GitHub), writes `~/.local/share/slskd/slskd.yml` (Soulseek login, local-only API key, shares) and `~/.config/dj-fetch/config.toml`, and starts it as the launchd agent `com.aaronpak.slskd` on listen port 2234, mapped with UPnP when possible. It's idempotent; `--rewrite` regenerates the configs.
- Only one client can use the Soulseek account at a time. If slskd logs "another client logged in using the same username", find and stop the other client (Nicotine+, Sockseek) rather than fighting it.
- slskd's web UI is at http://127.0.0.1:5030 (user `slskd`, password in `slskd.yml`) if Aaron ever wants to look. Logs are in `~/.local/share/slskd/logs/`.
- Restart: `launchctl kickstart -k gui/$UID/com.aaronpak.slskd`. Update: rerun `setup_slskd.py --version <tag>`.
