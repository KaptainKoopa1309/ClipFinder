"""Clips Finder command line: find CODM multi-kill streaks in a recording and cut them into clips."""
import argparse
import json
import math
import tempfile
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime
from pathlib import Path
from ramp import speed_segments, cut_ramped
from video_analysis import (scan_video, locate_counter, locate_minimap, locate_hp_bar, HP_LEVEL, away_ranges, match_end_readings, combo_death_ranges, NAME_MATCH, death_ranges, hp_death_ranges, merge_ranges,
                            separate_lives, SCANNER_VERSION, COUNTER_LAYOUTS, locate_combo_shift)
import live_analysis as live

ROOT = Path(__file__).resolve().parent


def save_output(path, text):
    """Replace a complete output, or retain a new copy when the target is locked."""
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='',
                                     dir=path.parent, prefix=path.stem+'_',
                                     suffix='.tmp', delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(text)
    try:
        try:
            temporary.replace(path)
        except PermissionError:
            alternative = path.with_name(
                f'{path.stem}_{datetime.now():%Y%m%d_%H%M%S_%f}_{temporary.stem}{path.suffix}')
            temporary.replace(alternative)
            print(f'Could not replace {path.name} (it may be open in another app). Saved: {alternative}')
            return alternative
        return path
    finally:
        temporary.unlink(missing_ok=True)


def timestamp(seconds):
    milliseconds = round(seconds*1000)
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f'{hours:02}:{minutes:02}:{seconds:02}.{milliseconds:03}'


def monotonic_runs(runs):
    """Best-supported non-decreasing run of kill counts; misread digits fall out."""
    if not runs:
        return runs
    best = [r['samples'] for r in runs]
    previous = [None]*len(runs)
    for i, run in enumerate(runs):
        for j in range(i):
            if runs[j]['count'] <= run['count'] and best[j]+run['samples'] > best[i]:
                best[i], previous[i] = best[j]+run['samples'], j
    i = max(range(len(runs)), key=best.__getitem__)
    kept = []
    while i is not None:
        kept.append(runs[i])
        i = previous[i]
    return kept[::-1]


def detect_events(readings, max_observation_gap=2.0, max_unseen_gap=8.0):
    """Require repeated counter readings; never invent individual kills in unseen gaps."""
    runs = []
    for reading in readings:
        value = reading.get('count')
        if value is None or not 0 <= value <= 200:
            continue
        t = reading['time']
        if runs and value == runs[-1]['count'] and t-runs[-1]['last'] <= max_observation_gap:
            runs[-1]['last'] = t
            runs[-1]['samples'] += 1
        else:
            runs.append(dict(count=value, first=t, last=t, samples=1))
    stable = monotonic_runs([r for r in runs if r['samples'] >= 2])
    events, warnings = [], []
    previous = None
    segment = 0
    for run in stable:
        if previous is None:
            previous = run
            continue
        delta = run['count'] - previous['count']
        gap = run['first'] - previous['last']
        if delta == 0:
            previous = run
            continue
        # A small rise across a short unreadable stretch is still a kill.
        unseen_ok = delta <= 2 and gap <= max_unseen_gap
        if delta < 0 or delta > 4 or (gap > max_observation_gap and not unseen_ok):
            warnings.append(dict(start=previous['last'], end=run['first'],
                                 before=previous['count'], after=run['count'],
                                 reason='Counter reset, OCR anomaly, or unobserved interval'))
            segment += 1
        else:
            events.append(dict(time=run['first'], earliest=previous['last'],
                               count=delta, total=run['count'], segment=segment))
        previous = run
    return events, warnings


OPTIONAL_LIMITS = ('window', 'max_gap')   # null in settings.json (or "none" on the command line): no limit


def limit(text):
    """A seconds limit for --window / --max-gap; "none" means no limit."""
    return None if str(text).strip().lower() in ('none', 'null', 'off') else float(text)


