# Clips Farming - quick start

The browser version, which runs entirely on the user's device, is in `web/` (the deployable site); deploy that folder as static files (for example to Cloudflare Pages). After editing `settings.json` or `scorestreaks.json`, run `web_tools\export_hud_profile.py` and redeploy `web/`. This README covers the Python command-line tool, which runs the same detection locally.

This tool watches a CODM spectator recording and finds times when the player gets several kills close together. It writes the start and end times to a text file. It does not cut or download videos.

You only need this folder. The rest of the original project is not required.

## 1. Extract the folder

Extract the ZIP first. Open the extracted `Clips_Farming` folder in your terminal. Your terminal should be in the same folder as `main.py` and this README.

For example:

```powershell
cd "C:\Users\YourName\Downloads\Clips_Farming"
```

Use your own folder location in that command.

## 2. Install Python and the required packages

Use **Python 3.11 or 3.12**. On Windows, enable **Add Python to PATH** when installing Python.

On Windows, run these commands once:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

This creates a private Python environment for this tool. You do not need to activate it. The package installation needs an internet connection; video analysis runs locally.

On macOS or Linux, use:

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
```

The examples below use Windows commands. On macOS/Linux, replace `.\.venv\Scripts\python.exe` with `./.venv/bin/python`.

## 3. Put a video in downloads

Copy your downloaded recording into the **downloads** folder inside this package. For example:

```text
Clips_Farming/
  main.py
  README.md
  settings.json
  scorestreaks.json
  requirements.txt
  counter.py
  video_analysis.py
  live_analysis.py
  ramp.py
  assets/
  downloads/
    Match 1.mp4       <-- your video goes here
  analysis/           <-- results are written here
