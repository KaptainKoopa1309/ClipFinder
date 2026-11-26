# ClipFinder

Find every multi-kill streak in your COD Mobile Multiplayer recordings and download them as clips. It's free, there's no sign-up, and your videos never leave your device.

**Try it:** https://tryclipfinder.vercel.app

## How to use it

1. **Open the site** in Chrome or Edge on a computer or phone.
2. **Select your recordings.** Pick one match video or several at once (MP4 or MOV).
3. **Choose the recording type:**
   - **Live Match:** you recorded your own screen while playing.
   - **Replay Mode:** you recorded a match replay that shows the spectator kill counter.
4. **Set the minimum kills** for a clip (2 to 8, default 3).
5. **Click "Find clips"** and keep the page open while it scans.
6. **Review and download.** Each recording gets its own section. Preview the clips, then download the ones you want, or use **Download all**.

## Good to know

- Clips keep the original video quality.
- Clips are ordered by score. With several recordings you can also sort all clips by kills or length.
- Each recording shows the kills and deaths it found. Compare them with your match scoreboard. Detection can occasionally miss or misread a kill.
- "We couldn't find your name in the killfeed" usually means the recording is too short or too low quality.
- Large batches download as several ZIP files. If your browser asks to allow multiple downloads, click **Allow**.

## Run it locally

Needs Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev      # development server
npm run build    # production build in dist/
```

Pushes to `main` deploy to Vercel automatically (settings in `vercel.json`).

## License

MIT. See [LICENSE](LICENSE).