def find_clips(events, duration, min_kills=4, window=25., max_gap=16., pre=3., post=3., excluded=()):
    """One clip per run of min_kills+ kills within a life; a window or max_gap of None is no limit."""
    windows = []
    for i, first in enumerate(events):
        kills = 0
        for j in range(i, len(events)):
            event = events[j]
            if event['segment'] != first['segment'] or (window is not None and event['time']-first['time'] > window):
                break
            if j > i and max_gap is not None and event['time']-events[j-1]['time'] > max_gap:
                break
            kills += event['count']
            if kills >= min_kills:
                windows.append((i, j))
    merged = []
    for start, end in windows:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    clips = []
    for i, j in merged:
        selected = events[i:j+1]
        start = max(0, selected[0]['earliest']-pre)
        end = min(duration, selected[-1]['time']+post)
        for span in excluded:
            if span['end'] < selected[0]['earliest']:
                start = max(start, span['end'])
            if span['start'] >= selected[-1]['earliest']:
                # A trade (the death starts within a reading of the last kill showing): end just after the kill.
                last = selected[-1]
                trade = span['start'] <= last['time'] and span['start']-last['earliest'] <= .55
                end = min(end, last['time']+.1 if trade else span['start'])
        clips.append(dict(id=len(clips)+1, start=round(start,3), end=round(end,3),
                          start_timestamp=timestamp(start), end_timestamp=timestamp(end),
                          kills=sum(e['count'] for e in selected),
                          action_span=round(selected[-1]['time']-selected[0]['earliest'],3),
                          kill_times=[e['time'] for e in selected],
                          counter_before=selected[0]['total']-selected[0]['count'],
                          counter_after=selected[-1]['total']))
    return clips


def format_report(video, args, clips, excluded, warnings, event_count, deaths=None):
    lines = [f'Video: {video.resolve()}',
             f'Recording: {"live (killfeed)" if deaths is not None else "replay (spectator HUD)"}',
             f'Rule: {args.min_kills}+ kills '
             +(f'within {args.window:g}s' if args.window is not None else 'in one life')
             +(f'; maximum kill gap {args.max_gap:g}s' if args.max_gap is not None else '; no maximum gap between kills'),
             f'Padding: {args.pre:g}s before / {args.post:g}s after (clamped at excluded intervals)',
             f'Cut speed: {args.speed:g}x; gaps over {args.ramp_gap:g}s between kills at {args.ramp_speed:g}x '
             f'({args.ramp_keep:g}s kept around each kill)',
             f'Kills observed: {event_count}; candidate clips: {len(clips)}']
    if deaths is None:
        lines[5:5] = [f'Death exclusion: {args.death_guard:g}s before / {args.respawn_settle:g}s after each suspected respawn',
                      f'Visual thresholds: scene={args.scene_threshold:g}, minimap={args.minimap_threshold:g}, map shift={args.map_shift:g}']
    else:
        lines.insert(5, f"Death exclusion: from each death until the player's own view is back, plus {args.respawn_settle:g}s")
    if deaths is not None:
        lines.append(f'Deaths observed: {len(deaths)} (killfeed and killcams): '
                     + ', '.join(timestamp(t) for t in deaths))
    lines += ['', 'CLIP TIMESTAMPS']
    for clip in clips:
        lines.append(f"{clip['id']:02}. {clip['start_timestamp']} --> {clip['end_timestamp']} | {clip['kills']} kills"
                     )
    if not clips:
        lines.append('No clips meet these settings without crossing a suspected death/respawn.')
    lines += ['', 'EXCLUDED DEATH INTERVALS']
    for span in excluded:
        if deaths is not None:
            reason = 'killcam or spectating from ' if span.get('away') else 'death at '
        else:
            reason = 'player off the panel (dead or between rounds) from ' if span.get('away') else 'death/respawn at '
        lines.append(f"{timestamp(span['start'])} --> {timestamp(span['end'])} | {reason}"
                     + ', '.join(timestamp(t) for t in span['cuts']))
    if not excluded:
        lines.append('None detected. This does not prove there were no deaths.')
    lines += ['', f'Uncertain counter transitions: {len(warnings)}',
              'Scene/minimap discontinuities are heuristic: missed deaths and false splits are possible.',
              'Review the candidate timestamps before using them.']
    return '\n'.join(lines)+'\n'


FORMATS = ('auto', 'replay', 'live')