```

Videos are not included. Keep `assets` and the Python files with `main.py`; they are required.

**Check the recording type:** the tool reads two kinds of CODM recording and tells them apart by itself:

- **Replay** recordings, saved with the in-game Replay button, show the spectator HUD: a white cumulative kill count in the cyan panel at the bottom right and a minimap near the upper middle. Follow the same player throughout the recording.
- **Live** recordings, screen-recorded while playing, show the player's own HUD. Kills and deaths come from the killfeed: the recording player's name is drawn in gold there, as the killer (a kill) or the victim (a death); teammates are blue, so a teammate whose name is a letter away (PapiChoco next to PapuChoco) is not taken for the player. The tool finds the killfeed wherever the player has moved it (also over a see-through fire button, and with rows on dark bands over bright scenery), and learns the player's name from the recording. Nothing is set per player: black bars around the game picture (a 20:9 phone screen saved as 16:9, for example) are found and removed, the picture is read at 1080 rows whatever the file's resolution, a picture the recording stretched or squeezed is put back to its shape (the KILLCAM title, fixed game text, is matched at a range of widths), a killfeed set larger or smaller is rescaled, and name colours are judged against what is behind them, so see-through or tinted killfeed rows in other HUDs work too. The player's name is learned from where it shows gold, then also found by its shape where a highlighted row tints it another colour. Killcams and spectating are ignored, and each killcam counts as a death.

**Scorestreak points counter (live recordings).** The number next to the HP bar is the points still needed for the next scorestreak. Players can move it, so each recording finds it: during calibration the lower part of the screen is searched for a number the counter reader reads well, and the place it reads most often is the counter (the log says where, and in how many frames). Its digits are read against two renderings of the game's digits (bold and thin: devices draw them differently), picked by the digits' width; a number that loses digits (201 read as 1, a 0, a leading 0) is treated as a misread, and a value claiming more points than could have been earned since the last reading is skipped. Points earned in a life are that streak's cost minus the number shown; a kill adds 100 (125 for objective kills). Kills are decided from three layers, in order of trust: **1. the points counter** (each rise of a kill's points seen within 2 s of the last reading — after a longer gap Hardpoint score may have added up too; the kill that unlocks a streak counts only when that streak's icon above the HP bar lights, as players' streak costs differ, and the icons are only read where the reference layout has them), **2. the score popup** in the centre of the screen (a ~100 rise in its "+N": kills the counter could not show, such as one traded with a death or while a streak hides the HUD; only while the player's own HUD is on screen, so end-of-match replays don't count), **3. the killfeed** (a row with the player's name as killer that neither explains counts when the counter rose a little — streak kills give about 25 — when the player died right after, or when the counter could not be read). The streak costs come from `scorestreaks.json`:

```json
"loadout": "default",
"loadouts": {"default": [{"name": "Hunter Killer", "cost": 500}, {"name": "Predator Missile", "cost": 700}, {"name": "EMP Systems", "cost": 1000}]}
```

Add a loadout for each set of streaks you play with and set `"loadout"` to it. The website reads these from `web/live-profile.json`: after editing `scorestreaks.json`, run `web_tools\export_hud_profile.py` and redeploy `web/`. If the counter is not found in a recording, kills come from the score popups and the killfeed.

To skip the detection, set `"format"` in `settings.json` (or pass `--format replay` / `--format live`).

## 4. Run the analysis

From inside `Clips_Farming`, run:

```powershell
.\.venv\Scripts\python.exe main.py "downloads/Match 1.mp4"
```

Replace `Match 1.mp4` with your video's exact name. Keep the quotation marks if the name contains spaces.

Wait for the scan to finish. It prints its progress; long videos can take several minutes or longer depending on your computer. The first run must scan the video, so do not add `--reuse-readings` yet.

## 5. Read the result

Open:

```text
analysis/timestamps.txt
```

The tool creates `analysis` automatically. The text file lists each candidate's start time, end time, and kill count. It also lists suspected death/respawn intervals that were excluded. Times use `hours:minutes:seconds.milliseconds`.

Check these times in your video player. The tool has not created any cut clips.

The next run replaces this result file. If it is locked by another app, the tool saves a new name and prints its location.

## Change how clips are selected

Open **settings.json** in a text editor before running. Change the numbers and save it. Leave the quotes, commas, and brackets in place.

| Setting | Default | Meaning |
|---|---:|---|
| `min_kills` | 3 | How many kills are needed |
| `window` | null | How many seconds those kills can take; `null` = no limit (any 3+ kills in one life) |
| `max_gap` | null | Biggest allowed pause between kills, in seconds; `null` = no limit |
| `pre` | 3 | Extra seconds before the action |
| `post` | 3 | Extra seconds after the action |
| `death_guard` | 4 | Seconds to exclude before a suspected respawn |
| `respawn_settle` | 0.5 | Seconds to exclude after a suspected respawn |

For example, to look for **4 kills within 20 seconds**, with **no pause longer than 8 seconds**, set:

```json
"min_kills": 4,
"window": 20,
"max_gap": 8
```

Edit those existing lines; do not replace the whole settings file with this excerpt.

You can also change settings for just one run using flags:

```powershell
.\.venv\Scripts\python.exe main.py "downloads/Match 1.mp4" --min-kills 4 --window 20 --max-gap 8 --pre 2 --post 2
```

Flags override `settings.json` for that run (`--window none` / `--max-gap none` turn a limit off). Overlapping qualifying sequences are combined, so a finished clip can be longer than `window`. With both limits off, every life with 3+ kills becomes one clip, and the score (2 × kills^1.5 ÷ seconds from first to last kill) puts slow ones at the bottom. The website reads these rules from `web/hud-profile.json`: after editing `settings.json`, run `web_tools\export_hud_profile.py` and redeploy `web/`.

### Try different rules quickly

After a successful scan of the same video, add `--reuse-readings`:

```powershell
.\.venv\Scripts\python.exe main.py "downloads/Match 1.mp4" --reuse-readings --min-kills 5 --window 20 --max-gap 8
```

This reuses measurements in `analysis/cache` instead of watching the video again. You can change kill rules, padding, death guards, and `map_shift` this way.

Run without `--reuse-readings` when you change the video, move it, change the sampling interval, change either HUD crop, or change the scene/minimap thresholds. A new copy of this package has no cached measurements.

### Keep results for more than one video

Give each video its own output folder:

```powershell
.\.venv\Scripts\python.exe main.py "downloads/Match 1.mp4" --output analysis/match_1
.\.venv\Scripts\python.exe main.py "downloads/Match 2.mp4" --output analysis/match_2
```

Each folder gets its own `timestamps.txt` and cache. Include the same `--output` when reusing that video's measurements.

## How deaths are handled

**Live recordings:** a death is the player's gold name on the victim side of a killfeed row, or a killcam (it starts about 2 seconds after the death). The excluded interval runs from the death until the player's own view is back. The report lists every death.

**Replay recordings:** the tool looks for a sudden scenery change together with a minimap change. It tries to allow for normal camera rotation. Suspected respawns split kill sequences, and the extra seconds around a clip cannot cross an excluded interval.

This is an estimate. Some deaths may be missed, and fast camera movements may cause false exclusions. Review the results before using them. The default four-second guard estimates the death animation before the respawn; it is not an exact death timestamp.

## Advanced settings - usually leave these alone

| Setting | Default | Meaning |
|---|---:|---|
| `format` | auto | `auto`, `replay` or `live` |
| `interval` | 0.5 | Seconds between kill-counter checks in replay recordings; smaller values do more work. Live recordings are always read every 0.25 s |
| `scene_threshold` | 0.12 | Minimum scenery change needed to investigate a respawn |
| `minimap_threshold` | 0.07 | Minimum minimap change needed to investigate a respawn |
| `map_shift` | 0.18 | Minimum minimap relocation after rotation compensation |
| `roi` | In settings.json | Rectangle containing the kill counter |
| `minimap_roi` | In settings.json | Rectangle containing the minimap |

Both scene/minimap thresholds must be met. Smaller thresholds usually detect more changes, including more false alarms. Crops use `[left, top, right, bottom]` fractions between 0 and 1. Timestamps are approximate to the sampling interval.

## Common problems

- **Python command not found:** install Python 3.11 or 3.12, then reopen your terminal. If `py -3` is unavailable but `python` works, use `python -m venv .venv`.
- **No module named cv2 or numpy:** run the package-install command from step 2, then use the `.venv` Python command shown above.
- **Video does not exist:** check its exact name, include `.mp4`, and make sure your terminal is inside `Clips_Farming`.
- **No compatible cache / cache does not match:** remove `--reuse-readings` and run again.
- **No clips found:** try a lower `min_kills` or larger `window`/`max_gap`. Also check that the video uses the supported HUD layout.
- **Website: "decoding error" or nothing found (often on phones):** many phones save recordings upright (for example 1080x2354) with a rotation tag. Some hardware decoders refuse frames that tall, so the page starts again once with the browser's software decoder (slower); the log says so. If that fails too, try the recording on a computer.
- **Want to reset everything:** you can delete `analysis` and run a fresh scan. This removes generated results and cached measurements, not your videos.

## Code map and debugging

| Part | Python (local tool) | Browser (`web/`) |
|---|---|---|
| Command line / page | `main.py` | `index.html`, `js/app.js`, `css/style.css` |
| Scan, run in the background | `main.py` (`process`, `scan_live_video`) | `js/worker.js`, `js/scan-worker.js` |
| Reading the video | `video_analysis.py` (`scan_video`) | `js/video.js` |
| Replay HUD: kill counter, HP bar, minimap | `video_analysis.py`, `counter.py` | `js/hud.js`, `js/cv.js` |
| Replay kills, deaths, streaks | `main.py` (`detect_events`, `find_clips`) | `js/detect.js` |
| Live recordings: killfeed, points counter, popup | `live_analysis.py` | `js/live.js` |
| Cutting clips | `ramp.py` (re-encodes, speed ramps) | `js/video.js` (`cutClip`, copies packets) |

The browser code is a function-by-function port of the Python, with the same names in camelCase (`fuse_kills` -> `fuseKills`), so a fix in one goes into the other in the same place. The website reads its constants from `web/hud-profile.json` and `web/live-profile.json`, written by `web_tools/export_hud_profile.py`.

Debugging:

- **Python:** results go to `analysis/<video>_timestamps.txt`; `--no-clips` skips cutting. Each scan's readings are saved in `analysis/cache/<video>.json`, and `--reuse-readings` reruns kill detection and clip rules from that file without watching the video again.
- **Website:** the page shows short, friendly messages; the details go to the browser console (F12): each scan step as a `[scan]` debug message (turn on the Verbose level to see them), the full result, and any error with its stack. `window.clipsFinder` holds the page state. Adding `?parts=1` to the page address reads the recording in one part (no parallel workers), which is easier to follow.
- **Website text:** page wording is plain HTML in `web/index.html`, `contact.html`, `privacy.html` and `terms.html`; messages shown while it runs are in the `TEXT` block at the top of `web/js/app.js`; colours are at the top of `web/css/style.css`.
