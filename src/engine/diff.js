import { splitLines } from './bytes.js';

/** Trim shared prefix/suffix, then run Myers O(ND) on the remaining middle. */
export function diffLines(a, b) {
  const aLines = Array.isArray(a) ? a : splitLines(a);
  const bLines = Array.isArray(b) ? b : splitLines(b);

  let start = 0;
  while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) start++;
  let endA = aLines.length;
  let endB = bLines.length;
  while (endA > start && endB > start && aLines[endA - 1] === bLines[endB - 1]) {
    endA--;
    endB--;
  }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'ctx', line: aLines[i], aIndex: i, bIndex: i });
  for (const op of middleDiff(aLines.slice(start, endA), bLines.slice(start, endB))) {
    if (op.type === 'ctx') ops.push({ ...op, aIndex: op.aIndex + start, bIndex: op.bIndex + start });
    else if (op.type === 'del') ops.push({ ...op, aIndex: op.index + start });
    else ops.push({ ...op, bIndex: op.index + start });
  }
  for (let i = endA, j = endB; i < aLines.length; i++, j++) {
    ops.push({ type: 'ctx', line: aLines[i], aIndex: i, bIndex: j });
  }
  return ops;
}

function middleDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return b.map((line, index) => ({ type: 'add', line, index }));
  if (!m) return a.map((line, index) => ({ type: 'del', line, index }));

  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  v[offset + 1] = 0;
  for (let d = 0; d <= max; d++) {
    trace.push(Int32Array.from(v));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + x - y] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset);
    }
  }
  return backtrack(trace, a, b, offset);
}

function backtrack(trace, a, b, offset) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'ctx', line: a[x - 1], aIndex: x - 1, bIndex: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: 'add', line: b[prevY], index: prevY });
      else ops.push({ type: 'del', line: a[prevX], index: prevX });
      x = prevX;
      y = prevY;
    }
  }
  return ops.reverse();
}

const HUNK_CONTEXT = 3;

export function isBinary(text) {
  return typeof text === 'string' && text.includes('\0');
}

/**
 * Unified diff in Git's default format. Blob hashes are passed in so the
 * `index abc1234..def5678` line matches what real Git prints.
 */
export function formatDiff(path, before, after, { oldMode = '100644', newMode = '100644', oldHash = null, newHash = null } = {}) {
  const out = [`diff --git a/${path} b/${path}`];
  if (oldMode !== newMode) {
    out.push(`old mode ${oldMode}`, `new mode ${newMode}`);
    out.push(`index ${short(oldHash)}..${short(newHash)}`);
  } else if (before === null) {
    out.push(`new file mode ${newMode}`, `index 0000000..${short(newHash)}`);
  } else if (after === null) {
    out.push(`deleted file mode ${oldMode}`, `index ${short(oldHash)}..0000000`);
  } else {
    out.push(`index ${short(oldHash)}..${short(newHash)} ${oldMode}`);
  }
  out.push(before === null ? '--- /dev/null' : `--- a/${path}`, after === null ? '+++ /dev/null' : `+++ b/${path}`);

  if (isBinary(before || '') || isBinary(after || '')) {
    out.push(`Binary files a/${path} and b/${path} differ`);
    return out;
  }

  const ops = diffLines(before ?? '', after ?? '');
  for (const hunk of hunks(ops)) {
    out.push(`@@ -${range(hunk.oldStart, hunk.oldCount)} +${range(hunk.newStart, hunk.newCount)} @@`);
    for (const op of hunk.ops) {
      out.push(`${op.type === 'ctx' ? ' ' : op.type === 'del' ? '-' : '+'}${op.line}`);
    }
  }
  return out;
}

