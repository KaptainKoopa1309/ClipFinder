"""Replay recordings: kill counter, minimap and HP bar readings, and death detection."""
import time
from pathlib import Path
from collections import deque
import cv2
import numpy as np
from counter import CounterReader

SCANNER_VERSION = 8
TRANSITION_INTERVAL = .25


def map_motion(before, after, detector):
    """Estimate map relocation after compensating for camera/minimap rotation."""
    ka, da = detector.detectAndCompute(before, None)
    kb, db = detector.detectAndCompute(after, None)
    if da is None or db is None or len(db) < 2:
        return dict(map_shift=None, map_inliers=0, map_match_ratio=0.)
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(da, db, k=2)
    good = [pair[0] for pair in pairs if len(pair)==2 and pair[0].distance < .75*pair[1].distance]
    if len(good) < 4:
        return dict(map_shift=None, map_inliers=0, map_match_ratio=0.)
    a = np.float32([ka[m.queryIdx].pt for m in good])
    b = np.float32([kb[m.trainIdx].pt for m in good])
    matrix, mask = cv2.estimateAffinePartial2D(a,b,method=cv2.RANSAC,ransacReprojThreshold=3)
    if matrix is None:
        return dict(map_shift=None, map_inliers=0, map_match_ratio=0.)
    shift=float(np.linalg.norm(matrix@np.array([128,128,1])-np.array([128,128]))/256)
    return dict(map_shift=round(shift,5),map_inliers=int(mask.sum()),
                map_match_ratio=round(float(mask.mean()),5))


def crop(frame, roi):
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = roi
    return frame[int(h*y1):int(h*y2), int(w*x1):int(w*x2)]


HP_LEVEL = 215   # min-channel brightness a lit HP bar pixel exceeds in most recordings


def hp_fill(band, level=HP_LEVEL):
    """Fraction of the HP bar's width that is lit (about 1 when alive, about 0 when dead)."""
    return round(float((band.min(axis=2).max(axis=0) > level).mean()), 3)


def locate_minimap(video, samples=16, width=.16, top=.08, bottom=.29):
    """The minimap is the steadiest box in the top strip; its position differs between recordings."""
    capture = cv2.VideoCapture(str(video))
    duration = capture.get(cv2.CAP_PROP_FRAME_COUNT)/max(capture.get(cv2.CAP_PROP_FPS), 1)
    frames = []
    for t in np.linspace(min(30, duration*.1), max(duration-30, duration*.9), samples):
        capture.set(cv2.CAP_PROP_POS_MSEC, t*1000)
        ok, frame = capture.read()
        if ok:
            frames.append(frame)
    capture.release()
    if len(frames) < 4:
        raise ValueError(f'Cannot sample frames to locate the minimap: {video}')

    def unsteadiness(left):
        stack = [cv2.cvtColor(cv2.resize(crop(f, (left, top, left+width, bottom)), (64, 48)), cv2.COLOR_BGR2GRAY)
                 for f in frames]
        return float(np.stack(stack).astype(np.float32).std(axis=0).mean())
    left = float(min(np.arange(.20, .70, .01), key=unsteadiness))
    return [round(left, 3), top, round(left+width, 3), bottom]


HP_LAYOUTS = ([.39, .945, .61, .995],    # bar along the bottom edge (most recordings)
              [.365, .845, .595, .895])  # raised bar


def locate_hp_bar(video, samples=30):
    """(layout, level) of the HP bar that reads full most often, or (None, None)."""
    capture = cv2.VideoCapture(str(video))
    duration = capture.get(cv2.CAP_PROP_FRAME_COUNT)/max(capture.get(cv2.CAP_PROP_FPS), 1)
    frames = []
    for t in np.linspace(min(30, duration*.1), max(duration-30, duration*.9), samples):
        capture.set(cv2.CAP_PROP_POS_MSEC, t*1000)
        ok, frame = capture.read()
        if ok:
            frames.append(frame)
    capture.release()
    if not frames:
        return None, None

    def best(levels):
        scores = [float(np.percentile([hp_fill(crop(f, layout), level) for f in frames], 75))
                  for layout, level in zip(HP_LAYOUTS, levels)]
        i = int(np.argmax(scores))
        return i, scores[i]
    i, score = best([HP_LEVEL]*len(HP_LAYOUTS))
    if score >= .8:
        return list(HP_LAYOUTS[i]), HP_LEVEL
    levels = [min(HP_LEVEL, float(np.percentile(
        [np.median(crop(f, layout).min(axis=2).max(axis=0)) for f in frames], 75))-35) for layout in HP_LAYOUTS]
    i, score = best(levels)
    # A dim but real bar still peaks near 200; lower means no bar (round modes).
    return (list(HP_LAYOUTS[i]), round(levels[i], 1)) if score >= .8 and levels[i] >= 150 else (None, None)


