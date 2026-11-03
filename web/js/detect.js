// Kill detection, death exclusion and streak rules, ported one-to-one from main.py and
// video_analysis.py so the results can be compared with the Python tool's.
import { round } from './cv.js';

export const NAME_MATCH = .78;

export function timestamp(seconds) {
  let ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

const who = (r) => (r.who ?? 1);

/** The kill count never goes down within a match: keep the best-supported non-decreasing runs. */
function monotonicRuns(runs) {
  if (!runs.length) return runs;
  const best = runs.map((r) => r.samples), previous = runs.map(() => null);
  runs.forEach((run, i) => {
    for (let j = 0; j < i; j++) {
      if (runs[j].count <= run.count && best[j] + run.samples > best[i]) {
        best[i] = best[j] + run.samples;
        previous[i] = j;
      }
    }
  });
  let i = best.indexOf(Math.max(...best));
  const kept = [];
  while (i !== null) { kept.push(runs[i]); i = previous[i]; }
  return kept.reverse();
}

/** Repeated counter readings become kill events; individual kills are never invented in unseen gaps. */
export function detectEvents(readings, maxObservationGap = 2.0, maxUnseenGap = 8.0) {
  const runs = [];
  for (const reading of readings) {
    const value = reading.count;
    if (value === undefined || value === null || value < 0 || value > 200) continue;
    const t = reading.time, last = runs[runs.length - 1];
    if (last && value === last.count && t - last.last <= maxObservationGap) {
      last.last = t;
      last.samples += 1;
    } else {
      runs.push({ count: value, first: t, last: t, samples: 1 });
    }
  }
  const stable = monotonicRuns(runs.filter((r) => r.samples >= 2));
  const events = [], warnings = [];
  let previous = null, segment = 0;
  for (const run of stable) {
    if (previous === null) { previous = run; continue; }
    const delta = run.count - previous.count, gap = run.first - previous.last;
    if (delta === 0) { previous = run; continue; }
    const unseenOk = delta <= 2 && gap <= maxUnseenGap;
    if (delta < 0 || delta > 4 || (gap > maxObservationGap && !unseenOk)) {
      warnings.push({ start: previous.last, end: run.first, before: previous.count, after: run.count });
      segment += 1;
    } else {
      events.push({ time: run.first, earliest: previous.last, count: delta, total: run.count, segment });
    }
    previous = run;
  }
  return { events, warnings };
}

/** Union overlapping qualifying windows; padding alone never merges unrelated streaks. */
export function findClips(events, duration, { min_kills = 4, window = 25, max_gap = 16, pre = 3, post = 3 } = {}, excluded = []) {
  const windows = [];
  events.forEach((first, i) => {
    let kills = 0;
    for (let j = i; j < events.length; j++) {
      const event = events[j];
      // A window or max_gap of null is no limit: every run of min_kills+ kills in one life is a clip.
      if (!sameSegment(event.segment, first.segment) || (window != null && event.time - first.time > window)) break;
      if (j > i && max_gap != null && event.time - events[j - 1].time > max_gap) break;
      kills += event.count;
      if (kills >= min_kills) windows.push([i, j]);
    }
  });
  const merged = [];
  for (const [start, end] of windows) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(end, last[1]);
    else merged.push([start, end]);
  }
  return merged.map(([i, j], n) => {
    const selected = events.slice(i, j + 1), first = selected[0], last = selected[selected.length - 1];
    let start = Math.max(0, first.earliest - pre), end = Math.min(duration, last.time + post);
    for (const span of excluded) {
      if (span.end < first.earliest) start = Math.max(start, span.end);
      if (span.start >= last.earliest) {
        // A death that begins while the last kill is registering is a trade: end just after the kill.
        const trade = span.start <= last.time && span.start - last.earliest <= .55;
        end = Math.min(end, trade ? last.time + .1 : span.start);
      }
    }
    return {
      id: n + 1, start: round(start), end: round(end),
      start_timestamp: timestamp(start), end_timestamp: timestamp(end),
      kills: selected.reduce((s, e) => s + e.count, 0),
      action_span: round(last.time - first.earliest),
      kill_times: selected.map((e) => e.time),
      counter_before: first.total - first.count, counter_after: last.total,
    };
  });
}

