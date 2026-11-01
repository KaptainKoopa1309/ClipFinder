"""Speed-ramped cutting: the middle of long gaps between kills plays faster."""
import subprocess
import imageio_ffmpeg


def speed_segments(start, end, kills, base=1.15, long_gap=8., keep=2., fast=2.5):
    """Split the source range [start, end] into (from, to, speed) pieces."""
    kills = sorted(k for k in kills if start <= k <= end)
    pieces, cursor = [], start
    for a, b in zip(kills, kills[1:]):
        if b-a > long_gap:
            fast_from, fast_to = a+keep, b-keep
            pieces.append((cursor, fast_from, base))
            pieces.append((fast_from, fast_to, fast))
            cursor = fast_to
    pieces.append((cursor, end, base))
    return [p for p in pieces if p[1]-p[0] > .05]


def played_length(pieces, start=None, end=None):
    """Seconds the pieces take to play, optionally only the source range [start, end]."""
    total = 0.
    for a, b, speed in pieces:
        a, b = max(a, start if start is not None else a), min(b, end if end is not None else b)
        if b > a:
            total += (b-a)/speed
    return total


def cut_ramped(video, pieces, target, fps=60):
    """Cut the pieces from `video` with their speeds and join them into `target`."""
    start, end = pieces[0][0], pieces[-1][1]
    graph, labels = [], ''
    for i, (a, b, speed) in enumerate(pieces):
        a, b = a-start, b-start
        graph.append(f'[0:v]trim={a:.3f}:{b:.3f},setpts=(PTS-STARTPTS)/{speed}[v{i}]')
        graph.append(f'[0:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS,atempo={speed}[a{i}]')
        labels += f'[v{i}][a{i}]'
    graph.append(f'{labels}concat=n={len(pieces)}:v=1:a=1[vc][a]')
    # Frames are already turned upright; drop the source's rotate tag so players don't turn them again.
    graph.append(f'[vc]fps={fps},sidedata=mode=delete:type=DISPLAYMATRIX[v]')
    command = [imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-loglevel', 'error',
               '-ss', f'{start:.3f}', '-t', f'{end-start:.3f}', '-i', str(video),
               '-filter_complex', ';'.join(graph), '-map', '[v]', '-map', '[a]',
               '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac',
               '-movflags', '+faststart', str(target)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError(f'ffmpeg failed on {target}: {result.stderr.strip()[-300:]}')
