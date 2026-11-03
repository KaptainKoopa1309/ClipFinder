<!--
  EDITING THIS README
  - Change any sentence freely; keep the lines that start with #, |, - or ``` as they are.
  - Replace the YOUR-... placeholders (website link, contact) with your own.
  - Comments like this one are hidden on GitHub.
-->

# ClipFinder

**Find every multi-kill streak in your Call of Duty: Mobile recordings and save each one as a clip.**

ClipFinder watches your match recording, reads your kills and deaths, and cuts out every life where you got several kills. Free, no sign-up, and your video never leaves your device.

**Try out the website:** [https://clipfinder.vrzorawarsingh.workers.dev/](https://clipfinder.vrzorawarsingh.workers.dev/)

---

## Features

- **Two supported recording types:** live match recordings (screen-recorded while playing) and Replay mode recordings.
-**Supports multiple videos:** you have the choice to select one video to scan, or multiple videos to scan at once, scanning multiple videos gives you a combined list of clips.
- **Adjustable Kill threshold:** choose the minimum kills a clip needs (3, 4, 5 and up).
- **Best clips first:** clips are ranked based on how many kills were done and how quickly they were performed.
- **Original quality:** clips are cut straight from your video, not re-encoded. 
- **Private:** everything runs in your browser. No video data is uploaded.
- **Preview and download:** watch each clip, download it individually, or all at once.

## Using the website

1. Open the website and click **Select Match Recording**.
2. Upload your video recordings, you can choose one video or multiple videos as you wish.
2. Select your recording type between **Live Match recording** or **Replay Mode recording**.
3. Pick the minimum number of kills a clip needs.
4. Click **Find clips** and keep the page open while it scans.
5. Preview your clips and download the ones you want.

Works best in **Chrome** or **Edge**, however it supports every browser.

## Running it on your computer

The same detection is also available as a Python command-line tool.

### Requirements

- Python 3.11 or 3.12

### Install

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
```

On macOS or Linux, use `.venv/bin/python` instead of `.venv/Scripts/python`.

### Run

Put your recording in the `downloads` folder, then run:

```bash
.venv/Scripts/python main.py "downloads/Match 1.mp4"
```

- Clips are saved to `clips/`.
- A list of timestamps is saved to `analysis/`.
- Pass a folder instead of a file to scan every video in it.

### Options

| Option | Default | What it does |
|---|---|---|
| `--min-kills` | 3 | Minimum kills a clip needs |
| `--pre` | 3 | Seconds kept before the first kill |
| `--post` | 3 | Seconds kept after the last kill |
| `--format` | auto | `auto`, `live` or `replay` |
| `--no-clips` | off | Only write timestamps, don't cut clips |
| `--reuse-readings` | off | Re-run the rules on a video scanned before, without watching it again |

Defaults live in `settings.json`. Run `python main.py --help` to see every option.

## Project structure

```text
web/                   The website (static files, deploy this folder)
  index.html           Main page
  contact.html         Contact page
  privacy.html         Privacy Policy
  terms.html           Terms of Use
  css/style.css        Colours and layout
  js/app.js            Page logic and all on-screen messages
  js/                  Detection code (a port of the Python tool)
main.py                Command-line tool
video_analysis.py      Replay recordings: kill counter and deaths
live_analysis.py       Live recordings: killfeed, points counter, score popups
settings.json          Clip rules
scorestreaks.json      Scorestreak costs
web_tools/             Exports the settings for the website
```

## For developers

- **Deploy:** the `web/` folder is a static site and can be hosted anywhere (for example Cloudflare Pages).
- **After editing `settings.json` or `scorestreaks.json`:** run `python web_tools/export_hud_profile.py`, then redeploy `web/`.
- **Website text:** page wording is in the HTML files; messages shown during a scan are in the `TEXT` block at the top of `web/js/app.js`.
- **Debugging the website:** open the browser console (F12). Scan details are logged as `[scan]` messages, and `window.clipsFinder` holds the page state. Add `?parts=1` to the address to scan in a single worker.
- **Code map:** the browser code mirrors the Python function by function, with the same names in camelCase (`fuse_kills` → `fuseKills`).

## Accuracy

Kill detection reads the game's HUD, so it is **not 100% accurate**. It can occasionally miss or misread a kill, especially with unusual HUD layouts or low-quality recordings. If that happens, please get in touch.

## Contact

<!-- Contact details -->
Found a bug or have a suggestion? Reach out:

- Email: vrzorawarsinghcod@gmail.com
- Instagram: [luigicodm_13](https://www.instagram.com/luigicodm_13/)
- Twitter/X: [Weegiethfc](https://x.com/Weegiethfc)

## License

Released under the [MIT License](LICENSE).

---

*Not affiliated with Activision. Call of Duty is a trademark of Activision Publishing, Inc.*
