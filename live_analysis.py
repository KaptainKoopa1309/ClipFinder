"""Live (screen-recorded) CODM recordings: the player's kills and deaths from the killfeed,
the scorestreak points counter and the score popup. Nothing is tuned to one player's HUD."""
import bisect
import time
from pathlib import Path

import cv2
import numpy as np

LIVE_VERSION = 8
INTERVAL = .25                            # seconds between readings; killfeed rows stay up 1.75 s or more
ASSETS = Path(__file__).resolve().parent/'assets'/'live'
KILLCAM_ROI = (.10, .03, .22, .11)        # "KILLCAM" title (game UI, not part of the movable HUD)
KILLED_BY_ROI = (.20, .81, .30, .89)      # "KILLED BY" tag under the killcam
AWAY_SCORE = .6                           # template score of either title while a killcam shows (about 1 vs 0.4)
SPECTATE_LIT = .6                         # share of the spectated player's white HP strip that is lit
SPECTATE_ROI = (.3675, .8778, .699, .9)    # that strip, under the spectated player's name bar
TITLE_SCALE = 4                           # titles are matched at a quarter of the resolution
COUNTER_ROI = (.3353, .9398, .3814, 1.)    # scorestreak points counter, left of the HP bar (reference layout)
COUNTER_BAND = (.03, .70, .80, 1.)         # where the counter is looked for (players can move it)
COUNTER_SIZE = (110, 65)                   # the counter's region in canvas pixels, centred on its digits
COUNTER_DIGIT = 19.                        # the counter's digit height at that size
COUNTER_INNER = (.246, .754, .218, .827)  # the counter box's inside, as fractions of that region (top, bottom, left, right)
COUNTER_CONF = .6                          # digit match needed to trust a counter reading
COUNTER_FONTS = (.55, .74)                 # single-digit width / height of each template set in counter_digits.npy (bold, thin)
ICON_SLOT = (.5218, .8778, .5603, .9546)   # the cheapest streak's icon, right of the others (each 89.5 px to its left)
ICON_PITCH = 89.5/2386
ICON_LIT = .18                             # share of yellow pixels in a slot whose streak is ready
POPUP_ROI = (.5574, .375, .6412, .4444)    # the score popup's "+N", centre of the screen
POPUP_CONF = .5                            # digit match needed to trust a popup reading
POPUP_SURE = .55                           # ... to trust one that is seen only once (a popup cut short by a death)
STREAKS = Path(__file__).resolve().parent/'scorestreaks.json'
HEIGHT = 1080                             # the game picture is read at this height
FEED_PITCH = 35.                          # killfeed row spacing at that height and the default HUD size
BG_HALF = 15                              # local background: 31 x 31 window
BG_EDGE = 40                              # pixels this far from the window mean are text, left out of the background
CHROMA = 10                               # colour shift from the background that makes a name gold or red
TEXT_EDGE = 40  # rise above the background that makes name text
# Width corrections for a stretched or squeezed picture, nearest 1 first.
STRETCHES = tuple(sorted((round(.75+.025*k, 3) for k in range(25)), key=lambda s: (abs(s-1), s)))
LIGHT_EDGE = 25                           # brightness above the background that makes a name's pale fill
BLUE_TEXT = 20                            # blue above red and green that makes a pixel a teammate's (blue) name


def load_title(name):
    image = cv2.imread(str(ASSETS/name), cv2.IMREAD_GRAYSCALE)
    return shrink(image)