def parse_args():
    preliminary = argparse.ArgumentParser(add_help=False)
    preliminary.add_argument('--config', type=Path, default=ROOT/'settings.json')
    known, _ = preliminary.parse_known_args()
    parser = argparse.ArgumentParser(description=__doc__, parents=[preliminary])
    parser.add_argument('video', type=Path, help='A video file, or a folder to process every video in it')
    parser.add_argument('--output', type=Path, default=ROOT/'analysis',
                        help='Folder for <video>_timestamps.txt files (default: analysis)')
    parser.add_argument('--clips-dir', type=Path, default=ROOT/'clips',
                        help='Folder for the cut clips (default: clips)')
    parser.add_argument('--no-clips', action='store_true', help='Only write timestamps; do not cut clips')
    parser.add_argument('--jobs', type=int, default=1, help='Videos to process at the same time (default 1)')
    parser.add_argument('--reuse-readings', action='store_true', help='Reuse cached counter and respawn measurements')
    definitions = dict(min_kills=(int,4), window=(limit,25.), max_gap=(limit,16.),
                       pre=(float,3.), post=(float,3.), interval=(float,.5),
                       scene_threshold=(float,.12), minimap_threshold=(float,.07),
                       map_shift=(float,.18), death_guard=(float,4.), respawn_settle=(float,.5),
                       speed=(float,1.), ramp_gap=(float,8.), ramp_keep=(float,2.), ramp_speed=(float,2.5))
    for name, (kind, default) in definitions.items():
        parser.add_argument('--'+name.replace('_','-'), type=kind, default=default)
    parser.add_argument('--roi', nargs='+', default='auto',
                        help='Kill counter X1 Y1 X2 Y2, or auto to detect the HUD layout in each video (default)')
    parser.add_argument('--minimap-roi', nargs='+', default='auto',
                        help='X1 Y1 X2 Y2, or auto to find the minimap in each video (default)')
    parser.add_argument('--hp-roi', nargs='+', default='auto',
                        help='X1 Y1 X2 Y2, or auto to find the HP bar in each video (default)')
    parser.add_argument('--visual-deaths', action='store_true',
                        help='Also exclude suspected respawns from scene/minimap cuts (noisy; HP-bar deaths are always used)')
    parser.add_argument('--format', choices=FORMATS, default='auto',
                        help='Recording type: replay (spectator HUD), live (screen recording), or auto to detect it (default)')
    try:
        settings=json.loads(known.config.read_text(encoding='utf-8-sig'))
        if not isinstance(settings,dict) or set(settings)-set(definitions)-{'roi','minimap_roi','hp_roi','format'}:
            raise ValueError('Settings must be an object with supported parameter names.')
        for name,value in settings.items():
            if name=='format':
                if value not in FORMATS:
                    raise ValueError(f'format must be one of: {", ".join(FORMATS)}.')
            elif name in definitions:
                if value is None and name in OPTIONAL_LIMITS:
                    continue
                if isinstance(value,bool) or not isinstance(value,(int,float)):
                    raise ValueError(f'{name} must be numeric.')
                if name=='min_kills' and not isinstance(value,int):
                    raise ValueError('min_kills must be an integer.')
            elif name in ('roi','minimap_roi','hp_roi') and value=='auto':
                continue
            elif not isinstance(value,list) or len(value)!=4 or any(isinstance(v,bool) or not isinstance(v,(int,float)) for v in value):
                raise ValueError(f'{name} must contain four numeric coordinates.')
        parser.set_defaults(**settings)
    except (OSError,ValueError) as exc:
        parser.error(f'Cannot load settings: {exc}')
    args=parser.parse_args()
    if not args.video.exists():
        parser.error(f'Video does not exist: {args.video}. Put your recording in '
                     'the downloads folder and run from inside Clips_Farming, '
                     'for example: python main.py "downloads/Match 1.mp4"')
    for folder in (args.output, args.clips_dir):
        if not folder.resolve().is_relative_to(ROOT):
            parser.error('Output and clips folders must be inside Clips_Farming.')
    numeric=[getattr(args,name) for name in definitions if getattr(args,name) is not None]
    if not all(math.isfinite(v) for v in numeric):
        parser.error('Settings must contain finite numbers.')
    if args.min_kills<2 or min(v for v in (args.interval,args.window,args.max_gap,args.speed,args.ramp_speed,args.jobs) if v is not None)<=0 or min(args.pre,args.post,args.death_guard,args.respawn_settle)<0:
        parser.error('min-kills >= 2; intervals and speed > 0; padding/guards >= 0.')
    if not all(0 < getattr(args,name) <= 1 for name in ['scene_threshold','minimap_threshold','map_shift']):
        parser.error('Detection thresholds must be greater than zero and at most one.')
    for name in ('roi','minimap_roi','hp_roi'):
        value=getattr(args,name)
        if value in ('auto',['auto']):
            setattr(args,name,'auto')
            continue
        try:
            value=[float(v) for v in value]
        except (TypeError,ValueError):
            value=[]
        if len(value)!=4:
            parser.error(f"--{name.replace('_','-')} takes four numbers or auto.")
        setattr(args,name,value)
    for roi in [r for r in (args.roi,args.minimap_roi,args.hp_roi) if r!='auto']:
        x1,y1,x2,y2=roi
        if not (0<=x1<x2<=1 and 0<=y1<y2<=1):
            parser.error('ROIs must be normalized X1 Y1 X2 Y2 within 0..1.')
    return parser,args


