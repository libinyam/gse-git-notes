import { parseCommit, parseTag, compareText } from './repo.js';
import { splitLines } from './bytes.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function zoneMinutes(tz) {
  const sign = tz[0] === '-' ? -1 : 1;
  return sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
}

/** Git's default date: "Tue Nov 14 23:33:20 2023 +0800", rendered in the commit's own zone. */
export function formatDate(timestamp, tz) {
  const local = new Date((timestamp + zoneMinutes(tz) * 60) * 1000);
  const time = [local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${DAYS[local.getUTCDay()]} ${MONTHS[local.getUTCMonth()]} ${String(local.getUTCDate()).padStart(2, ' ')} ${time} ${local.getUTCFullYear()} ${tz}`;
}

export function shortDate(timestamp, tz) {
  const local = new Date((timestamp + zoneMinutes(tz) * 60) * 1000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
}

/** "2023-11-15 06:13:20 +0800", the date shape `git blame` prints. */
export function isoDate(timestamp, tz) {
  const local = new Date((timestamp + zoneMinutes(tz) * 60) * 1000);
  const time = [local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const date = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
  return `${date} ${time} ${tz}`;
}

/** ["HEAD -> main", "origin/main", "tag: v1"] for a commit row. */export function decorations(repo, hash, { includeHead = true } = {}) {
  const items = [];
  const branch = repo.headBranch();
  const detached = repo.isDetached();
  for (const [name, target] of [...repo.refs].sort((a, b) => compareRefKind(a[0]) - compareRefKind(b[0]) || compareText(a[0], b[0]))) {
    if (name === 'refs/stash') continue;
    const object = repo.objects.get(target);
    const resolved = object?.type === 'tag' ? parseTag(target, repo.objects).object : target;
    if (resolved !== hash) continue;
    if (name.startsWith('refs/heads/')) {
      const short = name.slice('refs/heads/'.length);
      if (includeHead && branch === short) items.push(`HEAD -> ${short}`);
      else items.push(short);
    } else if (name.startsWith('refs/remotes/')) {
      items.push(name.slice('refs/remotes/'.length));
    } else if (name.startsWith('refs/tags/')) {
      items.push(`tag: ${name.slice('refs/tags/'.length)}`);
    }
  }
  if (includeHead && detached && repo.headHash() === hash) items.unshift('HEAD');
  return items;
}

function compareRefKind(name) {
  if (name.startsWith('refs/heads/')) return 0;
  if (name.startsWith('refs/remotes/')) return 1;
  return 2;
}

/**
 * Per-path state across the three areas: HEAD vs index gives `x`,
 * index vs working tree gives `y`.
 */
export function computeStatus(repo) {
  const head = repo.headHash();
  const headTree = new Map((head ? repo.listTree(head) : []).map((entry) => [entry.path, entry]));
  const paths = [...new Set([...headTree.keys(), ...repo.index.keys(), ...repo.files.keys()])].sort(compareText);
  const entries = [];

  for (const path of paths) {
    const inHead = headTree.get(path) ?? null;
    const staged = repo.index.get(path) ?? null;
    const inWork = repo.files.has(path);
    const workContent = inWork ? repo.files.get(path) : null;
    const workHash = inWork ? repo.hashContent(workContent) : null;

    if (staged?.conflicted) {
      const [base, ours, theirs] = [1, 2, 3].map((stage) => staged.conflicted[stage]);
      let code = 'UU';
      if (!ours) code = 'DU';
      else if (!theirs) code = 'UD';
      else if (!base && ours === theirs) code = 'AA';
      entries.push({ path, x: code[0], y: code[1], conflicted: true, label: conflictLabel(code) });
      continue;
    }

    if (!staged && !inHead && inWork) {
      if (repo.isIgnored(path)) entries.push({ path, x: '!', y: '!', ignored: true });
      else entries.push({ path, x: '?', y: '?', untracked: true });
      continue;
    }

    let x = ' ';
    let y = ' ';
    if (staged && !inHead) x = 'A';
    else if (!staged && inHead) x = 'D';
    else if (staged && inHead && staged.hash !== inHead.hash) x = 'M';

    if (staged && inWork && workHash !== staged.hash) y = 'M';
    else if (staged && !inWork) y = 'D';

    if (x !== ' ' || y !== ' ') {
      entries.push({ path, x, y, headEntry: inHead, staged, workHash, label: changeLabel(x, y, inHead, staged, inWork) });
    }
  }
  return collapseUntrackedDirs(entries, repo);
}

function conflictLabel(code) {
  return { UU: 'both modified', AA: 'both added', DU: 'deleted by us', UD: 'deleted by them' }[code];
}

/** Which half of the pair explains the change, for the long-form label. */
function changeLabel(x, y, inHead, staged, inWork) {
  if (x === 'D') return 'deleted:';
  if (x === 'A') return 'new file:';
  if (y === 'D' && x === ' ') return 'deleted:';
  void inHead;
  void inWork;
  return 'modified:';
}

/** Git shows a whole untracked directory as `dir/` when nothing inside is tracked. */
function collapseUntrackedDirs(entries, repo) {
  const trackedDirs = new Set();
  for (const path of [...repo.index.keys(), ...repo.files.keys()]) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join('/'));
  }
  const untrackedDirs = new Map();
  for (const entry of entries) {
    if (!entry.untracked) continue;
    const parts = entry.path.split('/');
    if (parts.length < 2 || [...trackedDirs].some((dir) => dir !== parts.slice(0, -1).join('/') && entry.path.startsWith(`${dir}/`) && repo.index.has(entry.path))) {
      continue;
    }
    const dir = parts.slice(0, -1).join('/');
    if (!untrackedDirs.has(dir)) untrackedDirs.set(dir, []);
    untrackedDirs.get(dir).push(entry.path);
  }

  const result = [];
  const emitted = new Set();
  for (const entry of entries) {
    if (entry.untracked) {
      const dir = entry.path.split('/').slice(0, -1).join('/');
      if (dir && untrackedDirs.has(dir) && !emitted.has(dir)) {
        emitted.add(dir);
        result.push({ path: `${dir}/`, x: '?', y: '?', untracked: true, directory: true });
      }
      if (dir && untrackedDirs.has(dir)) continue;
    }
    result.push(entry);
  }
  return result;
}

export function statusShort(repo, { showIgnored = false, branch = false } = {}) {
  const lines = [];
  if (branch) {
    const branchName = repo.headBranch();
    const head = repo.headHash();
    lines.push(
      branchName
        ? `## ${branchName}${upstreamName(repo, branchName) ? `...${upstreamName(repo, branchName)}` : ''}`
        : `## HEAD (no branch)`,
    );
    void head;
  }
  for (const entry of computeStatus(repo)) {
    if (entry.ignored && !showIgnored) continue;
    lines.push(`${entry.x}${entry.y} ${entry.path}`);
  }
  return lines;
}