/** Git leaves out ",1" but keeps ",0" for an empty side of a hunk. */
function range(start, count) {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function short(hash) {
  return hash ? hash.slice(0, 7) : '0000000';
}

/**
 * Combined diff for an unmerged path, in Git's `diff --cc` shape: one prefix
 * column per parent (stage 2 = ours, stage 3 = theirs), then the working-tree
 * result. `++` is a line in neither parent, `+ ` / ` +` a line from one side
 * only, `  ` a line both parents share, and `-` a line a parent still has but
 * the result dropped.
 */
export function combinedDiff(path, parents, result, { deleted = false } = {}) {
  const marks = '@'.repeat(parents.length + 1);
  const out = [`diff --${'c'.repeat(parents.length)} ${path}`];
  out.push(`index ${parents.map((parent) => short(parent.hash)).join(',')}..0000000`);
  if (deleted) {
    out.push(`deleted file mode ${parents.map((parent) => parent.mode ?? '100644').join(',')}`);
    out.push(`--- a/${path}`, '+++ /dev/null');
    return out;
  }
  out.push(`--- a/${path}`, `+++ b/${path}`);

  // The result matching one parent exactly is not a merge worth showing: Git
  // still lists the file, but there is nothing left to explain.
  if (parents.some((parent) => parent.content === result)) return out;

  const resultLines = splitLines(result);
  // Per parent: the parent line each result line lines up with (null when the
  // result line is new to that parent), plus the parent lines the result
  // dropped, each tagged with the gap it sat in.
  const matches = parents.map(() => new Array(resultLines.length).fill(null));
  const lost = parents.map(() => []);
  parents.forEach((parent, p) => {
    let j = 0;
    for (const op of diffLines(splitLines(parent.content), resultLines)) {
      if (op.type === 'ctx') matches[p][j] = op.aIndex;
      else if (op.type === 'add') matches[p][j] = null;
      else lost[p].push({ line: op.line, at: op.aIndex, gap: j });
      if (op.type !== 'del') j++;
    }
  });

  // A position is interesting when a result line is new to some parent, or when
  // a parent line was dropped there. Positions run over result lines plus the
  // gap after the last one, so 0..resultLines.length.
  const interesting = new Set();
  resultLines.forEach((_, j) => {
    if (matches.some((match) => match[j] === null)) interesting.add(j);
  });
  lost.forEach((entries) => entries.forEach((entry) => interesting.add(entry.gap)));

  const groups = [];
  for (const position of [...interesting].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last && position - last.stop <= HUNK_CONTEXT * 2) last.stop = position + 1;
    else groups.push({ start: position, stop: position + 1 });
  }

  groups.forEach((group, index) => {
    const previousStop = index === 0 ? 0 : groups[index - 1].stop;
    const nextStart = index === groups.length - 1 ? resultLines.length + 1 : groups[index + 1].start;
    const start = Math.max(previousStop, group.start - HUNK_CONTEXT);
    const stop = Math.min(nextStart, group.stop + HUNK_CONTEXT);
    const inRange = (position) => position >= start && position < stop;

    const ranges = parents.map((_, p) => {
      const covered = matches[p].map((at, j) => (inRange(j) && at !== null ? at : null)).filter((at) => at !== null);
      for (const entry of lost[p]) if (inRange(entry.gap)) covered.push(entry.at);
      if (!covered.length) return `-${linesBefore(matches[p], lost[p], start)},0`;
      const first = Math.min(...covered);
      return `-${first + 1},${Math.max(...covered) - first + 1}`;
    });
    const resultCount = Math.max(0, Math.min(stop, resultLines.length) - Math.min(start, resultLines.length));
    const first = Math.min(start, resultLines.length);
    ranges.push(`+${resultCount ? `${first + 1},${resultCount}` : `${start},0`}`);
    out.push(`${marks} ${ranges.join(' ')} ${marks}`);

    for (let position = start; position < stop; position++) {
      // A dropped line shows `-` in the column of every parent that still had
      // it; when both parents dropped the same line they share one output line.
      const emitted = [];
      parents.forEach((_, p) => {
        for (const entry of lost[p]) {
          if (entry.gap !== position) continue;
          const shared = [...emitted].reverse().find((item) => item.line === entry.line && !item.cols.has(p));
          if (shared) shared.cols.add(p);
          else emitted.push({ line: entry.line, cols: new Set([p]) });
        }
      });
      for (const item of emitted) {
        out.push(`${parents.map((_, p) => (item.cols.has(p) ? '-' : ' ')).join('')}${item.line}`);
      }
      if (position < resultLines.length) {
        out.push(`${matches.map((match) => (match[position] === null ? '+' : ' ')).join('')}${resultLines[position]}`);
      }
    }
  });

  return out;
}

/** Parent lines that come before `position`, for a hunk whose side is empty. */
function linesBefore(match, entries, position) {
  let count = match.slice(0, position).filter((at) => at !== null).length;
  for (const entry of entries) if (entry.gap < position) count++;
  return count;
}

/** Group an edit script into hunks with at most HUNK_CONTEXT lines of context. */
function hunks(ops) {
  const positions = [];
  let aLine = 0;
  let bLine = 0;
  for (const op of ops) {
    positions.push({ a: aLine, b: bLine });
    if (op.type !== 'add') aLine++;
    if (op.type !== 'del') bLine++;
  }
  const changed = [];
  ops.forEach((op, i) => {
    if (op.type !== 'ctx') changed.push(i);
  });

  const groups = [];
  for (const i of changed) {
    const last = groups[groups.length - 1];
    if (last && i - last.rawStop <= HUNK_CONTEXT * 2) {
      last.rawStop = i + 1;
    } else {
      groups.push({ rawStart: i, rawStop: i + 1 });
    }
  }

  const result = [];
  groups.forEach((group, index) => {
    const previousStop = index === 0 ? 0 : groups[index - 1].rawStop;
    const nextStart = index === groups.length - 1 ? ops.length : groups[index + 1].rawStart;
    const start = Math.max(previousStop, group.rawStart - HUNK_CONTEXT);
    const stop = Math.min(nextStart, group.rawStop + HUNK_CONTEXT);
    const slice = ops.slice(start, stop);
    const oldCount = slice.filter((op) => op.type !== 'add').length;
    const newCount = slice.filter((op) => op.type !== 'del').length;
    // A hunk's start line is the last line *before* it when that side of the
    // hunk is empty (a pure insertion has no old lines to point at), and the
    // first line it touches otherwise. Counting the lines is what decides it —
    // looking at the first op is wrong for a hunk that both deletes and adds.
    result.push({
      ops: slice,
      oldStart: positions[start].a + (oldCount === 0 ? 0 : 1),
      newStart: positions[start].b + (newCount === 0 ? 0 : 1),
      oldCount,
      newCount,
    });
  });
  return result;
}