VIDEO_TYPES = {'.mp4', '.mov', '.mkv', '.avi', '.webm'}


def cut_clips(video, clips, clips_dir, speed=1., ramp_gap=8., ramp_keep=2., ramp_speed=2.5):
    """Cut each clip into clips_dir, speeding up long gaps between kills (see ramp.py)."""
    clips_dir.mkdir(parents=True, exist_ok=True)
    made = []
    for clip in clips:
        name = f"{video.stem}_clip{clip['id']:02}_{clip['start_timestamp'][:8].replace(':','-')}.mp4"
        target = clips_dir/name
        pieces = speed_segments(clip['start'], clip['end'], clip['kill_times'], speed,
                                ramp_gap, ramp_keep, ramp_speed)
        cut_ramped(video, pieces, target)
        made.append(target)
        print(f'  cut {name}', flush=True)
    return made

def add_match_end(video, cached, interval=.5):
    """Splice a won match's final kills (shown on the replay-layout panel) into cached['readings'].
    Returns (final readings, time of the HUD switch)."""
    final,switch=match_end_readings(video,cached,interval)
    if final:
        last_final=final[-1]['time']
        cached['readings']=([r for r in cached['readings'] if r['time']<=switch]+final+
                            [r for r in cached['readings'] if r['time']>last_final])
    return final,switch


def scan_live_video(video):
    """Live recordings: find the killfeed, scan it, learn the player's name, then follow their rows."""
    feed=live.locate_killfeed(video)
    canvas,feed_canvas=feed['canvas'],feed['feed_canvas']
    print(f'Game picture: {canvas["rect"]} of the frame, read at {canvas["size"][0]}x{canvas["size"][1]}'
          +(f' (width corrected x{canvas["stretch"]:g}: the recording stretched it)' if canvas.get('stretch',1)!=1 else '')
          +(f'; killfeed rescaled to {feed_canvas["size"][0]}x{feed_canvas["size"][1]}'
            if feed_canvas['size']!=canvas['size'] else ''), flush=True)
    print(f'Killfeed: {feed["box"]} ({feed["rows"]} rows, {feed["pitch"]:g} px apart)', flush=True)
    if feed.get('counter'):
        print(f'Points counter: {feed["counter"]} (read in {feed["counter_frames"]} of {feed["samples"]} frames); '
              f'streak icons {"read" if feed["icons"] else "not read (not in the reference layout)"}', flush=True)
    else:
        print('Points counter: not found; kills come from the score popups and the killfeed', flush=True)
    scan,feed_data=live.scan_live(video,live.INTERVAL,feed)
    template=live.learn_name(feed_data)
    feed_kills,feed_deaths=live.follow_feed(scan,feed_data,template)
    streaks=live.load_streaks()
    counter=live.counter_kills(scan['readings'],streaks['costs'],streaks['kill_points'])
    popups=sum(n for _,n in live.popup_events(scan['readings']))
    kills=live.fuse_kills(scan['readings'],feed_kills,live.death_times(scan['readings'],feed_deaths),streaks)
    print(f'Kills: points counter {len(counter)} ({" / ".join(streaks["names"])}), score popups {popups}, '
          f'killfeed {len(feed_kills)}; combined {len(kills)}'
          +('' if live.counter_readable(scan['readings']) else ' (points counter not readable)'),flush=True)
    return dict(scan,kills=kills,feed_kills=feed_kills,feed_deaths=feed_deaths,name=template.round(3).tolist())