export function upstreamRef(repo, branch) {
  const remote = repo.common.config[`branch.${branch}.remote`];
  const merge = repo.common.config[`branch.${branch}.merge`];
  if (!remote || !merge) return null;
  return `refs/remotes/${remote}/${merge.replace(/^refs\/heads\//, '')}`;
}

export function upstreamName(repo, branch) {
  const ref = upstreamRef(repo, branch);
  return ref ? ref.slice('refs/remotes/'.length) : null;
}

export function upstreamLines(repo, branch) {
  const ref = upstreamRef(repo, branch);
  if (!ref) return [];
  const name = ref.slice('refs/remotes/'.length);
  const local = repo.refs.get(`refs/heads/${branch}`);
  const remote = repo.refs.get(ref);
  if (!local || !remote) return [`Your branch is based on '${name}', but upstream ref is gone.`];
  if (local === remote) return [`Your branch is up to date with '${name}'.`];
  const ahead = repo.uniqueCommits(local, [remote]).length;
  const behind = repo.uniqueCommits(remote, [local]).length;
  if (ahead && behind) {
    return [
      `Your branch and '${name}' have diverged,`,
      `and have ${ahead} and ${behind} different commits each, respectively.`,
      '  (use "git pull" if you want to integrate the remote branch with yours)',
    ];
  }
  if (ahead) {
    return [
      `Your branch is ahead of '${name}' by ${ahead} commit${ahead === 1 ? '' : 's'}.`,
      '  (use "git push" to publish your local commits)',
    ];
  }
  return [
    `Your branch is behind '${name}' by ${behind} commit${behind === 1 ? '' : 's'}, and can be fast-forwarded.`,
    '  (use "git pull" to update your local branch)',
  ];
}