// separate_lives turns segment into the pair (segment, life); compare pairs by value.
const sameSegment = (a, b) => (Array.isArray(a) ? a[0] === b[0] && a[1] === b[1] : a === b);

export function separateLives(events, excluded) {
  const result = [];
  for (const event of events) {
    const afterDeath = (span) => {
      if (event.earliest < span.start || event.earliest > span.end) return false;
      const trade = event.earliest - span.start < .05 && event.time - event.earliest <= .75;
      return !trade;
    };
    if (excluded.some(afterDeath)) continue;
    const life = excluded.filter((span) => span.end < event.earliest).length;
    result.push({ ...event, segment: [event.segment, life] });
  }
  return result;
}

export function mergeRanges(...groups) {
  const merged = [];
  for (const span of groups.flat().sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + .5) {
      last.end = Math.max(last.end, span.end);
      last.cuts.push(...span.cuts);
    } else {
      merged.push({ ...span, cuts: [...span.cuts] });
    }
  }
  return merged;
}

/** Rotation-compensated minimap jump, or a minimap that no longer matches (browser checks never teleport). */
function teleported(check, mapShift) {
  if (!('map_shift' in check)) return false;
  if (check.map_shift === null || (check.map_inliers ?? 0) < 5) return true;
  return check.map_shift >= mapShift;
}

/** A respawn refills the bar at once; a sliver of HP healing back gradually is a living player. */
function endsInRespawn(samples, index, lookahead = 2) {
  const after = samples.slice(index, index + lookahead);
  if (!after.length) return true;
  if (after.some((r) => who(r) < NAME_MATCH)) return true;
  return after.some((r) => r.hp >= .95);
}

function lowHpRuns(samples, low = .2, bridge = 2) {
  const runs = [];
  let run = [], misses = 0;
  samples.forEach((row, index) => {
    if (row.hp < low) {
      run.push(index);
      misses = 0;
    } else if (run.length) {
      misses += 1;
      if (misses > bridge) { runs.push(run); run = []; misses = 0; }
    }
  });
  if (run.length) runs.push(run);
  return runs;
}

/** Deaths from the HP bar: an empty bar refilled to full within about two seconds, or a confirmed instant refill. */
export function hpDeathRanges(readings, settle, { empty = .1, minSamples = 2, checks = [], guard = 4, mapShift = .18, respawnWithin = 4 } = {}) {
  const ranges = [];
  const samples = readings.filter((r) => 'hp' in r);
  for (const run of lowHpRuns(samples)) {
    if (run.length < minSamples || Math.min(...run.map((i) => samples[i].hp)) >= empty) continue;
    const nxt = run[run.length - 1] + 1;
    if (!endsInRespawn(samples, nxt, respawnWithin)) continue;
    const first = samples[run[0]].time;
    const before = run[0] ? Math.max(samples[run[0] - 1].time, first - 1) : first;
    let refill = samples[Math.min(nxt, samples.length - 1)].time;
    for (let i = nxt; i < Math.min(nxt + respawnWithin, samples.length); i++) {
      if (samples[i].hp >= .95) { refill = samples[i].time; break; }
    }
    ranges.push({ start: before, end: refill + settle, cuts: [samples[run[0]].time] });
  }
  const hp = samples.map((r) => [r.time, r.hp]);
  for (const check of checks) {
    if (!(check.from_hp < .15 || teleported(check, mapShift))) continue;
    let start = check.time;
    const earlier = hp.filter((p) => p[0] < check.time).reverse();
    for (const [t, value] of earlier) {
      if (value >= .65 || check.time - t > guard) break;
      start = t;
    }
    ranges.push({ start, end: check.time + settle, cuts: [check.time] });
  }
  return mergeRanges(ranges);
}