def finish_live(video, args, cached):
    deaths=live.death_times(cached['readings'],cached['feed_deaths'])
    events=live.live_events(cached['kills'],live.INTERVAL)
    excluded=merge_ranges(live.live_ranges(cached['readings'],deaths,args.respawn_settle))
    lives=separate_lives(events,excluded)
    clips=find_clips(lives,cached['duration'],args.min_kills,args.window,
                     args.max_gap,args.pre,args.post,excluded)
    result=save_output(args.output.resolve()/f'{video.stem}_timestamps.txt',
                       format_report(video,args,clips,excluded,[],len(events),deaths))
    print(f'{video.name}: {len(events)} kills; {len(deaths)} deaths; {len(clips)} candidates.')
    print(f'Timestamps: {result}')
    if clips and not args.no_clips:
        cut_clips(video,clips,args.clips_dir.resolve(),args.speed,args.ramp_gap,args.ramp_keep,args.ramp_speed)


def process(video, args):
    if args.jobs>1:
        print(f'=== {video.name} ===', flush=True)
    output=args.output.resolve()
    cache_dir=output/'cache'
    cache_dir.mkdir(parents=True,exist_ok=True)
    stat=video.stat()
    source=dict(video=str(video.resolve()),size=stat.st_size,mtime_ns=stat.st_mtime_ns,
                roi=args.roi,minimap_roi=args.minimap_roi,hp_roi=args.hp_roi,interval=args.interval,
                scene_threshold=args.scene_threshold,minimap_threshold=args.minimap_threshold,
                scanner_version=SCANNER_VERSION)
    cache_path=cache_dir/f'{video.stem}.json'
    kind=args.format
    if args.reuse_readings:
        if not cache_path.exists():
            raise ValueError('No compatible scan cache. Run once without --reuse-readings to measure respawns.')
        cached=json.loads(cache_path.read_text(encoding='utf-8'))
        scanned=dict(cached.get('source',{}))
        if kind=='auto':
            kind=scanned.get('format','replay')
        if kind=='live':
            source.update(format='live',live_version=live.LIVE_VERSION,interval=live.INTERVAL)
        scan_scene=scanned.pop('scene_threshold',None); scan_map=scanned.pop('minimap_threshold',None)
        wanted=dict(source); wanted.pop('scene_threshold'); wanted.pop('minimap_threshold')
        if scanned!=wanted or scan_scene is None or args.scene_threshold<scan_scene or args.minimap_threshold<scan_map:
            raise ValueError('Cache does not match this video or sampling settings. Run without --reuse-readings.')
    else:
        counter=None
        if kind=='auto':
            # Replay recordings always show the spectator kill counter; live recordings never do.
            try:
                counter=locate_counter(video) if args.roi=='auto' else locate_counter(video,layouts=[args.roi])
                kind='replay'
            except ValueError:
                kind='live'
            print(f'Recording type: {kind}', flush=True)
        if kind=='live':
            source.update(format='live',live_version=live.LIVE_VERSION,interval=live.INTERVAL)
            cached=scan_live_video(video)
            cached['source']=source
            saved=save_output(cache_path,json.dumps(cached))
            if saved!=cache_path:
                print('Cache was locked; future --reuse-readings may still read the previous scan.')
            return finish_live(video,args,cached)
        roi,name_reference=counter or (locate_counter(video) if args.roi=='auto' else locate_counter(video,layouts=[args.roi]))
        minimap_roi=locate_minimap(video) if args.minimap_roi=='auto' else args.minimap_roi
        hp_roi,hp_level=locate_hp_bar(video) if args.hp_roi=='auto' else (args.hp_roi,HP_LEVEL)
        # Round panels: the COMBO text (deaths reset it to 0) can sit a little off in some recordings.
        combo_shift=locate_combo_shift(video) if list(roi)==list(COUNTER_LAYOUTS[1]) else (0.,0.)
        print(f'Kill counter: {roi}; minimap: {minimap_roi}; HP bar: '
              f'{f"{hp_roi} (lit above {hp_level})" if hp_roi else "none (deaths come from the player panel)"}'
              f'{f"; COMBO offset {combo_shift}" if any(combo_shift) else ""}', flush=True)
        cached=scan_video(video,args.interval,roi,minimap_roi,
                          args.scene_threshold,args.minimap_threshold,hp_roi,name_reference,hp_level,combo_shift)
        cached['source']=source
        saved=save_output(cache_path,json.dumps(cached))
        if saved!=cache_path:
            print('Cache was locked; future --reuse-readings may still read the previous scan.')
    if kind=='live':
        return finish_live(video,args,cached)
    final,switch=add_match_end(video,cached,args.interval)
    if final:
        print(f'End of match: read {len(final)} replay-panel counts (final count {final[-1]["count"]}).')
    # Only count the followed player's kills; anyone else on the panel means they are dead or not shown.
    followed=[r for r in cached['readings'] if r.get('who',1)>=NAME_MATCH]
    events,warnings=detect_events(followed)
    hp_deaths=hp_death_ranges(cached['readings'],args.respawn_settle,checks=cached.get('respawn_checks',[]),
                              guard=args.death_guard,map_shift=args.map_shift)
    visual=death_ranges(cached['transitions'],cached['duration'],args.scene_threshold,
                        args.minimap_threshold,args.death_guard,args.respawn_settle,args.map_shift) if args.visual_deaths else []
    away=away_ranges(cached['readings'],args.respawn_settle)
    combo=combo_death_ranges(cached['readings'],args.respawn_settle)
    excluded=merge_ranges(hp_deaths,away,combo,visual)
    play_end=cached['duration']
    if final:
        # A won match switches to the end-of-match replay after the final kill: stop there.
        play_end=final[0]['time']+.75
        excluded=[s for s in excluded if s['start']<switch]
    live_events=separate_lives(events,excluded)
    clips=find_clips(live_events,play_end,args.min_kills,args.window,args.max_gap,
                     args.pre,args.post,excluded)
    result=save_output(output/f'{video.stem}_timestamps.txt',format_report(video,args,clips,excluded,warnings,len(events)))
    print(f'{video.name}: {len(events)} counter increases; {len(excluded)} excluded intervals; {len(clips)} candidates.')
    print(f'Timestamps: {result}')
    if clips and not args.no_clips:
        cut_clips(video,clips,args.clips_dir.resolve(),args.speed,args.ramp_gap,args.ramp_keep,args.ramp_speed)


def main():
    parser,args=parse_args()
    if args.video.is_dir():
        videos=sorted(p for p in args.video.iterdir() if p.suffix.lower() in VIDEO_TYPES)
        if not videos:
            parser.error(f'No videos found in {args.video}.')
    else:
        videos=[args.video]
    failed=[]
    if args.jobs>1 and len(videos)>1:
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            futures={video:pool.submit(process,video,args) for video in videos}
            for video,future in futures.items():
                try:
                    future.result()
                except (OSError,ValueError) as exc:
                    print(f'FAILED {video.name}: {exc}')
                    failed.append(video.name)
        if failed:
            print('Failed videos: '+', '.join(failed))
        return
    for video in videos:
        print(f'=== {video.name} ===', flush=True)
        try:
            process(video,args)
        except (OSError,ValueError) as exc:
            if len(videos)==1:
                parser.error(str(exc))
            print(f'FAILED {video.name}: {exc}')
            failed.append(video.name)
    if failed:
        print('Failed videos: '+', '.join(failed))


if __name__=='__main__':
    main()