const INDENT = '        ';

/** Long-form `git status`. */
export function statusLong(repo) {
  const entries = computeStatus(repo);
  const head = repo.headHash();
  const branch = repo.headBranch();
  const lines = [];

  if (repo.mergeState) {
    lines.push(`On branch ${branch || 'HEAD'}`);
    lines.push(repo.mergeState.mode === 'cherry-pick' ? 'You are currently cherry-picking.' : 'You have unmerged paths.');
    if (repo.mergeState.mode !== 'cherry-pick') {
      lines.push('  (fix conflicts and run "git commit")');
      lines.push('  (use "git merge --abort" to abort the merge)');
    }
  } else if (branch) {
    lines.push(`On branch ${branch}`);
    lines.push(...upstreamLines(repo, branch));
  } else {
    lines.push(`HEAD detached at ${repo.shortHash(head)}`);
    lines.push('  (use "git switch -c <branch>" to start a branch if needed)');
  }

  const staged = entries.filter((e) => !e.conflicted && !e.untracked && !e.ignored && e.x !== ' ' && e.x !== '?');
  const conflicts = entries.filter((e) => e.conflicted);
  const unstaged = entries.filter((e) => !e.conflicted && !e.untracked && e.x !== 'D' && e.y !== ' ' && e.y !== '?');
  const untracked = entries.filter((e) => e.untracked);

  if (staged.length) {
    if (!head) lines.push('', 'No commits yet', '');
    else lines.push('');
    lines.push('Changes to be committed:');
    lines.push(
      head
        ? '  (use "git restore --staged <file>..." to unstage)'
        : '  (use "git rm --cached <file>..." to unstage)',
    );
    for (const item of staged) lines.push(`${INDENT}${item.label.padEnd(12)} ${item.path}`);
  }

  if (conflicts.length) {
    lines.push('', 'Unmerged paths:', '  (use "git add <file>..." to mark resolution)');
    for (const item of conflicts) lines.push(`${INDENT}${item.label.padEnd(12)} ${item.path}`);
  }
  if (unstaged.length) {
    lines.push('', 'Changes not staged for commit:');
    lines.push('  (use "git add <file>..." to update what will be committed)');
    lines.push('  (use "git restore <file>..." to discard changes in working directory)');
    for (const item of unstaged) lines.push(`${INDENT}${item.label.padEnd(12)} ${item.path}`);
  }
  if (untracked.length) {
    lines.push('', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
    for (const item of untracked) lines.push(`${INDENT}${item.path}`);
  }

  if (!staged.length && !conflicts.length && !unstaged.length && !untracked.length) {
    lines.push('', head ? 'nothing to commit, working tree clean' : 'No commits yet');
  } else if (conflicts.length) {
    lines.push('', 'fix conflicts and then commit the result');
  } else if (!staged.length) {
    lines.push('', 'no changes added to commit (use "git add" and/or "git commit -a")');
  }
  return lines;
}

/** One `git log` entry, honouring the common pretty formats. */
export function formatCommit(repo, hash, { format = null, decorate = false } = {}) {
  const commit = parseCommit(hash, repo.objects);
  if (format === 'oneline') format = '%h %s%d';
  if (format) return [prettyLine(repo, format, hash, commit, decorate)];
  const deco = decorate ? decorations(repo, hash) : [];
  const lines = [`commit ${hash}${deco.length ? ` (${deco.join(', ')})` : ''}`];
  if (commit.parents.length > 1) lines.push(`Merge: ${commit.parents.map((parent) => repo.shortHash(parent)).join(' ')}`);
  lines.push(`Author: ${commit.author.name} <${commit.author.email}>`);
  lines.push(`Date:   ${formatDate(commit.author.timestamp, commit.author.tz)}`);
  lines.push('');
  for (const line of splitLines(commit.message.replace(/\n+$/, ''))) lines.push(`    ${line}`);
  return lines;
}

export function prettyLine(repo, format, hash, commit, decorate) {
  const body = commit.message.replace(/\n+$/, '');
  const subject = splitLines(body)[0] ?? '';
  const decoration = decorations(repo, hash);
  return format
    .replaceAll('%H', hash)
    .replaceAll('%h', repo.shortHash(hash))
    .replaceAll('%s', subject)
    .replaceAll('%f', subject.replace(/ /g, '-'))
    .replaceAll('%b', body.split('\n').slice(1).join('\n').trim())
    .replaceAll('%P', commit.parents.join(' '))
    .replaceAll('%p', commit.parents.map((parent) => repo.shortHash(parent)).join(' '))
    .replaceAll('%T', commit.tree)
    .replaceAll('%t', commit.tree.slice(0, 8))
    .replaceAll('%an', commit.author.name)
    .replaceAll('%ae', commit.author.email)
    .replaceAll('%ad', formatDate(commit.author.timestamp, commit.author.tz))
    .replaceAll('%cn', commit.committer.name)
    .replaceAll('%ce', commit.committer.email)
    .replaceAll('%cd', formatDate(commit.committer.timestamp, commit.committer.tz))
    .replaceAll('%at', String(commit.author.timestamp))
    .replaceAll('%ct', String(commit.committer.timestamp))
    .replaceAll('%d', decoration.length ? ` (${decoration.join(', ')})` : '')
    .replaceAll('%D', decoration.join(', '))
    .replaceAll('%%', '%')
    .replace(/\s+$/, '');
}

/**
 * Text `--graph`. Commit order follows the log, lanes track pending parents;
 * this approximates Git's exact column packing (the SVG view is authoritative).
 */
export function renderGraph(rows) {
  const lanes = [];
  const output = [];
  const renderRow = (get) => lanes.map((entry, index) => get(entry, index)).join('').trimEnd();

  for (const row of rows) {
    let lane = lanes.indexOf(row.hash);
    if (lane < 0) {
      lane = lanes.findIndex((entry) => entry === null);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = row.hash;
    }
    output.push(`${renderRow((entry, index) => (index === lane ? '*' : entry ? '|' : ' '))} ${row.text}`);

    const parents = row.parents;
    if (!parents.length) {
      lanes[lane] = null;
      continue;
    }
    lanes[lane] = parents[0];
    for (const parent of parents.slice(1)) {
      let target = lanes.findIndex((entry, index) => index > lane && entry === null);
      if (target < 0) target = lanes.length;
      lanes[target] = parent;
      output.push(renderRow((entry, index) => (index === target ? '\\' : entry ? '|' : ' ')));
    }
    for (let index = 0; index < lanes.length; index++) {
      if (index === lane || !lanes[index] || lanes[index] !== lanes[lane]) continue;
      output.push(renderRow((entry, i) => (i === index ? (index > lane ? '/' : '\\') : entry ? '|' : ' ')));
      lanes[index] = null;
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  }
  return output;
}

/** Diffstat lines in Git's shape: `recipe.txt | 2 +-` plus a summary. */
export function diffStat(changes) {
  const width = Math.max(...changes.map((change) => change.label.length), 0);
  const maxTotal = Math.max(1, ...changes.map((change) => change.additions + change.deletions));
  const scale = maxTotal > 40 ? 40 / maxTotal : 1;
  const lines = changes.map((change) => {
    const plus = Math.round(change.additions * scale);
    const minus = Math.round(change.deletions * scale);
    const bar = `${'+'.repeat(plus)}${'-'.repeat(minus)}`;
    return `${change.label.padEnd(width)} | ${String(change.additions + change.deletions).padStart(4)} ${bar}`;
  });
  const insertions = changes.reduce((sum, change) => sum + change.additions, 0);
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
  const summary = [`${changes.length} file${changes.length === 1 ? '' : 's'} changed`];
  if (insertions) summary.push(`${insertions} insertion${insertions === 1 ? '' : 's'}(+)`);
  if (deletions) summary.push(`${deletions} deletion${deletions === 1 ? '' : 's'}(-)`);
  lines.push(` ${summary.join(', ')}`);
  return lines.map((line) => ` ${line}`);
}