/** Stretches where the panel shows someone else or nothing (dead, between rounds, match over). */
export function awayRanges(readings, settle, threshold = NAME_MATCH, minSamples = 2) {
  const ranges = [];
  const samples = readings.filter((r) => 'who' in r);
  let run = [];
  [...samples, null].forEach((row, index) => {
    if (row !== null && row.who < threshold) { run.push(index); return; }
    if (run.length >= minSamples) {
      const start = run[0] ? samples[run[0] - 1].time : samples[run[0]].time;
      const end = (row !== null ? row.time : samples[run[run.length - 1]].time) + settle;
      ranges.push({ start, end, cuts: [samples[run[0]].time], away: true });
    }
    run = [];
  });
  return ranges;
}

/** A round-panel COMBO that falls back to 0 (two steady readings each way) means the player died. */
export function comboDeathRanges(readings, settle) {
  const samples = readings.filter((r) => 'combo_zero' in r && who(r) >= NAME_MATCH);
  const rises = [];
  let last = null;
  for (const r of samples) {
    if ('count' in r) {
      if (last !== null && r.count > last) rises.push(r.time);
      last = last === null ? r.count : Math.max(last, r.count);
    }
  }
  const clear = samples.filter((r) => r.combo_zero >= .55 || r.combo_zero <= .45);
  const ranges = [];
  let state = null, spell = [], lastNonzero = null;
  for (let i = 0; i + 1 < clear.length; i++) {
    const a = clear[i], b = clear[i + 1];
    const zeroA = a.combo_zero >= .55, zeroB = b.combo_zero >= .55;
    if (zeroA !== zeroB) continue;
    if (!zeroA) {
      if (state !== false) spell = [];
      spell.push(a, b);
      lastNonzero = b;
    } else if (state === false) {
      const solid = [...new Set(spell)].filter((r) => r.combo_zero <= .4).length >= 2;
      const earned = rises.some((t) => spell[0].time - 2 <= t && t <= lastNonzero.time);
      if (solid && earned) ranges.push({ start: lastNonzero.time, end: a.time + settle, cuts: [a.time] });
    }
    state = zeroA;
  }
  return ranges;
}

/** match_end_readings, first half: {start, base} for reading the replay-layout panel, or null. */
export function matchEndPlan(scan) {
  const { readings } = scan;
  let last = -1;
  readings.forEach((r, i) => { if (who(r) >= NAME_MATCH) last = i; });
  if (last < 0 || last === readings.length - 1 || !scan.roi) return null;
  const counts = readings.slice(0, last + 1).filter((r) => 'count' in r && who(r) >= NAME_MATCH).map((r) => r.count);
  if (!counts.length) return null;
  const tail = counts.slice(-6);
  // max(tail, key=tail.count): the most frequent value, the first one on ties.
  let base = tail[0];
  for (const v of tail) if (tail.filter((x) => x === v).length > tail.filter((x) => x === base).length) base = v;
  return { start: readings[last].time, base };
}

/** add_match_end's splice: put the replay-panel readings in place of what was read in that stretch. */
export function spliceMatchEnd(scan, final, switchTime) {
  if (!final.length) return;
  const lastFinal = final[final.length - 1].time;
  scan.readings = [...scan.readings.filter((r) => r.time <= switchTime), ...final,
    ...scan.readings.filter((r) => r.time > lastFinal)];
}

/** kills² over the clip's length in seconds: big streaks first, then fast ones. Squaring the kills lets an
 * 8 kill 40 s clip (1.6) beat a 3 kill 15 s one (0.6), and a 10 kill 60 s clip (1.67) beat a 4 kill 20 s one (0.8). */
export function score(clip) {
  return round(clip.kills ** 2 / Math.max(clip.end - clip.start, 1), 4);
}