/**
 * Line-based three-way merge. Overlapping edits from both sides become
 * conflict markers written straight into the file, like Git does.
 */
export function mergeText(base, ours, theirs, { oursLabel = 'HEAD', theirsLabel = '' } = {}) {
  const baseLines = splitLines(base);
  const ourText = asText(ours);
  const theirText = asText(theirs);
  if (ourText === theirText) return { text: ourText, conflicted: false };

  const ourRegions = regionsFor(diffLines(baseLines, asLines(ours)));
  const theirRegions = regionsFor(diffLines(baseLines, asLines(theirs)));
  if (!ourRegions.length) return { text: theirText, conflicted: false };
  if (!theirRegions.length) return { text: ourText, conflicted: false };

  const result = [];
  let hasConflict = false;
  let consumed = 0;
  for (const cluster of clusterRegions(ourRegions, theirRegions)) {
    for (let i = consumed; i < cluster.start; i++) result.push(baseLines[i]);
    const mine = renderSide(baseLines, cluster, ourRegions);
    const yours = renderSide(baseLines, cluster, theirRegions);
    const base = baseLines.slice(cluster.start, cluster.end);
    // 三方合并的规则：只有一边动过，就采用那一边；两边都动过才冲突。
    if (mine.join('\n') === base.join('\n')) result.push(...yours);
    else if (yours.join('\n') === base.join('\n')) result.push(...mine);
    else if (mine.join('\n') === yours.join('\n')) result.push(...mine);
    else {
      hasConflict = true;
      result.push(`<<<<<<< ${oursLabel}`, ...mine, '=======', ...yours, theirsLabel ? `>>>>>>> ${theirsLabel}` : '>');
    }
    consumed = cluster.end;
  }
  for (let i = consumed; i < baseLines.length; i++) result.push(baseLines[i]);

  return { text: result.length ? `${result.join('\n')}\n` : '', conflicted: hasConflict };
}

function asLines(value) {
  return Array.isArray(value) ? value : splitLines(value);
}

function asText(value) {
  return typeof value === 'string' ? value : value.length ? `${value.join('\n')}\n` : '';
}

/** Turn an edit script into base-coordinate regions plus the text replacing them. */
function regionsFor(ops) {
  const regions = [];
  let i = 0;
  let lastContext = -1;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === 'ctx') {
      lastContext = op.aIndex;
      i++;
      continue;
    }
    const lines = [];
    let start = null;
    let end = null;
    while (i < ops.length && ops[i].type !== 'ctx') {
      if (ops[i].type === 'del') {
        if (start === null) start = ops[i].aIndex;
        end = ops[i].aIndex + 1;
      } else {
        lines.push(ops[i].line);
      }
      i++;
    }
    if (start === null) {
      start = lastContext + 1;
      end = start;
    }
    regions.push({ start, end, lines });
  }
  return regions;
}

/**
 * Group our/their regions whose spans overlap; each group is one merge block.
 * Two regions that merely touch (one ends where the next begins) stay apart,
 * so edits on different lines merge cleanly — but two insertions at the same
 * offset do overlap and become one conflict.
 */
function clusterRegions(ours, theirs) {
  const all = [...ours.map((r) => ({ ...r, side: 'ours' })), ...theirs.map((r) => ({ ...r, side: 'theirs' }))].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  const clusters = [];
  const overlaps = (last, region) =>
    region.start < last.end ||
    (region.start === last.end && last.start === last.end && region.start === region.end);
  for (const region of all) {
    const last = clusters[clusters.length - 1];
    if (last && overlaps(last, region)) {
      last.end = Math.max(last.end, region.end);
      last.sides.add(region.side);
    } else {
      clusters.push({ start: region.start, end: Math.max(region.end, region.start), sides: new Set([region.side]) });
    }
  }
  return clusters;
}

function renderSide(baseLines, cluster, regions) {
  // A region that only inserts (start === end, e.g. both sides added a file)
  // still belongs to the cluster that starts at the same offset.
  const byStart = new Map(
    regions.filter((r) => r.start >= cluster.start && (r.start < cluster.end || (r.start === cluster.end && cluster.start === cluster.end))).map((r) => [r.start, r]),
  );
  const out = [];
  let i = cluster.start;
  // A zero-length cluster still has a region to render, so the loop condition
  // cannot be `i < cluster.end` alone.
  while (i < cluster.end || byStart.has(i)) {
    const region = byStart.get(i);
    if (region) {
      out.push(...region.lines);
      i = Math.max(region.end, i + 1);
      continue;
    }
    if (i < baseLines.length) out.push(baseLines[i]);
    i++;
  }
  return out;
}

/** merge-base: nearest common ancestor(s) by commit date, like Git's default. */
export function unchanged(a, b) {
  return a === b;
}