def shrink(gray):
    h, w = gray.shape
    return cv2.resize(gray, (max(1, w//TITLE_SCALE), max(1, h//TITLE_SCALE)), interpolation=cv2.INTER_AREA)


def title_score(area, title):
    """Template score of a killcam title in its region."""
    area = shrink(cv2.cvtColor(np.ascontiguousarray(area), cv2.COLOR_BGR2GRAY))
    return round(float(cv2.matchTemplate(area, title, cv2.TM_CCOEFF_NORMED).max()), 3)


def spectate_score(strip):
    """Lit share of the spectated player's HP strip."""
    h, w = strip.shape[:2]
    cells = cv2.resize(np.ascontiguousarray(strip), (max(1, w//12), max(1, h//12)), interpolation=cv2.INTER_AREA)
    return round(float((cells.min(-1) > 200).mean()), 3)


def crop(frame, roi):
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = roi
    return frame[int(h*y1):int(h*y2), int(w*x1):int(w*x2)]


# ---- the game picture: inside any black bars, read at 1080 rows ----

def content_rect(frames):
    """The game picture inside any black bars: [x0, y0, x1, y1] in source pixels."""
    edges = []
    for frame in frames:
        lit = frame.max(-1) > 30
        rows, cols = np.flatnonzero(lit.mean(1) > .02), np.flatnonzero(lit.mean(0) > .02)
        if len(rows) and len(cols):
            edges.append((cols[0], rows[0], cols[-1]+1, rows[-1]+1))
    h, w = frames[0].shape[:2]
    if not edges:
        return [0, 0, w, h]
    x0, y0, x1, y1 = (int(v) for v in np.median(np.array(edges), 0))
    x0, y0 = (0 if x0 < .01*w else x0), (0 if y0 < .01*h else y0)
    x1, y1 = (w if x1 > .99*w else x1), (h if y1 > .99*h else y1)
    return [x0, y0, x1, y1]


def canvas_for(rect, height=HEIGHT, stretch=1.):
    """The picture scaled to `height` rows, its width times `stretch`."""
    x0, y0, x1, y1 = rect
    return dict(rect=[int(v) for v in rect], size=[int(np.floor((x1-x0)*height/(y1-y0)*stretch+.5)), int(height)],
                stretch=stretch)


def unstretch(frames, rect, title):
    """Width correction at which the KILLCAM title matches best (1 when no killcam shows)."""
    scores = [max(title_score(region(f, canvas_for(rect, stretch=s), KILLCAM_ROI), title) for f in frames)
              for s in STRETCHES]
    best = max(scores)
    if best < AWAY_SCORE:
        return 1.
    return next(s for s, score in zip(STRETCHES, scores) if score >= best-.05)


def region(frame, canvas, roi):
    """Region `roi` of the canvas, sampled bilinearly from the source frame (as cv2.INTER_LINEAR)."""
    x0, y0, x1, y1 = canvas['rect']
    W, H = canvas['size']
    X1, Y1, X2, Y2 = int(W*roi[0]), int(H*roi[1]), int(W*roi[2]), int(H*roi[3])
    sw, sh = x1-x0, y1-y0
    if (sw, sh) == (W, H):
        return frame[y0+Y1:y0+Y2, x0+X1:x0+X2]
    sx = np.clip((np.arange(X1, X2)+.5)*(sw/W)-.5, 0, sw-1)
    sy = np.clip((np.arange(Y1, Y2)+.5)*(sh/H)-.5, 0, sh-1)
    ix, iy = sx.astype(np.int64), sy.astype(np.int64)
    fx, fy = (sx-ix)[None, :, None], (sy-iy)[:, None, None]
    ix2, iy2 = np.minimum(ix+1, sw-1)+x0, np.minimum(iy+1, sh-1)+y0
    ix, iy = ix+x0, iy+y0
    f = frame.astype(np.float64)
    top = (1-fx)*f[iy][:, ix] + fx*f[iy][:, ix2]
    bottom = (1-fx)*f[iy2][:, ix] + fx*f[iy2][:, ix2]
    return np.floor((1-fy)*top + fy*bottom + .5).astype(np.uint8)


# ---- name colours, against the local background ----

def box_sum(a, half=BG_HALF):
    """Sums and areas of (2*half+1)-square windows clipped at the image edges."""
    h, w = a.shape[:2]
    k = 2*half+1
    sums = cv2.boxFilter(a.astype(np.float64), -1, (k, k), normalize=False, borderType=cv2.BORDER_CONSTANT)
    y1, y2 = np.clip(np.arange(h)-half, 0, h), np.clip(np.arange(h)+half+1, 0, h)
    x1, x2 = np.clip(np.arange(w)-half, 0, w), np.clip(np.arange(w)+half+1, 0, w)
    return sums, ((y2-y1)[:, None]*(x2-x1)[None, :]).astype(np.float64)


def relative(image):
    """Each pixel's colour step from its local background, and the mean of that step."""
    p = image.astype(np.float64)
    total, n = box_sum(p)
    keep = (np.abs(p*n[..., None] - total).max(-1) <= BG_EDGE*n).astype(np.float64)
    kept, _ = box_sum(p*keep[..., None])
    count, _ = box_sum(keep)
    use = (20*count > n)[..., None]
    bg = np.where(use, kept/np.maximum(count, 1)[..., None], total/n[..., None])
    step = p - bg
    return step, (step[..., 0] + step[..., 1] + step[..., 2])/3


def pale_gold(image):
    """Pale gold in absolute terms, where the name's colour shift is too faint to show."""
    p = image.astype(np.int16); B, G, R = p[..., 0], p[..., 1], p[..., 2]
    hi = np.maximum(R, G)
    return (hi > 165) & (np.minimum(R, G)-B > 25) & (np.abs(R-G) < 35) & ((hi-B)/np.maximum(hi, 1) < .55)


def colours(image):
    """Killfeed masks: gold (the player), red (enemies), text (any name), light (pale fill), and redness.
    Blue pixels are left out so a look-alike teammate name never matches."""
    step, mean = relative(image)
    B, G, R = (step[..., k]-mean for k in range(3))
    lo = np.minimum(R, G)
    p = image.astype(np.int16)
    cool = p[..., 0]-np.maximum(p[..., 1], p[..., 2]) > BLUE_TEXT
    gold = (((lo > CHROMA) & (np.abs(R-G) < lo) & (B < -CHROMA)) | pale_gold(image)) & ~cool
    red = (R > CHROMA) & (R-G > CHROMA) & (R-B > CHROMA)
    text = step.max(-1) > TEXT_EDGE
    redness = np.minimum(np.floor(np.maximum(R-np.maximum(G, B), 0)*4), 255).astype(np.uint8)
    return gold, red, text, (mean > LIGHT_EDGE) & ~cool, redness


# ---- locating the killfeed (each player can move it) ----

def long_runs(mask, length=30):
    """Pixels in horizontal runs of `length`+ pixels (row band edges, not letters)."""
    m = np.pad(mask.astype(np.int8), ((0, 0), (1, 1)))
    step = np.diff(m, axis=1)
    ys, starts = np.nonzero(step == 1)
    _, ends = np.nonzero(step == -1)
    long = ends-starts >= length
    marks = np.zeros((mask.shape[0], mask.shape[1]+1), np.int32)
    np.add.at(marks, (ys[long], starts[long]), 1)
    np.add.at(marks, (ys[long], ends[long]), -1)
    return np.cumsum(marks, axis=1)[:, :-1] > 0


def text_lines(frame, min_letters=3, stillness=None):
    """Lines of letter-sized components: (x1, x2, middle, letters, coloured letters)."""
    gold, red, text, _, _ = colours(frame)
    coloured = gold | red
    mask = text | coloured
    mask &= ~long_runs(mask)
    if stillness is not None:
        stillness.add(mask)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    tint = np.bincount(labels[coloured & mask], minlength=len(stats))
    x, y, w, h, a = (stats[1:, k] for k in range(5))
    # Letters that touch (bold or blurred names) are one wider piece, counted as width / 13 letters.
    ok = (h >= 9) & (h <= 24) & (w >= 2) & (w <= 90)
    lines = []
    for i in sorted(np.flatnonzero(ok), key=lambda i: x[i]):
        cx, cy, cw, ch = x[i], y[i], w[i], h[i]
        mid, letters = cy + ch/2, max(1, int(np.floor(cw/13+.5)))
        tinted = letters*int(2*tint[i+1] > a[i])
        for line in lines:
            if abs(line['mid']-mid) <= 4 and 0 <= cx-line['x2'] <= 16:
                line['x2'] = max(line['x2'], int(cx+cw)); line['n'] += letters; line['c'] += tinted; break
        else:
            lines.append(dict(x1=int(cx), x2=int(cx+cw), mid=float(mid), n=letters, c=tinted))
    return [line for line in lines if line['n'] >= min_letters]


def feed_rows(lines):
    """Killfeed rows: killer name, weapon gap, victim name; one of the names red or gold."""
    rows = []
    for a in lines:
        for b in lines:
            if (b is not a and abs(a['mid']-b['mid']) <= 4 and 25 <= b['x1']-a['x2'] <= 170
                    and (2*a['c'] >= a['n'] or 2*b['c'] >= b['n'])):
                rows.append(dict(x1=a['x1'], x2=b['x2'], mid=(a['mid']+b['mid'])/2)); break
    return rows


def picture(video, samples=24):
    """The recording's canvas, from frames spread over it."""
    capture = cv2.VideoCapture(str(video))
    count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    frames = []
    for index in np.linspace(.05*count, .95*count, samples).astype(int):
        capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
        ok, frame = capture.read()
        if ok:
            frames.append(frame)
    capture.release()
    if not frames:
        raise ValueError(f'Cannot read frames from {video}')
    rect = content_rect(frames)
    return canvas_for(rect, stretch=unstretch(frames, rect, load_title('killcam.png')))


def locate_killfeed(video, samples=240):
    """Find the killfeed (the left edge shared by most rows), its row spacing and the points counter."""
    canvas = picture(video)
    width, height = canvas['size']
    digits = list(np.load(ASSETS/'counter_digits.npy'))
    most = max(load_streaks()['costs'])
    capture = cv2.VideoCapture(str(video))
    count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    found, numbers, stillness = [], [], Stillness()
    for k, index in enumerate(np.linspace(.03*count, .97*count, samples).astype(int)):
        capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
        ok, frame = capture.read()
        if ok:
            full = region(frame, canvas, (0, 0, 1, 1))
            found += [dict(row, frame=k, pix=stillness.pixels(row)) for row in feed_rows(text_lines(full, stillness=stillness))]
            numbers += [dict(n, frame=k) for n in counter_candidates(full, digits, most)]
    capture.release()
    feed = feed_box(stillness.drop(found), width, height, samples, canvas)
    feed.update(counter_box(numbers, width, height, samples))
    return feed


def counter_candidates(full, digits, most):
    """Places in the lower canvas where a counter-like number reads confidently."""
    H, W = full.shape[:2]
    X0, Y0, X1, Y1 = int(W*COUNTER_BAND[0]), int(H*COUNTER_BAND[1]), int(W*COUNTER_BAND[2]), int(H*COUNTER_BAND[3])
    p = full[Y0:Y1, X0:X1].astype(np.int16)
    mask = (p.max(-1)-p.min(-1) < 60) & ((p[..., 0]+p[..., 1]+p[..., 2]) > 450)
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    parts = sorted((s for s in stats[1:].tolist() if 14 <= s[3] <= 30 and 2 <= s[2] <= 48 and s[4] >= 15),
                   key=lambda s: (s[0], s[1]))
    groups = []
    for s in parts:
        mid = s[1]+s[3]/2
        for g in groups:
            x, y, w, h, _ = g[-1]
            if -2 <= s[0]-(x+w) <= 10 and abs(mid-(y+h/2)) <= 4 and abs(s[3]-h) <= 5:
                g.append(s)
                break
        else:
            groups.append([s])
    out = []
    for g in groups:
        if len(g) > 4:
            continue
        x = X0+(min(s[0] for s in g)+max(s[0]+s[2] for s in g))/2
        y = Y0+(min(s[1] for s in g)+max(s[1]+s[3] for s in g))/2
        h = max(s[3] for s in g)
        w2, h2 = COUNTER_SIZE[0]*h/COUNTER_DIGIT/2, COUNTER_SIZE[1]*h/COUNTER_DIGIT/2
        box = full[max(0, int(y-h2)):int(y+h2), max(0, int(x-w2)):int(x+w2)]
        value, worst = read_counter(box, digits)
        if value is not None and value >= 10 and worst >= COUNTER_CONF and value <= most:
            out.append(dict(x=x, y=y, h=h, value=value))
    return out


def counter_box(numbers, width, height, samples, share=.1):
    """The points counter: where a number reads in the most frames, if in at least `share` of them."""
    best = None
    for a in numbers:
        near = [b for b in numbers if abs(b['x']-a['x']) <= 20 and abs(b['y']-a['y']) <= 10]
        frames = len({b['frame'] for b in near})
        if best is None or frames > best[0]:
            best = (frames, near)
    if best is None or best[0] < max(3, share*samples):
        return dict(counter=None, icons=False)
    near = best[1]
    x, y = float(np.median([b['x'] for b in near])), float(np.median([b['y'] for b in near]))
    scale = float(np.median([b['h'] for b in near]))/COUNTER_DIGIT
    w, h = COUNTER_SIZE[0]*scale, COUNTER_SIZE[1]*scale
    roi = [round(max(0., (x-w/2)/width), 4), round(max(0., (y-h/2)/height), 4),
           round(min(1., (x+w/2)/width), 4), round(min(1., (y+h/2)/height), 4)]
    reference = ((COUNTER_ROI[0]+COUNTER_ROI[2])/2*width, (COUNTER_ROI[1]+COUNTER_ROI[3])/2*height)
    icons = abs(x-reference[0]) <= 25 and abs(y-reference[1]) <= 15 and abs(scale-1) <= .1
    return dict(counter=list(COUNTER_ROI) if icons else roi, icons=bool(icons), counter_frames=best[0])


class Stillness:
    """How often each pixel is text across frames, to drop static text (watermarks, HUD labels)."""
    def __init__(self):
        self.n, self.count, self.last = 0, None, None

    def add(self, mask):
        self.count = mask.astype(np.int32) if self.count is None else self.count + mask
        self.n += 1
        self.last = mask

    def pixels(self, row):
        """Flat indices of the text pixels in a row's area, from the last frame added."""
        y0, x1 = max(0, int(row['mid']-8)), row['x1']
        ys, xs = np.nonzero(self.last[y0:int(row['mid']+8), x1:row['x2']])
        return ((ys+y0)*self.last.shape[1] + xs+x1).tolist()

    def drop(self, found, share=.75):
        """Rows whose letters are text in 75%+ of frames: static text, not the killfeed."""
        if self.n < 10:
            return found
        kept, flat = [], self.count.ravel()
        for r in found:
            if r.get('pix'):
                still = np.median(flat[r['pix']])
            else:
                area = self.count[max(0, int(r['mid']-8)):int(r['mid']+8), r['x1']:r['x2']]
                still = np.percentile(area, 90) if area.size else 0
            if still < share*self.n:
                kept.append(r)
        return kept


def feed_box(found, width, height, samples, canvas):
    """Second half of locate_killfeed, from the rows found in each sampled frame."""
    frames = {}
    for row in found:
        frames.setdefault(row['x1']//6, set()).add(row['frame'])
    support = {b: len(f | frames.get(b-1, set()) | frames.get(b+1, set())) for b, f in frames.items()}
    if not support or max(support.values()) < 5:
        raise ValueError('Cannot find the killfeed; is this a live CODM recording?')
    best = max(support, key=support.get)
    # Partly read killer names start further right: the edge is the leftmost well-supported column.
    heights = lambda b: np.median([r['mid'] for r in found if abs(r['x1']//6-b) <= 1])
    best = min((b for b, s in support.items() if s >= .5*support[best]
                and abs(heights(b)-heights(best)) <= 20), default=best)
    left = int(np.median([r['x1'] for r in found if abs(r['x1']//6-best) <= 1]))
    column = [r for r in found if abs(r['x1']-left) <= 8]
    by_frame = {}
    for row in column:
        by_frame.setdefault(row['frame'], []).append(row['mid'])
    gaps = [g for mids in by_frame.values() for g in np.diff(sorted(mids)) if g > 15]
    # A missed row makes a double gap, so each gap counts per row it spans.
    base = float(np.percentile(gaps, 25)) if gaps else 0
    pitch = float(np.median([g/max(1, np.floor(g/base+.5)) for g in gaps])) if gaps else 35.*height/1080
    top = float(np.percentile([r['mid'] for r in column], 3))
    deepest = max(len(m) for m in by_frame.values())
    right = float(np.percentile([r['x2'] for r in column], 95))
    box = [max(0, left-14)/width, max(0, top-22)/height,
           min(width, right+40)/width, min(height, top+pitch*max(deepest, 3)+22)/height]
    # A killfeed set over 10% larger or smaller than default is read rescaled to the default size.
    scale = FEED_PITCH/pitch if abs(FEED_PITCH/pitch-1) > .1 else 1.
    feed_canvas = dict(rect=canvas["rect"], size=[int(np.floor(width*scale+.5)), int(np.floor(height*scale+.5))])
    return dict(box=[round(v, 4) for v in box], pitch=round(pitch, 2), rows=deepest,
                frames=len(by_frame), samples=samples, canvas=canvas, feed_canvas=feed_canvas,
                read_pitch=round(pitch*scale, 2))


# ---- scanning ----

def gold_bands(gold, margin=18):
    """Rows of the killfeed box near name text, where killfeed rows can be read."""
    profile = gold[:, 4:].sum(1) >= 6
    keep = np.zeros(len(profile), bool)
    y = 0
    while y < len(profile):
        if profile[y]:
            y2 = y
            while y2+1 < len(profile) and profile[y2+1]:
                y2 += 1
            if y2-y+1 >= 8:
                # Keep a text-height run's middle +-18 rows, a taller run whole plus 6 rows each side.
                c = (y+y2)//2
                keep[max(0, min(c-margin, y-6)):max(y2+6, c+margin)] = True
            y = y2+1
        else:
            y += 1
    return keep


def scan_live(video, interval, feed):
    """One pass over the video: away scores, killfeed masks and row signatures per sample."""
    cv2.setNumThreads(1)
    capture = cv2.VideoCapture(str(video), cv2.CAP_FFMPEG, [cv2.CAP_PROP_N_THREADS, 4])
    if not capture.isOpened():
        raise ValueError(f'Cannot open video: {video}')
    killcam, killed_by = load_title('killcam.png'), load_title('killed_by.png')
    digits = list(np.load(ASSETS/'counter_digits.npy'))
    streaks = len(load_streaks()['costs'])
    popup_digits = list(np.load(ASSETS/'popup_digits.npy'))
    readings, feed_data = [], []
    next_reading = next_progress = 0.
    started = time.monotonic()
    seconds = 0.
    try:
        while capture.grab():
            seconds = capture.get(cv2.CAP_PROP_POS_MSEC)/1000
            if seconds + .001 < next_reading:
                continue
            ok, frame = capture.retrieve()
            if not ok:
                break
            next_reading = (np.floor((seconds+.001)/interval)+1)*interval   # on the 0.25 s grid, like the website
            reading, sample, shape = read_sample(frame, feed, (killcam, killed_by, digits, streaks, popup_digits))
            readings.append(dict(time=round(seconds, 3), **reading))
            feed_data.append(sample)
            if seconds >= next_progress:
                print(f'Scanned {seconds:.0f}s ({time.monotonic()-started:.0f}s elapsed)', flush=True)
                next_progress = seconds + 60
    finally:
        capture.release()
    if not readings:
        raise ValueError('No readable frames.')
    return dict(readings=readings, feed=feed, duration=seconds), dict(shape=shape, samples=feed_data)


def half_size(image):
    """2 x 2 means, rounded half up."""
    h, w = image.shape[0]//2, image.shape[1]//2
    p = image[:2*h, :2*w].astype(np.int32)
    return ((p[0::2, 0::2]+p[0::2, 1::2]+p[1::2, 0::2]+p[1::2, 1::2]+2)//4).astype(np.uint8)


# ---- the scorestreak points counter ----

def load_streaks(path=STREAKS):
    """The loadout's streak costs (cheapest first) and the points a kill gives."""
    import json
    config = json.loads(Path(path).read_text(encoding='utf-8'))
    streaks = config['loadouts'][config.get('loadout', 'default')]
    return dict(costs=[s['cost'] for s in streaks], names=[s['name'] for s in streaks],
                kill_points=config.get('kill_points', 100))


def counter_masks(box):
    """Strict and relative masks of the counter's white digits."""
    h, w = box.shape[:2]
    y1, y2, x1, x2 = (int(round(f*n)) for f, n in zip(COUNTER_INNER, (h, h, w, w)))
    inner = box[y1:y2, x1:x2].astype(np.int16)
    luma = (inner[..., 0]+inner[..., 1]+inner[..., 2])/3
    spread = inner.max(-1)-inner.min(-1)
    masks = []
    for test in ((luma > np.median(luma)+45) & (spread < 60) & (luma > 150),
                 (luma > np.percentile(luma, 20)+50) & (spread < 80) & (luma > 100)):
        mask = np.zeros((h, w), bool)
        mask[y1:y2, x1:x2] = test & ~long_runs(test, 24)
        masks.append(mask)
    return masks


def counter_glyphs(mask, size=(12, 20)):
    """Digit crops left to right, plus the median single-digit width / height."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    parts = sorted((list(stats[i])+[i] for i in range(1, n) if stats[i][3] >= 6 and stats[i][4] >= 6), key=lambda s: s[0])
    tall = [s for s in parts if 14 <= s[3] <= 30]
    if tall:
        top, bottom = np.median([s[1] for s in tall]), np.median([s[1]+s[3] for s in tall])
        parts = [s for s in parts if s[1]+s[3] > top+2 and s[1] < bottom-2]
    keep = np.isin(labels, [s[5] for s in parts])
    merged = []
    for x, y, w, h, a, _ in parts:
        if merged and x <= merged[-1][0]+merged[-1][2]-1:
            X, Y, W, H, A = merged[-1]
            merged[-1] = [X, min(Y, y), max(X+W, x+w)-X, max(Y+H, y+h)-min(Y, y), A+a]
        else:
            merged.append([x, y, w, h, a])
    singles = [(w, h) for x, y, w, h, a in merged if 14 <= h <= 30 and .45*h <= w <= .95*h]
    ratio = float(np.median([w/h for w, h in singles])) if singles else None
    out = []
    for x, y, w, h, a in merged:
        if not (14 <= h <= 30 and 2 <= w <= 48 and a >= 15):
            continue
        pitch = float(np.median([w for w, _ in singles]))+2 if singles else .7*h
        pieces = max(1, int(np.floor(w/pitch+.5)))
        for k in range(pieces):
            x1, x2 = x+k*w//pieces, x+(k+1)*w//pieces
            out.append(cv2.resize(keep[y:y+h, x1:x2].astype(np.float32), size, interpolation=cv2.INTER_AREA))
    return out, ratio


def read_counter(box, digits):
    """The counter's value and its weakest digit match, or (None, 0)."""
    best, best_key = None, (False, 0, 0.)
    for mask in counter_masks(box):
        glyphs, ratio = counter_glyphs(mask)
        if not glyphs or len(glyphs) > 4:
            continue
        sets = range(0, len(digits), 10) if ratio is None else             [10*int(np.argmin([abs(ratio-f) for f in COUNTER_FONTS]))]
        for start in sets:
            value, worst = 0, 1.
            for g in glyphs:
                scores = [float(cv2.matchTemplate(g, t, cv2.TM_CCOEFF_NORMED).max()) for t in digits[start:start+10]]
                d = int(np.argmax(scores))
                value, worst = value*10+d, min(worst, scores[d])
                if len(glyphs) > 1 and value == 0:
                    worst = 0.
            sure = worst >= COUNTER_CONF
            key = (sure, len(glyphs) if sure else 0, worst)
            if worst > 0 and key > best_key:
                best, best_key = value, key
    return best, round(best_key[2], 3)


def popup_mask(box):
    """The popup number's saturated yellow."""
    p = box.astype(np.int16)
    B, G, R = p[..., 0], p[..., 1], p[..., 2]
    lo = np.minimum(R, G)
    return (lo-B > 100) & (lo > 120) & (np.abs(R-G) < 60)


def popup_glyphs(mask, size=(12, 20)):
    """The popup's characters ('+' then digits) left to right."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    parts = sorted((list(stats[i]) for i in range(1, n) if stats[i][4] >= 8), key=lambda s: s[0])
    if not parts:
        return []
    tall = max(s[3] for s in parts)
    if not 14 <= tall <= 70:
        return []
    bottom = max(s[1]+s[3] for s in parts)
    parts = [s for s in parts if s[3] >= .35*tall and s[1]+s[3] >= bottom-.5*tall]
    merged = []
    for x, y, w, h, a in parts:
        if merged and x <= merged[-1][0]+merged[-1][2]-1:
            X, Y, W, H, A = merged[-1]
            merged[-1] = [X, min(Y, y), max(X+W, x+w)-X, max(Y+H, y+h)-min(Y, y), A+a]
        else:
            merged.append([x, y, w, h, a])
    out, width = [], .62*tall
    for x, y, w, h, a in merged:
        pieces = max(1, int(np.floor(w/width+.5))) if w > 1.4*width else 1
        for k in range(pieces):
            x1, x2 = x+k*w//pieces, x+(k+1)*w//pieces
            out.append(cv2.resize(mask[y:y+h, x1:x2].astype(np.float32), size, interpolation=cv2.INTER_AREA))
    return out


def read_popup(box, digits):
    """The popup's '+N' and its weakest character match, or (None, 0)."""
    glyphs = popup_glyphs(popup_mask(box))
    if not 2 <= len(glyphs) <= 4:
        return None, 0.
    scores = [[float(cv2.matchTemplate(g, t, cv2.TM_CCOEFF_NORMED).max()) if t.std() > 0 else -1. for t in digits]
              for g in glyphs]
    if int(np.argmax(scores[0])) != 10:
        return None, 0.
    value, worst = 0, scores[0][10]
    for sc in scores[1:]:
        d = int(np.argmax(sc[:10]))
        value, worst = value*10+d, min(worst, sc[d])
    return value, round(worst, 3)


def icon_slots(count):
    """Streak icon regions above the HP bar, cheapest first."""
    x1, y1, x2, y2 = ICON_SLOT
    return [(x1-k*ICON_PITCH, y1, x2-k*ICON_PITCH, y2) for k in range(count)]


def icon_lit(slot):
    """Share of a slot's pixels in a ready streak's yellow."""
    p = slot.astype(np.int16)
    B, G, R = p[..., 0], p[..., 1], p[..., 2]
    lo = np.minimum(R, G)
    return round(float(((lo-B > 60) & (np.abs(R-G) < 40) & (lo > 130)).mean()), 3)


def read_sample(frame, feed, titles):
    """One scan sample: away scores, killfeed masks, readable rows and the box's redness."""
    canvas, feed_canvas = feed['canvas'], feed['feed_canvas']
    box = region(frame, feed_canvas, feed['box'])
    gold, red, _, light, redness = colours(box)
    rows = gold_bands(gold | light)
    reading = dict(
        killcam=title_score(region(frame, canvas, KILLCAM_ROI), titles[0]),
        killed_by=title_score(region(frame, canvas, KILLED_BY_ROI), titles[1]),
        spectate=spectate_score(region(frame, canvas, SPECTATE_ROI)),
        blank=bool(red.mean() < .002 and gold.mean() < .002))
    # Where locate_killfeed found the counter (older feeds: the reference place).
    counter = feed.get('counter', COUNTER_ROI)
    reading['points'], reading['points_match'] = read_counter(region(frame, canvas, counter), titles[2]) if counter else (None, 0.)
    if len(titles) > 3 and feed.get('icons', True):
        reading['icons'] = [icon_lit(region(frame, canvas, roi)) for roi in icon_slots(titles[3])]
    if len(titles) > 4:
        reading['popup'], reading['popup_match'] = read_popup(region(frame, canvas, POPUP_ROI), titles[4])
    sample = dict(gold=np.packbits(gold), light=np.packbits(light), rows=np.flatnonzero(rows),
                  sig=half_size(redness) if rows.any() else np.zeros((0, 0), np.uint8))
    return reading, sample, gold.shape


def unpack(feed_data, index, key='gold'):
    h, w = feed_data['shape']
    bits = feed_data['samples'][index].get(key)
    if bits is None:
        return np.zeros((h, w), np.float32)
    return np.unpackbits(bits, count=h*w).reshape(h, w).astype(np.float32)


def band_rows(sample, height, th, half=12):
    """Template positions whose row band was kept."""
    kept = np.zeros(height+1, np.int32)
    kept[sample['rows']+1] = 1
    kept = np.cumsum(kept)
    ys = np.arange(height-th+1)
    c = ys+th//2
    lo, hi = np.clip(c-half, 0, height), np.clip(c+half, 0, height)
    return (c-half >= 0) & (c+half <= height) & (kept[hi]-kept[lo] == 2*half)


def band(sample, key, c, x1=0, x2=None, half=12):
    """The half-size signature rows around c, or None when they were not kept."""
    rows = sample['rows']
    at = np.searchsorted(rows, c-half)
    if at+2*half > len(rows) or rows[at] != c-half or rows[at+2*half-1] != c+half-1:
        return None
    top = (c-half)//2
    out = sample[key][top:top+half, x1//2:None if x2 is None else x2//2].astype(np.float32)
    return out if out.shape[0] == half else None


# ---- the followed player's name ----

def letters(crop_mask, min_letters=4):
    """Whether a gold blob is text (several letter-sized components)."""
    _, _, stats, _ = cv2.connectedComponentsWithStats(crop_mask.astype(np.uint8), connectivity=8)
    w, h, a = stats[1:, 2], stats[1:, 3], stats[1:, 4]
    ok = (h >= 7) & (h <= 20) & (w <= 22) & (w >= 2)
    return ok.sum() >= min_letters and a[ok].sum() >= .7*a.sum()


def text_crops(gold, x0, x1):
    """Gold words in one column range, as 24 x 190 crops."""
    profile = gold[:, x0:x1].sum(1)
    out, y = [], 12
    while y < gold.shape[0]-12:
        if profile[y] >= 6:
            y2 = y
            while y2+1 < len(profile) and profile[y2+1] >= 6:
                y2 += 1
            c = (y+y2)//2
            if 8 <= y2-y+1 <= 26 and 12 <= c < gold.shape[0]-12:
                rows = gold[c-12:c+12]
                cols = np.flatnonzero(rows[:, x0:x1].sum(0) >= 2)
                if len(cols):
                    start = x0+cols[0]-3
                    word = rows[:, start:start+190]
                    if word.shape[1] == 190 and .05 < word.mean() < .3 and letters(word):
                        out.append(word)
            y = y2+1
        else:
            y += 1
    return out


def trim(template, gap=8):
    """Keep the widest run of inked columns (drops weapon-icon fragments)."""
    ink = template.max(0) > .3
    runs, x = [], 0
    while x < len(ink):
        if ink[x]:
            x2, blank = x, 0
            while x2+1 < len(ink) and blank < gap:
                x2 += 1
                blank = 0 if ink[x2] else blank+1
            runs.append((x, x2-blank)); x = x2+1
        else:
            x += 1
    a, b = max(runs, key=lambda r: r[1]-r[0])
    t = template[:, a:b+1]
    rows = np.flatnonzero(t.max(1) > .3)
    return t[rows.min():rows.max()+1]


def name_matches(feed_data, template, step, collect=False, side=2):
    """Confident name-template matches in the kept rows: their count, or the crops when `collect`."""
    th, tw = template.shape
    found, count = [], 0
    for i in range(0, len(feed_data['samples']), step):
        if not len(feed_data['samples'][i]['rows']):
            continue
        gold = unpack(feed_data, i)
        result = cv2.matchTemplate(gold, template, cv2.TM_CCOEFF_NORMED)
        result[~band_rows(feed_data['samples'][i], gold.shape[0], th)] = -1
        for _ in range(4):
            y, x = np.unravel_index(int(np.argmax(result)), result.shape)
            if result[y, x] < .6:
                break
            count += 1
            if collect and 2 <= y and y+th+2 <= gold.shape[0]:
                crop = np.zeros((th+4, tw+2*side), gold.dtype)
                x0, x1 = max(0, x-side), min(gold.shape[1], x+tw+side)
                crop[:, x0-(x-side):x1-(x-side)] = gold[y-2:y+th+2, x0:x1]
                found.append(crop)
            result[max(0, y-15):y+15, :] = -1
    return found if collect else count


def contains(big, small):
    """Whether `small` is roughly a piece of `big`, e.g. 'ppaGuy' of 'TappaGuy'."""
    if small.shape[0] > big.shape[0] or small.shape[1] > big.shape[1]:
        return False
    return cv2.matchTemplate(big, small, cv2.TM_CCOEFF_NORMED).max() > .6


def learn_name(feed_data, step=2, candidates=5, check=6):
    """The player's name: the commonest gold killfeed word that matches the most rows."""
    n = len(feed_data['samples'])
    crops = []
    for i in range(0, n, step):
        gold = unpack(feed_data, i)
        crops += text_crops(gold, 4, 60) + text_crops(gold, 150, gold.shape[1]-40)
    if len(crops) < 3:
        raise ValueError('The followed player\'s name never shows in the killfeed; no kills or deaths to read.')
    crops = np.array(crops, np.float32)
    flat = crops.reshape(len(crops), -1); flat = flat-flat.mean(1, keepdims=True)
    flat /= np.linalg.norm(flat, axis=1, keepdims=True)+1e-6
    alike = flat@flat.T > .75
    seeds = []
    for k in np.argsort(-alike.sum(1), kind='stable'):
        if len(seeds) == candidates:
            break
        if not any(alike[k, j] for j in seeds):
            seeds.append(int(k))
    found = []
    for seed in seeds:
        template = crops[seed]
        for _ in range(4):
            scores = np.array([cv2.matchTemplate(c, template, cv2.TM_CCOEFF_NORMED).max() for c in crops])
            template = crops[scores > .6].mean(0)
        template = trim(template)
        found.append((template, name_matches(feed_data, template, check)))
    totals = [sum(h for t, h in found if t is big or contains(big, t)) for big, _ in found]
    template = found[int(np.argmax(totals))][0]
    wide = name_matches(feed_data, template, step, collect=True, side=40)
    if len(wide) >= 3:
        template = trim(np.mean(wide, 0))
    matches = name_matches(feed_data, template, step, collect=True)
    return trim(np.mean(matches, 0)) if len(matches) >= 3 else template


# ---- following killfeed rows ----

def patch_similarity(a, b):
    """Best normalised correlation of b's centre inside a (shifted up to 2 px)."""
    if a is None or b is None:
        return 0.
    w = min(a.shape[1], b.shape[1])-4
    if w < 10:
        return 0.
    inner = b[2:-2, 2:2+w]
    if a.std() < 3 or inner.std() < 3:
        return 0.
    return float(cv2.matchTemplate(a[:, :w+4], inner, cv2.TM_CCOEFF_NORMED).max())


def peaks(score, threshold, separation=18):
    found = []
    for y in np.argsort(-score):
        if score[y] < threshold:
            break
        if all(abs(y-o) >= separation for o in found):
            found.append(int(y))
    return sorted(found)


def name_match(masks, template, x0=0, x1=None):
    """The name's match over the gold or the light mask, whichever is higher."""
    return np.maximum(*(cv2.matchTemplate(m[:, x0:x1], template, cv2.TM_CCOEFF_NORMED) for m in masks))


def kill_rows(masks, sample, template, threshold=.55):
    """Rows with the player as killer: (row centre, victim redness, match)."""
    th, tw = template.shape
    gold = masks[0]
    if not len(sample['rows']):
        return []
    score = name_match(masks, template, 4, 4+tw+30).max(1)
    score[~band_rows(sample, gold.shape[0], th)] = -1
    rows = []
    for y in peaks(score, threshold):
        c = y+th//2
        rows.append((c, band(sample, 'sig', c, 14+tw+4), float(score[y])))
    return [r for r in rows if r[1] is not None]


def death_rows(masks, sample, template, threshold=.55):
    """Rows with the player as victim: (row centre, killer redness, match)."""
    th, tw = template.shape
    gold = masks[0]
    if not len(sample['rows']):
        return []
    result = name_match(masks, template, 54)
    result[~band_rows(sample, gold.shape[0], th)] = -1
    rows = []
    for y in peaks(result.max(1), threshold):
        c, x = y+th//2, int(np.argmax(result[y]))+54
        if x >= 120:
            sig = band(sample, 'sig', c, 10, x-10)
            if sig is not None:
                rows.append((c, sig[:, :55], float(result[y].max())))
    return rows


class RowTracker:
    """Follows killfeed rows between samples so each new row is reported once."""
    def __init__(self, pitch=35., lose=1., hold=2.5, memory=10., same=.5, clean=.58, comeback=1., keep=4, confirm=1.):
        self.pitch, self.lose, self.hold, self.memory = pitch, lose, hold, memory
        self.same, self.clean, self.comeback, self.keep, self.confirm = same, clean, comeback, keep, confirm
        self.active, self.hidden, self.pending, self.events = [], [], [], []
        self.back_at, self.away_now = -1e9, False

    def similarity(self, sig, row):
        return max(patch_similarity(sig, s) for s in row['sigs'])

    def away(self, t):
        self.hidden += self.active
        self.active, self.pending, self.away_now = [], [], True

    def feed(self, t, detections):
        if self.away_now:
            self.back_at, self.away_now = t, False
        self.hidden = [r for r in self.hidden if t-r['t'] <= self.memory and t-self.back_at <= self.comeback]
        self.active = [r for r in self.active if t-r['t'] <= self.hold]
        pairs = []
        for i, (y, sig, _) in enumerate(detections):
            for j, row in enumerate(self.active):
                same_place = abs(y-row['y']) <= 8
                s = self.similarity(sig, row)
                # Unseen for over `lose` s: only the same place, or pushed down a slot and clearly the same row.
                if t-row['t'] > self.lose and not same_place and not (y > row['y']+8 and s >= .85):
                    continue
                if y >= row['y']-.6*self.pitch and s >= self.same-(.15 if same_place else 0):
                    pairs.append((s, i, j))
        used_d, used_r = set(), set()
        for s, i, j in sorted(pairs, reverse=True):
            if i in used_d or j in used_r:
                continue
            used_d.add(i); used_r.add(j)
            row, (y, sig, score) = self.active[j], detections[i]
            row['y'], row['t'] = y, t
            if score >= self.clean:
                row['sigs'] = row['sigs'][:1]+row['sigs'][1:][-(self.keep-2):]+[sig]
        unmatched = []
        for i, (y, sig, score) in enumerate(detections):
            if i in used_d:
                continue
            back = max(self.hidden, key=lambda r: self.similarity(sig, r), default=None)
            if back is not None and self.similarity(sig, back) >= .55:
                self.hidden = [r for r in self.hidden if r is not back]
                back['y'], back['t'] = y, t
                self.active.append(back)
            else:
                unmatched.append((y, sig, score))
        fresh = []
        for y, sig, score in unmatched:
            first = next((p for p in self.pending if t-p['t'] <= self.confirm and abs(y-p['y']) <= self.pitch+8
                          and patch_similarity(sig, p['sig']) >= self.same), None)
            if first is not None:
                self.pending = [p for p in self.pending if p is not first]
                if max(first['score'], score) >= self.clean:
                    self.events.append(first['first'])
                    self.active.append(dict(y=y, t=t, sigs=[sig if score >= first['score'] else first['sig']]))
                    continue
            fresh.append(dict(y=y, t=t, first=first['first'] if first else t, sig=sig,
                              score=max(score, first['score'] if first else 0)))
        self.pending = [p for p in self.pending if t-p['t'] <= self.confirm]+fresh


def away(reading):
    """Not the player's own view: a killcam or spectating."""
    return (reading['killcam'] >= AWAY_SCORE or reading['killed_by'] >= AWAY_SCORE
            or reading['spectate'] >= SPECTATE_LIT)


def follow_feed(scan, feed_data, template):
    """Times the player's kill rows and death rows first appear."""
    pitch = scan['feed']['read_pitch']
    kills, deaths = RowTracker(pitch), RowTracker(pitch)
    for i, reading in enumerate(scan['readings']):
        t = reading['time']
        if away(reading) or reading['blank']:
            kills.away(t); deaths.away(t)
            continue
        masks = unpack(feed_data, i), unpack(feed_data, i, 'light')
        sample = feed_data['samples'][i]
        kills.feed(t, kill_rows(masks, sample, template))
        deaths.feed(t, death_rows(masks, sample, template))
    return kills.events, deaths.events


def killcam_starts(readings):
    starts, before = [], False
    for r in readings:
        now = r['killcam'] >= AWAY_SCORE
        if now and not before:
            starts.append(r['time'])
        before = now
    return starts


def death_times(readings, feed_deaths, lag=2.2):
    """Deaths from killfeed rows and killcams (a row shows about 2.2 s before its killcam)."""
    starts = killcam_starts(readings)
    times = []
    for k in starts:
        near = [f for f in feed_deaths if k-4.5 <= f <= k]
        times.append(min(near, key=lambda f: abs(k-lag-f)) if near else round(k-lag+.1, 3))
    times += [f for f in feed_deaths if not any(0 <= k-f <= 4.5 for k in starts)]
    merged = []
    for t in sorted(times):          # nobody dies twice within 5 s (killcam + respawn)
        if not merged or t-merged[-1] > 5.:
            merged.append(t)
    return merged


def unread_for(readings):
    """Seconds since the counter last read well before t, in the player's own view."""
    seen = [r['time'] for r in readings if not away(r) and r.get('points') is not None
            and r.get('points_match', 0) >= COUNTER_CONF]
    def gap(t):
        k = bisect.bisect_left(seen, t-1e-6)
        return t-seen[k-1] if k else float('inf')
    return gap


def plausible(gain, dt, burst=300, rate=100):
    """Whether `gain` points in `dt` seconds is possible (rejects misread digits)."""
    return gain <= burst + rate*dt


def counter_points(readings, costs, hold=2, undo=5., settle=1., streaks=False):
    """Points earned in each life from the counter, one entry per accepted value.
    A killcam or spectating starts a new life, except a white flash."""
    unread = unread_for(readings)
    away_at, steady, run, died, reset, cam = None, [], [], False, False, False
    for r in readings:
        if away(r):                     # a killcam or spectating: the player died
            cam = (cam and died) or r['killcam'] >= AWAY_SCORE or r['killed_by'] >= AWAY_SCORE
            away_at, run, died, reset = r['time'], [], True, False
            continue
        v = r.get('points')
        if not v or r.get('points_match', 0) < COUNTER_CONF:
            continue                    # (never 0: a streak unlocks the moment its cost is reached)
        reset = reset or (died and v == costs[0])
        if away_at is not None and r['time']-away_at <= settle:
            continue
        if died and not cam and not reset and steady and v <= steady[-1][1]:
            died = False  # a white flash, not a death
        run = run+[(r['time'], v)] if run and run[-1][1] == v else [(r['time'], v)]
        # A value that lost digits (219 then 19) counts only once it stays 2 s.
        tail = steady and not died and v < steady[-1][1] and str(v) in str(steady[-1][1])
        if len(run) == (8 if tail else hold) and (not steady or steady[-1][1] != v or died):
            if died and not reset and steady and steady[-1][1] == v:
                continue                # the dead player's counter, still up until the respawn shows the reset
            steady.append((run[0][0], v, died))
            died = False
    unlocks = icon_unlocks(readings, len(costs), hold=6)   # 1.5 s: a lighting icon glows into its neighbour briefly
    out = []                            # (time, value, points, life, next streak)
    lit_unlocks = set()                 # times of unlocks a streak icon lighting confirmed
    for i, (t, v, respawned) in enumerate(steady):
        # The last reading lost its leading digit (66 then 266): it was this value all along.
        while (not respawned and len(out) > 1 and out[-1][3] == out[-2][3] and v > out[-1][1]
               and t-out[-1][0] < 1. and str(v).endswith(str(out[-1][1]))):
            out.pop()
        if not out:
            out.append((t, v, costs[0]-v, 0, 0))
            continue
        _, last, earned, life, k = out[-1]
        if v == last and not respawned:
            continue
        dt = unread(t)
        if respawned:                   # a new life starts at 0 points, before the first streak
            out.append((t, costs[0], 0, life+1, 0))
            if v < costs[0] and plausible(costs[0]-v, 0):
                out.append((t, v, costs[0]-v, life+1, 0))
        elif v < last:
            # A fall can still be an unlock (151 -> 95 when 256 points pass the 500 streak): its icon lights.
            lit = next((u for u in unlocks.get(k, []) if abs(u-t) <= 1.5), None)
            rises = i+1 < len(steady) and steady[i+1][0]-t <= 2. and steady[i+1][1] > v and not steady[i+1][2]
            if lit is not None and not rises and k+1 < len(costs) and costs[k+1]-v >= costs[k] \
                    and plausible(costs[k+1]-v-earned, dt):
                unlocks[k].remove(lit)
                lit_unlocks.add(t)
                out.append((t, v, costs[k+1]-v, life, k+1))
            elif plausible(costs[k]-v-earned, dt):
                out.append((t, v, costs[k]-v, life, k))
        elif v == costs[0] and last != costs[0]:
            out.append((t, v, 0, life+1, 0))
        else:
            back = [i for i in range(len(out)-1, -1, -1) if out[i][3] == life and t-out[i][0] <= undo]
            same = next((i for i in back if out[i][1] == v), None)
            if same is not None:
                del out[same+1:]
                continue
            # An unlock leaves at least the unlocked streak's cost in points (500 misread as 580 does not).
            unlocked = next((k2 for k2 in range(k+1, len(costs)) if costs[k2]-v >= max(earned, costs[k2-1])), None)
            if unlocked is not None and plausible(costs[unlocked]-v-earned, dt):
                for j in range(k, unlocked):
                    lit = next((u for u in unlocks.get(j, []) if abs(u-t) <= 1.5), None)
                    if lit is not None:
                        unlocks[j].remove(lit)
                        lit_unlocks.add(t)
                out.append((t, v, costs[unlocked]-v, life, unlocked))
    if streaks:                         # with the streak and whether an icon confirmed reaching it
        return [(t, p, life, k, t in lit_unlocks) for t, v, p, life, k in out]
    return [(t, p, life) for t, v, p, life, k in out]


def icon_unlocks(readings, count, hold=2):
    """Times each streak's icon lit up: {streak index: [times]}."""
    found, state, run = {k: [] for k in range(count)}, [None]*count, [None]*count
    for r in readings:
        icons = r.get('icons')
        if not icons or away(r):
            continue
        for k, share in enumerate(icons[:count]):
            now = share >= ICON_LIT
            run[k] = (now, run[k][1]+1, run[k][2]) if run[k] and run[k][0] == now else (now, 1, r['time'])
            if run[k][1] == hold and state[k] != now:
                if now and state[k] is False:
                    found[k].append(run[k][2])
                state[k] = now
    return found


def counter_kills(readings, costs, kill_points=100, slack=15, quick=2.):
    """Kill times from counter rises seen within `quick` s of the previous reading."""
    found, last, unread = [], None, unread_for(readings)
    for t, p, life, k, lit in counter_points(readings, costs, streaks=True):
        # Unlock kills count only when a streak icon confirms them (streak costs vary per player).
        if last is not None and life == last[2][0] and (k == last[2][1] or lit) and unread(t) <= quick:
            found += [t]*max(int((p-last[1]+slack)//kill_points), 0)
        last = (t, p, (life, k))
    return found


def counter_readable(readings, share=.5):
    """True when the counter reads in at least half of the own-view readings."""
    own = [r for r in readings if not (away(r) or r['blank'])]
    good = sum(1 for r in own if r.get('points') is not None and r.get('points_match', 0) >= COUNTER_CONF)
    return bool(own) and good >= share*len(own)


def counter_backed(readings, feed, streaks, enough=10):
    """The share of the counter's kills a popup or killfeed row also shows (2 s before to 3 s after),
    or None with fewer than `enough` to judge. Blurred digits (425 read as 5) make kills nothing else shows."""
    counter = counter_kills(readings, streaks['costs'], streaks['kill_points'])
    popups = popup_events(readings)
    if len(counter) < enough:
        return None
    backed = 0
    for t in set(counter):
        def within(x): return -2 <= x-t <= 3
        seen = max(sum(n for p, n in popups if within(p)), sum(1 for f in feed if within(f)))
        backed += min(counter.count(t), seen)
    return backed/len(counter)


def without_counter(readings):
    """The readings with the counter left out."""
    return [dict(r, points=None, points_match=0.) for r in readings]


def counter_steps(readings, costs):
    """(time, points) for each rise of the counter within a life."""
    points = counter_points(readings, costs)
    return [(t1, p1-p0) for (t0, p0, l0), (t1, p1, l1) in zip(points, points[1:]) if l0 == l1 and p1 > p0]


def popup_events(readings, gap=.75, hold=2, step=100, slack=15):
    """Kills shown by the score popup: (time, kills); each ~100 rise is a kill."""
    steady, run, last = [], [], None
    for r in readings:
        if away(r):
            continue
        v, match = r.get('popup'), r.get('popup_match', 0)
        if v is None or match < POPUP_CONF:
            continue
        t = r['time']
        if last is None or t-last > gap:
            run = []
        last = t
        run = run+[(t, v)] if run and run[-1][1] == v else [(t, v)]
        if len(run) == hold or (len(run) == 1 and v >= 85 and match >= POPUP_SURE):
            if not steady or steady[-1][1] != v or t-steady[-1][2] > gap:
                steady.append((run[0][0], v, t, len(run) >= hold))
    out, prev = [], None
    for t, v, seen, held in steady:
        new = prev is None or t-prev[2] > gap
        if not new and v < prev[1]:
            prev = (prev[0], prev[1], seen)
            continue
        n = int((v-(0 if new else prev[1])+slack)//step)
        if n > 0:
            out.append((t, n if held else 1))
        prev = (t, v, seen)
    return out


def last_gasp(readings, deaths):
    """Kills shown only in the counter's last reading before a death: (time, kills)."""
    out = []
    for d in deaths:
        seen = [r for r in readings if d-2.5 <= r['time'] <= d+.5 and r.get('points') is not None
                and r.get('points_match', 0) >= COUNTER_CONF]
        if len(seen) < 2:
            continue
        last, held = seen[-1]['points'], seen[-2]['points']
        if last < held and held == seen[0]['points'] and not str(held).endswith(str(last)):
            n = int((held-last+15)//100)
            if n > 0 and plausible(held-last, seen[-1]['time']-seen[-2]['time']):
                out.append((seen[-1]['time'], n))
    return out


def fuse_kills(readings, feed, deaths, streaks, lag=(-1.5, 3.), near=3.):
    """Kill times from three layers, in order of trust:
    1. counter rises (a multi-kill jump is capped by what the popups and killfeed show);
    2. popup kills no counter kill explains;
    3. killfeed rows neither explains, when the counter rose a little, the player traded,
       or the counter could not be read."""
    costs, kill_points = streaks['costs'], streaks['kill_points']
    counter = counter_kills(readings, costs, kill_points)
    steps, popups = counter_steps(readings, costs), popup_events(readings)
    # A multi-kill jump can be a lost digit (393 then 86): the popups and killfeed cap it.
    capped = []
    for t in sorted(set(counter)):
        n = counter.count(t)
        if n > 1:
            seen = max(sum(m for p, m in popups if -2. <= p-t <= 3.), sum(1 for f in feed if -2. <= f-t <= 3.))
            n = min(n, seen) if seen else n
        capped += [t]*n
    counter = capped
    big = counter                       # popups the counter's kills explain (not its unlocks: see counter_kills)
    good = [r['time'] for r in readings if r.get('points') is not None and r.get('points_match', 0) >= COUNTER_CONF
            and not away(r)]
    read_near = lambda t, a, b: any(t+a <= g <= t+b for g in good)
    kills = list(counter)
    for t, n in last_gasp(readings, deaths):
        if not any(abs(t-c) <= 1. for c in big):
            kills += [t]*n
    # Next to an unconfirmed unlock, each counter kill explains only one popup kill.
    points = counter_points(readings, costs, streaks=True)
    unlocks = [t for (_, _, l0, k0, _), (t, _, l1, k1, lit) in zip(points, points[1:]) if l0 == l1 and k1 > k0 and not lit]
    spare = list(big)
    for t, n in popups:
        if not any(-near <= t-u <= lag[1] for u in unlocks):
            explained = any(lag[0] <= t-c <= lag[1] for c in big)
            if not explained and not any(abs(t-k) <= near for k in kills) and read_near(t, -5., 3.):
                kills += [t-.5]*n
            continue
        unexplained = 0
        for _ in range(n):
            c = next((c for c in spare if -near <= t-c <= lag[1]), None)
            if c is None:
                unexplained += 1
            else:
                spare.remove(c)
        if unexplained and not any(abs(t-k) <= near for k in kills[len(counter):]) and read_near(t, -5., 3.):
            kills += [t-.5]*unexplained
    kills.sort()
    # A counter kill explains a killfeed row from 2 s before it to 3 s after.
    sees = lambda f, k: -2. <= f-k <= 3. if k in counter else abs(f-k) <= near
    added, explained = [], [f for f in feed if any(sees(f, k) for k in kills)]
    # Where the counter comes back after over 2 s unread (a Predator Missile's view hides it and the
    # killfeed): counter_kills skips that rise, so a row there is the only sign of the kill.
    returns = [b for a, b in zip(good, good[1:]) if b-a > 2.]
    for f in sorted(feed):
        if any(sees(f, k) for k in kills) or any(0 < abs(f-k) <= 1. for k in added):
            continue
        if any(0 < f-e <= 4. for e in explained):
            continue                    # the same row seen again as it moves down the killfeed
        small = any(abs(t-f) <= 2.5 and 20 <= p < 85 for t, p in steps)
        trade = any(-1 <= d-f <= near for d in deaths)
        back = any(-2 <= b-f <= 2 for b in returns)
        if small or trade or back or not read_near(f, -2., 2.):
            added.append(f)
    # Counter kills at the killfeed's (earlier) time where it saw the same kill.
    used, timed = set(), []
    for k in kills:
        f = next((i for i, x in enumerate(sorted(feed)) if i not in used and k-2. <= x <= k+1.), None)
        if f is not None and k in counter:
            used.add(f)
            timed.append(sorted(feed)[f])
        else:
            timed.append(k)
    return sorted(timed+added)


def live_events(kill_times, interval):
    """Kill events in the shape main.find_clips uses."""
    return [dict(time=t, earliest=round(max(0., t-interval), 3), count=1, total=i+1, segment=0)
            for i, t in enumerate(sorted(kill_times))]


def live_ranges(readings, deaths, settle):
    """Excluded intervals: deaths until the player's view is back, and other away stretches."""
    ranges, run = [], None
    for r in readings+[None]:
        if r is not None and away(r):
            run = run or [r['time'], r['time']]
            run[1] = r['time']
        elif run:
            end = (r['time'] if r is not None else run[1])+settle
            ranges.append(dict(start=run[0], end=end, cuts=[run[0]], away=True))
            run = None
    for d in deaths:
        back = next((s['end'] for s in ranges if s['start'] >= d and s['start']-d <= 6), d+settle)
        ranges.append(dict(start=d, end=back, cuts=[d], away=False))
    return ranges