COUNTER_LAYOUTS = ([.956, .918, .977, .949],   # respawn modes: panel at the bottom right
                   [.957, .746, .978, .777])   # round modes: taller panel with combo/damage rows


def name_roi(counter_roi):
    """The spectated player's name sits left of the kill count in the same panel."""
    return [.80, counter_roi[1], .90, counter_roi[3]]


def name_mask(frame, roi):
    return (cv2.resize(crop(frame, roi), (120, 24)).min(axis=2) > 170)


def mask_overlap(a, b):
    union = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum()/union) if union else 0.


def name_signature(frame, roi):
    """Blurred, normalised brightness of the name text (robust to compression jitter)."""
    g = cv2.GaussianBlur(cv2.resize(crop(frame, roi), (120, 24)).min(axis=2).astype(np.float32), (3, 3), 0)
    g -= g.mean()
    norm = np.linalg.norm(g)
    return g/norm if norm else g


def name_similarity(reference, signature):
    """About 0.9 for the followed player's name, about 0.7 for another name, below 0 for no panel."""
    return float((reference*signature).sum())


NAME_MATCH = .78


def locate_counter(video, samples=40, layouts=COUNTER_LAYOUTS):
    """Pick the counter layout that reads most often and learn the followed player's name."""
    reader = CounterReader()
    capture = cv2.VideoCapture(str(video))
    duration = capture.get(cv2.CAP_PROP_FRAME_COUNT)/max(capture.get(cv2.CAP_PROP_FPS), 1)
    frames = []
    for t in np.linspace(min(20, duration*.05), duration*.95, samples):
        capture.set(cv2.CAP_PROP_POS_MSEC, t*1000)
        ok, frame = capture.read()
        if ok:
            frames.append(frame)
    capture.release()
    hits = [[f for f in frames if reader.read(crop(f, layout))] for layout in layouts]
    best = int(np.argmax([len(h) for h in hits]))
    if len(hits[best]) < 5:
        raise ValueError(f'Cannot find a readable kill counter in {video}; this HUD layout is not supported.')
    roi = list(layouts[best])
    masks = [name_mask(f, name_roi(roi)) for f in hits[best]]
    support = [sum(mask_overlap(a, b) > .6 for b in masks) for a in masks]
    medoid = masks[int(np.argmax(support))]
    same = [f for f, m in zip(hits[best], masks) if mask_overlap(medoid, m) > .6]
    reference = np.mean([name_signature(f, name_roi(roi)) for f in same], axis=0)
    return roi, reference/np.linalg.norm(reference)


def _normalised(patch):
    g = cv2.resize(cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY), (16, 24)).astype(np.float32)
    g -= g.mean()
    norm = np.linalg.norm(g)
    return g/norm if norm else g


def combo_zero_score(frame, shift=(0., 0.)):
    """Round panels: about 0.6-0.75 when COMBO shows 0 (its 0 looks like the O beside it), lower otherwise."""
    sx, sy = shift
    letter = _normalised(crop(frame, (.8160+sx, .785+sy, .8245+sx, .806+sy)))
    return round(max(float((letter*_normalised(crop(frame, (.8275+sx+dx, .785+sy, .836+sx+dx, .806+sy)))).sum())
                     for dx in (-.002, -.001, 0, .001, .002)), 3)


COMBO_WORD = (.7859, .7843)   # where the word COMBO starts in the recordings combo_zero_score was made on
_combo_word = None