/** main.process after the scan: kill events, excluded intervals and ranked streaks. */
export function analyse(scan, rules, matchEnd = { final: [], switchTime: null }) {
  const { final, switchTime } = matchEnd;
  const followed = scan.readings.filter((r) => who(r) >= NAME_MATCH);
  const { events, warnings } = detectEvents(followed);
  let excluded = mergeRanges(
    hpDeathRanges(scan.readings, rules.respawn_settle, {
      checks: scan.respawn_checks || [], guard: rules.death_guard, mapShift: rules.map_shift,
    }),
    awayRanges(scan.readings, rules.respawn_settle),
    comboDeathRanges(scan.readings, rules.respawn_settle));
  let playEnd = scan.duration;
  if (final.length) {
    playEnd = final[0].time + .75;
    excluded = excluded.filter((s) => s.start < switchTime);
  }
  const lives = separateLives(events, excluded), clips = findClips(lives, playEnd, rules, excluded);
  for (const clip of clips) clip.score = score(clip);
  const ranking = [...clips].sort((a, b) => b.score - a.score || b.kills - a.kills).map((c) => c.id);
  return { events, warnings, excluded, clips, ranking };
}

/** main.finish_live: kills from the killfeed, deaths from the killfeed and killcams, ranked streaks. */
export function analyseLive(scan, kills, deaths, ranges, rules) {
  const events = [...kills].sort((a, b) => a - b).map((t, i) => (
    { time: t, earliest: round(Math.max(0, t - scan.interval), 3), count: 1, total: i + 1, segment: 0 }));
  const excluded = mergeRanges(ranges);
  const lives = separateLives(events, excluded), clips = findClips(lives, scan.duration, rules, excluded);
  for (const clip of clips) clip.score = score(clip);
  const ranking = [...clips].sort((a, b) => b.score - a.score || b.kills - a.kills).map((c) => c.id);
  return { events, warnings: [], excluded, clips, ranking, deaths };
}

/** Per-kill times (an event of 2 kills counts twice). */
export const killTimes = (events) => events.flatMap((e) => Array(e.count).fill(e.time));

/** Match kills to the answer key one to one within `tolerance` s; streaks match when their spans overlap. */
export function compare(found, key, tolerance = 1.5) {
  const mine = killTimes(found.events), theirs = key.kills.flatMap((e) => Array(e.count).fill(e.time));
  const used = new Set(), matched = [], missed = [];
  for (const t of theirs) {
    let bestIndex = -1;
    mine.forEach((m, i) => {
      if (!used.has(i) && Math.abs(m - t) <= tolerance && (bestIndex < 0 || Math.abs(m - t) < Math.abs(mine[bestIndex] - t))) bestIndex = i;
    });
    if (bestIndex < 0) missed.push(t);
    else { used.add(bestIndex); matched.push([t, mine[bestIndex]]); }
  }
  const extra = mine.filter((_, i) => !used.has(i));
  const overlaps = (a, b) => a.kill_times[0] <= b.kill_times[b.kill_times.length - 1] + tolerance
    && b.kill_times[0] <= a.kill_times[a.kill_times.length - 1] + tolerance;
  const keyClips = key.clips || [];
  const streaksMatched = keyClips.filter((k) => found.clips.some((c) => overlaps(c, k))).length;
  const offsets = matched.map(([a, b]) => b - a);
  return {
    keyKills: theirs.length, foundKills: mine.length, matched: matched.length, missed, extra,
    recall: theirs.length ? matched.length / theirs.length : 1,
    meanOffset: offsets.length ? offsets.reduce((s, v) => s + v, 0) / offsets.length : 0,
    keyStreaks: keyClips.length, foundStreaks: found.clips.length, streaksMatched,
    deaths: key.deaths && found.deaths ? compareTimes(found.deaths, key.deaths, tolerance) : null,
  };
}

/** Deaths matched one to one within `tolerance` seconds. */
function compareTimes(mine, theirs, tolerance) {
  const used = new Set();
  let matched = 0;
  for (const t of theirs) {
    const i = mine.findIndex((m, j) => !used.has(j) && Math.abs(m - t) <= tolerance);
    if (i >= 0) { used.add(i); matched++; }
  }
  return { matched, keyDeaths: theirs.length, foundDeaths: mine.length };
}