def locate_combo_shift(video, samples=40):
    """(x, y) offset of the COMBO text from its usual place, as frame fractions; (0, 0) if not found."""
    global _combo_word
    if _combo_word is None:
        _combo_word = cv2.imread(str(Path(__file__).resolve().parent/'assets'/'combo_word.png'),
                                 cv2.IMREAD_GRAYSCALE).astype(np.float32)
    capture = cv2.VideoCapture(str(video))
    duration = capture.get(cv2.CAP_PROP_FRAME_COUNT)/max(capture.get(cv2.CAP_PROP_FPS), 1)
    found = []
    for t in np.linspace(min(20, duration*.05), duration*.95, samples):
        capture.set(cv2.CAP_PROP_POS_MSEC, t*1000)
        ok, frame = capture.read()
        if not ok:
            continue
        h, w = frame.shape[:2]
        x0, y0 = int(.760*w), int(.770*h)
        area = frame[y0:int(.825*h), x0:int(.865*w)].min(axis=2).astype(np.float32)
        scale = 1080/h                   # the template's pixel size
        area = cv2.resize(area, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        if area.shape[0] < _combo_word.shape[0] or area.shape[1] < _combo_word.shape[1]:
            continue
        match = cv2.matchTemplate(area, _combo_word, cv2.TM_CCOEFF_NORMED)
        _, score, _, (x, y) = cv2.minMaxLoc(match)
        if score >= .6:
            found.append(((x0+x/scale)/w-COMBO_WORD[0], (y0+y/scale)/h-COMBO_WORD[1]))
    capture.release()
    if len(found) < 5:
        return (0., 0.)
    dx, dy = np.median(np.array(found), axis=0)
    if abs(dx) < .0005 and abs(dy) < .001:   # within a pixel or so: the usual place
        return (0., 0.)
    return (round(float(dx), 4), round(float(dy), 4))


COMBO_ZERO = .5


def combo_death_ranges(readings, settle):
    """A combo that falls back to 0 (two steady readings each way) means the player died."""
    samples = [r for r in readings if 'combo_zero' in r and r.get('who', 1) >= NAME_MATCH]
    # The combo only leaves 0 because of a kill, so a non-zero spell must follow a counter rise.
    rises, last = [], None
    for r in samples:
        if 'count' in r:
            if last is not None and r['count'] > last:
                rises.append(r['time'])
            last = r['count'] if last is None else max(last, r['count'])
    # Readings between 0.45 and 0.55 are too blurred to call and are skipped.
    clear = [r for r in samples if r['combo_zero'] >= .55 or r['combo_zero'] <= .45]
    ranges, state, spell, last_nonzero = [], None, [], None
    for a, b in zip(clear, clear[1:]):
        zero_a, zero_b = a['combo_zero'] >= .55, b['combo_zero'] >= .55
        if zero_a != zero_b:
            continue
        if not zero_a:
            if state is not False:
                spell = []
            spell += [a, b]
            last_nonzero = b
        elif state is False:
            solid = sum(r['combo_zero'] <= .4 for r in {id(r): r for r in spell}.values()) >= 2
            earned = any(spell[0]['time']-2. <= t <= last_nonzero['time'] for t in rises)
            if solid and earned:
                ranges.append(dict(start=last_nonzero['time'], end=a['time']+settle, cuts=[a['time']]))
        state = zero_a
    return ranges


def scan_video(video, interval, roi, minimap_roi, scene_threshold=.12, minimap_threshold=.07,
               hp_roi=(.365,.845,.595,.895), name_reference=None, hp_level=HP_LEVEL, combo_shift=(0., 0.)):
    cv2.setNumThreads(1)
    capture = cv2.VideoCapture(str(video), cv2.CAP_FFMPEG,
                              [cv2.CAP_PROP_N_THREADS, 4])
    if not capture.isOpened():
        raise ValueError(f'Cannot open video: {video}')
    reader = CounterReader()
    detector = cv2.SIFT_create(nfeatures=300,contrastThreshold=.015,edgeThreshold=15)
    readings, transitions, respawn_checks = [], [], []
    map_history, pending = deque(maxlen=40), []
    next_transition = next_counter = next_progress = 0.
    previous = None
    started = time.monotonic()
    seconds = 0.
    try:
        while capture.grab():
            seconds = capture.get(cv2.CAP_PROP_POS_MSEC)/1000
            if seconds + .001 < min(next_transition, next_counter):
                continue
            ok, frame = capture.retrieve()
            if not ok:
                break
            if seconds + .001 >= next_counter:
                health = dict(hp=hp_fill(crop(frame, hp_roi), hp_level)) if hp_roi else {}
                if name_reference is not None:
                    health['who'] = round(name_similarity(name_reference, name_signature(frame, name_roi(roi))), 3)
                if list(roi) == list(COUNTER_LAYOUTS[1]):
                    health['combo_zero'] = combo_zero_score(frame, combo_shift)
                readings.append(dict(time=round(seconds, 3), **health, **reader.read(crop(frame, roi))))
                next_counter = seconds + interval - .001
                # An instant HP refill is a respawn candidate (regeneration only adds ~0.1 per half second).
                now = readings[-1]
                low = [r for r in readings[-4:-1] if now['time']-r['time'] <= 1.1 and r.get('hp', 1) < .65]
                if (hp_roi and now['hp'] >= .95 and low and readings[-2].get('hp', 1) < .65
                        and map_history):
                    last_low = max(r['time'] for r in low)
                    before = [img for t, img in map_history if t <= last_low+.01] or [map_history[0][1]]
                    pending.append(dict(time=now['time'], from_hp=min(r['hp'] for r in low),
                                        before=before[-1], due=now['time']+.5))
            if seconds + .001 >= next_transition:
                scene = cv2.GaussianBlur(cv2.resize(crop(frame, (.08,.30,.90,.80)), (128,64)), (7,7), 0).astype(np.float32)
                minimap = cv2.GaussianBlur(cv2.resize(crop(frame, minimap_roi), (80,80)), (5,5), 0).astype(np.float32)
                map_detail = cv2.cvtColor(cv2.resize(crop(frame,minimap_roi),(256,256)),cv2.COLOR_BGR2GRAY)
                if previous is not None:
                    row=dict(time=round(seconds,3),
                        scene=round(float(np.abs(scene-previous[0]).mean()/255),5),
                        minimap=round(float(np.abs(minimap-previous[1]).mean()/255),5))
                    if row['scene'] >= scene_threshold and row['minimap'] >= minimap_threshold:
                        row.update(map_motion(previous[2],map_detail,detector))
                    transitions.append(row)
                previous = scene, minimap, map_detail
                map_history.append((seconds, map_detail))
                for check in [c for c in pending if c['due'] <= seconds+.001]:
                    pending.remove(check)
                    respawn_checks.append(dict(time=check['time'], from_hp=check['from_hp'],
                                               **map_motion(check['before'], map_detail, detector)))
                next_transition = seconds + TRANSITION_INTERVAL - .01
            if seconds >= next_progress:
                print(f'Scanned {seconds:.0f}s ({time.monotonic()-started:.0f}s elapsed)', flush=True)
                next_progress = seconds + 60
    finally:
        capture.release()
    if not readings:
        raise ValueError('No readable frames.')
    return dict(readings=readings, transitions=transitions, respawn_checks=respawn_checks,
                roi=list(roi), minimap_roi=list(minimap_roi), hp_roi=list(hp_roi) if hp_roi else None,
                hp_level=hp_level, combo_shift=list(combo_shift), duration=seconds)


def death_ranges(transitions, duration, scene_threshold, minimap_threshold, guard, settle, map_shift=.18):
    """Both signals must jump. Guard excludes the likely death before the respawn cut."""
    ranges = []
    for row in transitions:
        if row['scene'] < scene_threshold or row['minimap'] < minimap_threshold:
            continue
        relocated = (row.get('map_shift') is not None and row['map_shift'] >= map_shift
                     and row.get('map_inliers',0) >= 5)
        # When matching fails, conservatively exclude very strong joint cuts.
        ambiguous_cut = (row['scene'] >= max(.25,scene_threshold)
                         and row['minimap'] >= max(.10,minimap_threshold)
                         and row.get('map_match_ratio',0) < .20)
        if not (relocated or ambiguous_cut):
            continue
        start, end = max(0, row['time']-guard), min(duration, row['time']+settle)
        if ranges and start <= ranges[-1]['end']:
            ranges[-1]['end'] = max(end, ranges[-1]['end'])
            ranges[-1]['cuts'].append(row['time'])
        else:
            ranges.append(dict(start=start, end=end, cuts=[row['time']]))
    return ranges


def separate_lives(events, excluded):
    result = []
    for event in events:
        # Drop kills that registered after a death began, except trade kills already under way.
        def after_death(span):
            if event['earliest'] < span['start'] or event['earliest'] > span['end']:
                return False
            # Same reading as the death onset and seen by the very next reading: a trade kill.
            trade = event['earliest']-span['start'] < .05 and event['time']-event['earliest'] <= .75
            return not trade
        if any(after_death(span) for span in excluded):
            continue
        life = sum(span['end'] < event['earliest'] for span in excluded)
        result.append(dict(event, segment=(event['segment'], life)))
    return result


def teleported(check, map_shift):
    """Rotation-compensated minimap jump, or a minimap that no longer matches at all."""
    if check.get('map_shift') is None or check.get('map_inliers', 0) < 5:
        return True
    return check['map_shift'] >= map_shift


def ends_in_respawn(samples, index, lookahead=2):
    """A respawn refills the bar at once; a gradual heal means the player stayed alive."""
    after = samples[index:index+lookahead]
    if not after:
        return True  # still empty when the video ends
    if any(r.get('who', 1) < NAME_MATCH for r in after):
        return True  # panel vanished: death screen / killcam
    return any(r['hp'] >= .95 for r in after)


def low_hp_runs(samples, low=.2, bridge=2):
    """Index runs of low HP readings, tolerating up to `bridge` noisy ones."""
    runs, run, misses = [], [], 0
    for index, row in enumerate(samples):
        if row['hp'] < low:
            run.append(index)
            misses = 0
        elif run:
            misses += 1
            if misses > bridge:
                runs.append(run)
                run, misses = [], 0
    if run:
        runs.append(run)
    return runs


def hp_death_ranges(readings, settle, empty=.1, min_samples=2, checks=(), guard=4., map_shift=.18,
                    respawn_within=4):
    """Deaths from the HP bar: an empty bar refilled within ~2 s, or an instant refill plus a minimap jump."""
    ranges = []
    samples = [r for r in readings if 'hp' in r]
    for run in low_hp_runs(samples):
        if len(run) < min_samples or min(samples[i]['hp'] for i in run) >= empty:
            continue
        nxt = run[-1]+1
        if not ends_in_respawn(samples, nxt, respawn_within):
            continue
        first = samples[run[0]]['time']
        # Start one reading before the bar emptied (never further back across a gap in readings).
        before = max(samples[run[0]-1]['time'], first-1.) if run[0] else first
        refill = next((samples[i]['time'] for i in range(nxt, min(nxt+respawn_within, len(samples)))
                       if samples[i]['hp'] >= .95), samples[min(nxt, len(samples)-1)]['time'])
        ranges.append(dict(start=before, end=refill+settle, cuts=[samples[run[0]]['time']]))
    hp = [(r['time'], r['hp']) for r in samples]
    for check in checks:
        if not (check['from_hp'] < .15 or teleported(check, map_shift)):
            continue
        # The death happened while HP stayed low before the refill; exclude that stretch (at most guard seconds).
        start = check['time']
        for t, value in reversed([p for p in hp if p[0] < check['time']]):
            if value >= .65 or check['time']-t > guard:
                break
            start = t
        ranges.append(dict(start=start, end=check['time']+settle, cuts=[check['time']]))
    return merge_ranges(ranges)


def match_end_readings(video, cached, interval=.5, max_rise=4):
    """Read the replay-layout counter after a won match, where the final kills show.
    Returns (readings, start time)."""
    readings = cached['readings']
    last = max((i for i, r in enumerate(readings) if r.get('who', 1) >= NAME_MATCH), default=None)
    if last is None or last == len(readings)-1 or not cached.get('roi'):
        return [], None
    counts = [r['count'] for r in readings[:last+1] if 'count' in r and r.get('who', 1) >= NAME_MATCH]
    if not counts:
        return [], None
    base = max(counts[-6:], key=counts[-6:].count)  # settled count just before the switch
    start = readings[last]['time']
    others = [layout for layout in COUNTER_LAYOUTS if list(layout) != list(cached['roi'])]
    reader = CounterReader()
    capture = cv2.VideoCapture(str(video))
    found, t, misses = [], start+interval/2, 0
    while t <= cached['duration'] and misses < 4:
        capture.set(cv2.CAP_PROP_POS_MSEC, t*1000)
        ok, frame = capture.read()
        if not ok:
            break
        value = next((v['count'] for v in (reader.read(crop(frame, L)) for L in others) if v), None)
        if value is not None and base <= value <= base+max_rise:
            found.append(dict(time=round(t, 3), count=value, who=1., end_of_match=True))
            misses = 0
        elif found or t-start > 2:
            misses += 1
        t += interval
    capture.release()
    return found, start


def away_ranges(readings, settle, threshold=NAME_MATCH, min_samples=2):
    """Stretches where the panel shows someone else or nothing (dead, between rounds, match over)."""
    ranges, run = [], []
    samples = [r for r in readings if 'who' in r]
    for index, row in enumerate(samples + [None]):
        if row is not None and row['who'] < threshold:
            run.append(index)
            continue
        if len(run) >= min_samples:
            start = samples[run[0]-1]['time'] if run[0] else samples[run[0]]['time']
            end = (row['time'] if row is not None else samples[run[-1]]['time']) + settle
            ranges.append(dict(start=start, end=end, cuts=[samples[run[0]]['time']], away=True))
        run = []
    return ranges


def merge_ranges(*groups):
    merged = []
    for span in sorted((s for g in groups for s in g), key=lambda s: s['start']):
        if merged and span['start'] <= merged[-1]['end']+.5:
            merged[-1]['end'] = max(merged[-1]['end'], span['end'])
            merged[-1]['cuts'] += span['cuts']
        else:
            merged.append(dict(span, cuts=list(span['cuts'])))
    return merged