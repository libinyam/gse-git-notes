/**
 * The command layer. Every git command is expressed with the primitives the
 * data model offers — write objects, move refs, move content between the
 * working tree, the index and HEAD — and `run()` reports what changed, so the
 * UI can show the result of a command instead of only its text output.
 *
 * run(line) -> { code, stdout, stderr, effects, notes }
 *   effects.objects  objects that appeared in the store
 *   effects.refs     refs that moved, as { ref, from, to }
 *   effects.worktree files created / modified / deleted in the working tree
 *   effects.index    index entries staged / modified / unstaged
 *   notes            short sentences explaining the command, for the UI
 */
import { Repo, CommonStore, GitError, parseCommit, parseTag, compareText, normalizePath, subjectOf, parseGitIgnore } from './repo.js';
import { buildTree, buildCommit, buildTag, parseTree } from './objects.js';
import { toBytes, splitLines } from './bytes.js';
import { diffLines, formatDiff, mergeText } from './diff.js';
import { statusShort, statusLong, computeStatus, formatCommit, prettyLine, renderGraph, diffStat, formatDate, isoDate } from './format.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ---------------------------------------------------------------- shell ----

/** Split a command line into words, honouring single and double quotes. */
export function tokenize(line) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (const ch of String(line)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Split argv into flags, `--name value` / `--name=value` values and positional
 * arguments. `spec` marks which names take a value (`'value'`) or an optional
 * one (`'optional'`); anything else is a plain flag.
 */
export function parseArgs(argv, spec = {}) {
  const flags = new Set();
  const values = new Map();
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        values.set(token.slice(2, eq), token.slice(eq + 1));
        continue;
      }
      const name = token.slice(2);
      if (spec[name] === 'value') values.set(name, argv[++i] ?? '');
      else if (spec[name] === 'optional') values.set(name, argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '');
      else flags.add(name);
      continue;
    }
    if (/^-\d+$/.test(token)) {
      // `-3` is Git's shorthand for `-n 3`.
      values.set('n', token.slice(1));
      continue;
    }
    if (/^-[^-]/.test(token)) {
      const letters = token.slice(1);      for (let j = 0; j < letters.length; j++) {
        const letter = letters[j];
        if (spec[letter] === 'value') {
          values.set(letter, letters.slice(j + 1) || argv[++i] || '');
          break;
        }
        if (spec[letter] === 'optional') {
          values.set(letter, letters.slice(j + 1) || '');
          break;
        }
        flags.add(letter);
      }
      continue;
    }
    args.push(token);
  }
  return {
    flags,
    values,
    args,
    has: (...names) => names.some((name) => flags.has(name)),
    value: (...names) => {
      for (const name of names) if (values.has(name)) return values.get(name);
      return null;
    },
  };
}

// ---------------------------------------------------------------- shell ----

const SHELL_BUILTINS = new Set(['echo', 'printf', 'cat', 'head']);
const SHELL_OPERATORS = new Set(['|', '>', '>>', '<', '&&']);

/** Split a token list on `&&`; each group runs only if the previous one worked. */
function splitOnAnd(tokens) {
  const groups = [[]];
  for (const token of tokens) {
    if (token === '&&') groups.push([]);
    else groups[groups.length - 1].push(token);
  }
  return groups.filter((group) => group.length);
}

/** Split a token list on `|`, feeding one command's output into the next. */
function splitOnPipe(tokens) {
  const groups = [[]];
  for (const token of tokens) {
    if (token === '|') groups.push([]);
    else groups[groups.length - 1].push(token);
  }
  return groups.filter((group) => group.length);
}

/** Pull `> file`, `>> file` and `< file` off a token list. */
function parseRedirect(argv) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!SHELL_OPERATORS.has(token) || token === '|' || token === '&&') continue;
    const target = argv[i + 1] ?? '';
    const rest = [...argv.slice(0, i), ...argv.slice(target ? i + 2 : i + 1)];
    if (token === '<') return { argv: rest, redirect: { in: target } };
    return { argv: rest, redirect: { out: target, append: token === '>>' } };
  }
  return { argv, redirect: null };
}

// ---------------------------------------------------------------- engine ---
export class Git {
  constructor(options = {}) {
    this.common = options.common ?? new CommonStore(options);
    this.worktrees = new Map();
    this.remotes = new Map();
    this.repo = this.addWorktree(options.dir ?? 'lab');
    this.notes = [];
    this.log = [];
  }

  /** A worktree shares the object database and refs, but not HEAD or the index. */
  addWorktree(dir, { headRef = null, headCommit = null } = {}) {
    const repo = new Repo({ common: this.common, dir, headRef, headCommit });
    this.worktrees.set(dir, repo);
    return repo;
  }

  note(text) {
    if (text) this.notes.push(text);
    return text;
  }

  // ---- running commands --------------------------------------------------

  run(line) {
    const text = String(line ?? '').trim();
    if (!text) return { code: 0, stdout: '', stderr: '', effects: emptyEffects(), notes: [] };
    this.notes = [];
    const before = this.snapshot();
    const tokens = tokenize(text);
    const isShell = tokens.some((token) => SHELL_OPERATORS.has(token)) || SHELL_BUILTINS.has(tokens[0]);
    const result = isShell ? this.runPipeline(tokens) : this.runOne(tokens);
    const effects = diffStates(before, this.snapshot(), this);
    const final = { line: text, ...result, effects, notes: this.notes };
    this.log.push({ line: text, ...final });
    return final;
  }

  /** One command; a command may answer with text or with { stdout, stderr, code }. */
  runOne(argv) {
    if (argv[0] === 'git') argv.shift();
    if (!argv.length) return { code: 0, stdout: this.help(), stderr: '' };
    const name = argv[0];
    const method = COMMANDS[name];
    if (!method) return { code: 1, stdout: '', stderr: `git: '${name}' is not a git command. See 'git --help'.` };
    try {
      const out = this[method](argv.slice(1));
      if (out && typeof out === 'object' && !Array.isArray(out)) {
        const { code = 0, stdout: text = '', stderr: error = '', ...rest } = out;
        return {
          code,
          stdout: Array.isArray(text) ? text.join('\n') : String(text ?? ''),
          stderr: String(error ?? ''),
          ...rest,
        };
      }
      return { code: 0, stdout: Array.isArray(out) ? out.join('\n') : String(out ?? ''), stderr: '' };
    } catch (error) {
      if (error instanceof GitError) return { code: error.exitCode ?? 128, stdout: '', stderr: error.message };
      throw error;
    }
  }

  /**
   * A tiny shell: `echo`/`printf`, `cat`, `head`, `|` pipes, `&&` chains and
   * `>`/`>>`/`<` redirection, so the README's recipes run exactly as written.
   */
  runPipeline(tokens) {
    let stdin = '';
    const merged = { code: 0, stdout: '', stderr: '' };
    for (const group of splitOnAnd(tokens)) {
      for (const segment of splitOnPipe(group)) {
        const { argv, redirect } = parseRedirect(segment);
        if (!argv.length) continue;
        const result = this.runSegment(argv, stdin);
        merged.code = result.code;
        merged.stderr = result.stderr;
        stdin = result.stdout;
        if (result.code !== 0) {
          merged.stdout = stdin;
          return merged;
        }
        if (redirect?.in) {
          const content = this.repo.readFile(normalizePath(redirect.in));
          if (content === null) {
            merged.code = 1;
            merged.stderr = `cat: ${redirect.in}: No such file or directory`;
            merged.stdout = '';
            return merged;
          }
          stdin = content;
        }
        if (redirect?.out) {
          const target = normalizePath(redirect.out);
          this.writeWork(target, redirect.append ? `${this.repo.readFile(target) ?? ''}${stdin}` : stdin);
          this.note(`工作区写入 ${target}`);
          stdin = '';
        }
      }
    }
    merged.stdout = stdin;
    return merged;
  }

  /** One command of the mini shell, reading `stdin` and returning new stdout. */
  runSegment(argv, stdin) {
    const [name, ...rest] = argv;
    const unescape = (text) => text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    if (name === 'echo') return { code: 0, stdout: `${unescape(rest.join(' '))}\n`, stderr: '' };
    if (name === 'printf') return { code: 0, stdout: unescape(rest.join(' ')), stderr: '' };
    if (name === 'cat') {
      const files = rest.filter((token) => !token.startsWith('-'));
      if (!files.length) return { code: 0, stdout: stdin, stderr: '' };
      const chunks = [];
      for (const file of files) {
        const content = this.repo.readFile(normalizePath(file));
        if (content === null) return { code: 1, stdout: '', stderr: `cat: ${file}: No such file or directory` };
        chunks.push(content.endsWith('\n') ? content : `${content}\n`);
      }
      return { code: 0, stdout: chunks.join(''), stderr: '' };
    }
    if (name === 'head') {
      const flagIndex = rest.indexOf('-n');
      const count = Number(rest.find((token) => /^\d+$/.test(token)) ?? rest[flagIndex + 1] ?? 10);
      return { code: 0, stdout: splitLines(stdin).slice(0, count).join('\n'), stderr: '' };
    }
    if (name === 'git' || COMMANDS[name]) {
      this.stdin = stdin;
      const result = this.runOne(name === 'git' ? argv : ['git', ...argv]);
      this.stdin = '';
      return result;
    }
    return { code: 127, stdout: '', stderr: `${name}: command not found` };
  }

  // ---- state snapshots ---------------------------------------------------

  snapshot() {
    const repo = this.repo;
    const files = new Map();
    for (const [path, content] of repo.files) files.set(path, repo.hashContent(content));
    const index = new Map();
    for (const [path, entry] of repo.index) {
      index.set(path, entry.conflicted ? `conflict ${JSON.stringify(entry.conflicted)}` : `${entry.mode} ${entry.hash}`);
    }
    return { files, index, refs: new Map(repo.refs), objects: new Set(repo.objects.list().map((o) => o.hash)) };
  }

  // ---- small helpers -----------------------------------------------------

  short(hash) {
    return this.repo.shortHash(hash);
  }

  head() {
    return this.repo.headHash();
  }

  commitOf(rev) {
    const hash = this.resolveCommit(rev);
    return parseCommit(hash, this.repo.objects);
  }

  /** The commit a revision names, peeling annotated tags. */
  resolveCommit(rev, { quiet = false } = {}) {
    const hash = this.repo.revParse(rev, { quiet });
    if (!hash) {
      if (quiet) return null;
      throw new GitError(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
    }
    const peeled = this.repo.peel(hash);
    const object = this.repo.objects.get(peeled);
    if (object.type !== 'commit') {
      if (quiet) return null;
      throw new GitError(`fatal: ${rev} is not a commit`);
    }
    return peeled;
  }

  /** Resolve a revision to the hash of its tree (or the tree itself). */
  treeOf(rev) {
    const hash = this.repo.revParse(rev);
    const object = this.repo.objects.get(hash);
    if (object.type === 'commit') return parseCommit(hash, this.repo.objects).tree;
    if (object.type === 'tree') return hash;
    if (object.type === 'tag') return this.treeOf(parseTag(hash, this.repo.objects).object);
    throw new GitError(`fatal: not a tree object: ${rev}`);
  }

  /** path -> { hash, mode, content } for a revision, or null when unresolvable. */
  filesOf(rev) {
    const hash = this.repo.revParse(rev, { quiet: true });
    if (!hash) return null;
    const object = this.repo.objects.get(hash);
    const tree = object.type === 'commit' ? parseCommit(hash, this.repo.objects).tree : object.type === 'tag' ? this.treeOf(rev) : hash;
    return new Map(
      this.repo.listTree(tree).map((entry) => [entry.path, { hash: entry.hash, mode: entry.mode, content: this.repo.objects.text(entry.hash) }]),
    );
  }

  workFiles() {
    return new Map(
      [...this.repo.files].map(([path, content]) => [path, { hash: this.repo.hashContent(content), mode: '100644', content }]),
    );
  }

  indexFiles() {
    const out = new Map();
    for (const [path, entry] of this.repo.index) {
      if (entry.conflicted) continue;
      out.set(path, { hash: entry.hash, mode: entry.mode, content: this.repo.objects.text(entry.hash) });
    }
    return out;
  }

  /** Side of a diff: the working tree, the index, or a revision. */
  contentMap(kind) {
    if (kind === 'work') return this.workFiles();
    if (kind === 'index') return this.indexFiles();
    return this.filesOf(kind);
  }

  /** Replace working tree and index with a tree's snapshot. */
  checkoutTree(treeHash) {
    this.repo.checkoutCommit(treeHash);
  }

  stage(path, content) {
    this.repo.stageFile(normalizePath(path), content);
  }

  writeWork(path, content) {
    this.repo.writeFile(normalizePath(path), content);
  }

  /** Paths in `paths` (empty means all), directories included. */
  selectPaths(paths, universe) {
    if (!paths.length) return [...universe].sort(compareText);
    const out = [];
    for (const path of universe) {
      if (paths.some((spec) => path === spec || path.startsWith(`${spec}/`) || spec === '.')) out.push(path);
    }
    return out.sort(compareText);
  }

  /** Diffstat + per-file unified diff between two content maps. */
  renderDiff(oldMap, newMap, { stat = false, nameOnly = false, paths = [] } = {}) {
    const all = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort(compareText);
    const out = [];
    const changes = [];
    for (const path of all) {
      if (paths.length && !this.selectPaths(paths, new Set([path])).length) continue;
      const before = oldMap.get(path) ?? null;
      const after = newMap.get(path) ?? null;
      if (before && after && before.hash === after.hash && before.mode === after.mode) continue;
      if (stat || nameOnly) {
        const ops = diffLines(before?.content ?? '', after?.content ?? '');
        changes.push({
          label: path,
          additions: ops.filter((op) => op.type === 'add').length,
          deletions: ops.filter((op) => op.type === 'del').length,
        });
        if (nameOnly) out.push(path);
        continue;
      }
      out.push(
        ...formatDiff(path, before?.content ?? null, after?.content ?? null, {
          oldMode: before?.mode,
          newMode: after?.mode,
          oldHash: before?.hash,
          newHash: after?.hash,
        }),
      );
    }
    if (stat && changes.length) out.push(...diffStat(changes));
    return out;
  }

  /** Commit summary Git prints after `git commit`: stat plus create/delete modes. */
  commitSummary(oldMap, newMap) {
    const out = [];
    const changes = [];
    for (const path of [...new Set([...oldMap.keys(), ...newMap.keys()])].sort(compareText)) {
      const before = oldMap.get(path) ?? null;
      const after = newMap.get(path) ?? null;
      if (before && after && before.hash === after.hash) continue;
      const ops = diffLines(before?.content ?? '', after?.content ?? '');
      changes.push({ label: path, additions: ops.filter((op) => op.type === 'add').length, deletions: ops.filter((op) => op.type === 'del').length });
      if (!before) out.push(` create mode ${after.mode} ${path}`);
      else if (!after) out.push(` delete mode ${before.mode} ${path}`);
    }
    if (!changes.length) return out;
    out.unshift(...diffStat(changes).map((line) => ` ${line}`.trimEnd()));
    return out;
  }

  /** Three-way merge of two trees over a base tree, in Git's shape. */
  mergeTrees(baseMap, ourMap, theirMap, { oursLabel = 'HEAD', theirsLabel = '' } = {}) {
    const paths = [...new Set([...baseMap.keys(), ...ourMap.keys(), ...theirMap.keys()])].sort(compareText);
    const result = new Map();
    const conflicts = [];
    const changed = [];
    for (const path of paths) {
      const base = baseMap.get(path) ?? null;
      const ours = ourMap.get(path) ?? null;
      const theirs = theirMap.get(path) ?? null;
      const same = (a, b) => (a && b ? a.hash === b.hash && a.mode === b.mode : a === b);
      if (same(ours, theirs)) {
        if (ours) result.set(path, { ...ours, content: this.repo.objects.text(ours.hash) });
        continue;
      }
      if (same(ours, base)) {
        if (theirs) result.set(path, { ...theirs, content: this.repo.objects.text(theirs.hash) });
        continue;
      }
      if (same(theirs, base)) {
        if (ours) result.set(path, { ...ours, content: this.repo.objects.text(ours.hash) });
        continue;
      }
      changed.push(path);
      if (ours && theirs) {
        const merged = mergeText(base?.content ?? '', ours.content, theirs.content, { oursLabel, theirsLabel });
        if (merged.conflicted) {
          conflicts.push({ path, kind: ours && theirs ? 'content' : 'content', base, ours, theirs });
          result.set(path, { hash: null, mode: ours.mode, content: merged.text, conflicted: { 1: base?.hash ?? null, 2: ours.hash, 3: theirs.hash } });
        } else {
          result.set(path, { ...ours, content: merged.text });
        }
        continue;
      }
      // one side deleted, the other modified: Git keeps the surviving side and reports a conflict
      conflicts.push({ path, kind: ours ? 'modify/delete' : 'modify/delete', base, ours, theirs });
      const survivor = ours ?? theirs;
      result.set(path, {
        hash: null,
        mode: survivor.mode,
        content: survivor.content,
        conflicted: { 1: base?.hash ?? null, 2: ours?.hash ?? null, 3: theirs?.hash ?? null },
      });
    }
    return { result, conflicts, changed };
  }

  /** Write a merged map into the working tree and the index. */
  applyMerge(map) {
    for (const [path, entry] of map) {
      this.writeWork(path, entry.content);
      if (entry.conflicted) this.repo.index.set(path, { conflicted: entry.conflicted });
      else this.stage(path, entry.content);
    }
  }

  /** Materialise a merged map as blobs and return a tree hash. */
  treeFromMap(map) {
    const paths = [];
    for (const [path, entry] of map) {
      if (entry.conflicted) continue;
      const bytes = toBytes(entry.content ?? '');
      const hash = this.repo.objects.write('blob', bytes);
      paths.push({ path, mode: entry.mode ?? '100644', hash });
    }
    return this.repo.buildTreeFromPaths(paths);
  }

  /** Commits reachable from `from` but not from `exclude`, oldest first. */
  aheadOf(from, exclude) {
    return this.repo.uniqueCommits(from, exclude);
  }

  help() {
    const lines = ['这些命令可以在本模拟器里运行（用法与真 git 一致）：', ''];
    for (const group of HELP_GROUPS) {
      lines.push(group.title);
      for (const [name, text] of group.commands) lines.push(`  ${name.padEnd(28)} ${text}`);
      lines.push('');
    }
    lines.push('提示：`git help <命令>` 或右侧“讲解”面板有更详细的说明。');
    return lines;
  }

  // ---- commands are attached below ---------------------------------------

  cmdInit(args) {
    const { values, args: rest } = parseArgs(args, { b: 'value', initialBranch: 'value' });
    const branch = values.get('b') || values.get('initial-branch') || this.common.initDefaultBranch;
    const dir = normalizePath(rest[0] || this.repo.dir);
    const existed = this.initialized;
    this.repo.dir = dir;
    this.repo.headRef = `refs/heads/${branch}`;
    this.repo.headCommit = null;
    this.initialized = true;
    this.note(`HEAD 现在指向 refs/heads/${branch}，但这个分支还没有任何提交（unborn）`);
    this.note('.git 里只有 objects/ 和 refs/ 两个空目录：仓库 = 对象 + 引用');
    return existed ? `Reinitialized existing Git repository in ${dir}/.git/` : `Initialized empty Git repository in ${dir}/.git/`;
  }

  cmdHashObject(args) {
    const { flags, args: rest } = parseArgs(args, {});
    const stdin = flags.has('stdin');
    const paths = rest.filter((token) => !token.startsWith('-'));
    const out = [];
    if (stdin) {
      const content = this.stdin ?? '';
      const hash = this.repo.objects.hashOnly('blob', toBytes(content));
      if (flags.has('w')) this.repo.objects.write('blob', toBytes(content));
      out.push(hash);
    }
    for (const path of paths) {
      const content = this.repo.readFile(normalizePath(path));
      if (content === null) throw new GitError(`fatal: could not open '${path}' for reading: No such file or directory`);
      const hash = this.repo.objects.hashOnly('blob', toBytes(content));
      if (flags.has('w')) this.repo.objects.write('blob', toBytes(content));
      out.push(hash);
    }
    if (!out.length) throw new GitError('usage: git hash-object [-w] [--stdin] <file>...');
    return out;
  }

  cmdAdd(args) {
    const { flags, args: paths } = parseArgs(args, {});
    if (flags.has('p') || flags.has('i') || flags.has('e')) {
      throw new GitError('fatal: 交互式 add 在本模拟器里没有实现，请用 git add <文件>');
    }
    const everything = flags.has('A') || flags.has('all') || paths.includes('.') || !paths.length;
    const updateOnly = flags.has('u') || flags.has('update');
    const tracked = new Set(this.repo.index.keys());
    const present = new Set(this.repo.files.keys());
    const targets = new Set();

    if (everything) {
      for (const path of present) targets.add(path);
      for (const path of tracked) targets.add(path);
    } else if (updateOnly) {
      for (const path of tracked) targets.add(path);
    } else {
      for (const spec of paths) {
        const matched = [...present, ...tracked].filter((path) => path === spec || path.startsWith(`${spec}/`));
        if (!matched.length) throw new GitError(`fatal: pathspec '${spec}' did not match any files`);
        for (const path of matched) targets.add(path);
      }
    }

    const selected = [...new Set([...present, ...tracked])].filter((path) => targets.has(path)).sort(compareText);
    let staged = 0;
    let removed = 0;
    let skipped = 0;
    for (const path of selected) {
      if (present.has(path)) {
        if (this.repo.isIgnored(path) && !tracked.has(path)) {
          skipped++;
          continue;
        }
        const content = this.repo.readFile(path);
        this.stage(path, content);
        staged++;
        if (path === '.gitignore') this.common.ignore = parseGitIgnore(content);
        continue;
      }
      if (tracked.has(path)) {
        this.repo.index.delete(path);
        removed++;
      }
    }
    this.note(`add 的那一刻，内容已经被写成 blob 存进对象库；暂存区只记住“${staged ? `${staged} 个路径 → blob 哈希` : '无'}”`);
    if (removed) this.note(`暂存区记录了 ${removed} 个删除`);
    if (skipped) this.note(`${skipped} 个被 .gitignore 忽略的文件没有加入`);
    return [];
  }

  cmdRm(args) {
    const { flags, args: paths } = parseArgs(args, { r: 'flag', recursive: 'flag', cached: 'flag', f: 'flag', force: 'flag' });
    if (!paths.length) throw new GitError('fatal: No pathspec was given.');
    const targets = [];
    for (const spec of paths) {
      const matched = [...this.repo.index.keys()].filter((path) => path === spec || path.startsWith(`${spec}/`));
      if (!matched.length) throw new GitError(`fatal: pathspec '${spec}' did not match any files`);
      targets.push(...matched);
    }
    for (const path of targets.sort(compareText)) {
      this.repo.index.delete(path);
      if (!flags.has('cached')) this.repo.removeFile(path);
    }
    this.note(flags.has('cached') ? '只从暂存区移除，工作区文件还在（下次提交就不含它了）' : '暂存区和工作区都删掉了');
    return targets.sort(compareText).map((path) => `rm '${path}'`);
  }

  cmdCommit(args) {
    const { flags, values } = parseArgs(args, {
      m: 'value',
      message: 'value',
      a: 'flag',
      all: 'flag',
      amend: 'flag',
      allowEmpty: 'flag',
      'allow-empty-message': 'flag',
    });
    const repo = this.repo;
    if (flags.has('a') || flags.has('all')) {
      for (const path of [...repo.index.keys()].sort(compareText)) {
        const content = repo.readFile(path);
        if (content === null) repo.index.delete(path);
        else this.stage(path, content);
      }
      this.note('-a 把所有已跟踪文件的当前内容一起暂存了');
    }

    const merging = repo.mergeState?.type === 'merge';
    if (merging && repo.conflictedPaths().length) {
      throw new GitError(
        ['error: Committing is not possible because you have unmerged files.', 'hint: Fix them up in the index, and then use "git commit".', 'fatal: Exiting because of an unresolved conflict.'].join('\n'),
      );
    }

    const amend = flags.has('amend');
    const amended = amend && repo.headHash() ? parseCommit(repo.headHash(), repo.objects) : null;
    let parents;
    let message = values.get('m') ?? values.get('message') ?? '';
    if (merging) parents = repo.mergeState.parents;
    else if (amend) parents = amended.parents;
    else if (repo.headHash()) parents = [repo.headHash()];
    else parents = [];

    if (!message) {
      if (merging) message = repo.mergeState.message || `Merge branch '${repo.mergeState.theirs}'`;
      else if (amend) message = amended.message.replace(/\n+$/, '');
      else if (flags.has('allow-empty-message')) message = '';
      else throw new GitError('Aborting commit due to empty commit message.');
    }

    const stagedEntries = repo.indexEntries();
    const head = repo.headHash();
    const parentTree = parents[0] ? this.treeOf(parents[0]) : EMPTY_TREE;
    const newTree = repo.writeTreeFromIndex();
    if (!merging && !flags.has('allowEmpty') && !amend && newTree === parentTree) {
      const lines = [`On branch ${repo.headBranch() ?? 'HEAD'}`];
      if (!head) lines.push('', 'No commits yet');
      const dirty = computeStatus(repo).some((entry) => !entry.untracked && !entry.ignored);
      lines.push('', dirty ? 'no changes added to commit (use "git add" and/or "git commit -a")' : 'nothing to commit, working tree clean');
      return { code: 1, stdout: lines.join('\n'), stderr: '' };
    }

    const hash = repo.writeCommit({ tree: newTree, parents, message, amend });
    repo.mergeState = null;
    const label = repo.headBranch() ?? 'detached HEAD';
    const root = parents.length === 0 ? ' (root-commit)' : '';
    const out = [`[${label}${root} ${this.short(hash)}] ${subjectOf(message)}`];
    // Git shows no diffstat for merge commits (the result matches a parent on
    // most paths, and the default summary is a combined diff).
    if (parents.length < 2) {
      const oldMap = parents[0] ? this.filesOf(parents[0]) : new Map();
      out.push(...this.commitSummary(oldMap, this.filesOf(hash)));
    }
    if (merging) this.note('合并提交有两个父提交，历史图上能看到分叉又汇合');
    this.note(`新 commit 的父提交是 ${parents.length ? parents.map((p) => this.short(p)).join(' 和 ') : '（没有，这是第一个提交）'}，分支引用随之前移`);
    return out;
  }

  cmdStatus(args) {
    const { flags } = parseArgs(args, {});
    if (flags.has('s') || flags.has('short')) return statusShort(this.repo, { branch: flags.has('b') });
    return statusLong(this.repo);
  }

  cmdDiff(args) {
    const { flags, values, args: rest } = parseArgs(args, { stat: 'flag', numstat: 'flag', nameOnly: 'flag', nameStatus: 'flag', cached: 'flag', staged: 'flag' });
    const separator = rest.indexOf('--');
    const paths = separator >= 0 ? rest.slice(separator + 1) : [];
    const revs = [];
    const extra = [];
    for (const token of separator >= 0 ? rest.slice(0, separator) : rest) {
      if (revs.length < 2 && this.repo.revParse(token, { quiet: true })) revs.push(token);
      else extra.push(token);
    }
    const wanted = [...paths, ...extra];

    let oldKind = 'index';
    let newKind = 'work';
    if (flags.has('cached') || flags.has('staged')) {
      oldKind = 'HEAD';
      newKind = 'index';
    } else if (revs.length >= 2) {
      oldKind = revs[0];
      newKind = revs[1];
    } else if (revs.length === 1) {
      oldKind = revs[0];
      newKind = 'work';
    }
    const oldMap = this.contentMap(oldKind);
    const newMap = this.contentMap(newKind);
    if (!oldMap || !newMap) throw new GitError(`fatal: ambiguous argument '${revs.join(' ')}': unknown revision`);
    const label = { work: '工作区', index: '暂存区', HEAD: 'HEAD' };
    const pretty = (kind) => (label[kind] ? `${label[kind]}` : kind);
    this.note(`diff 比较的是 ${pretty(oldKind)} 和 ${pretty(newKind)}`);
    if (flags.has('cached') || flags.has('staged')) this.note('--cached 看的是“暂存区 vs HEAD”，也就是马上要提交的内容');
    else if (!revs.length) this.note('不带参数时 diff 看的是“工作区 vs 暂存区”，也就是还没 add 的修改');
    return this.renderDiff(oldMap, newMap, {
      stat: flags.has('stat') || flags.has('numstat'),
      nameOnly: flags.has('nameOnly') || flags.has('nameStatus'),
      paths: wanted,
    });
  }

  cmdLog(args) {
    const { flags, values, args: rest } = parseArgs(args, {
      n: 'value',
      maxCount: 'value',
      pretty: 'optional',
      format: 'optional',
    });
    const repo = this.repo;
    const all = flags.has('all');
    const rawPretty = values.get('pretty') ?? values.get('format');
    // `--pretty=format:` prints one line per commit with no blank line between;
    // `tformat:` and the default layout keep the separator.
    let format = rawPretty;
    let blank = '\n';
    if (format) {
      // `--pretty=format:` and `--pretty=tformat:` both print one line per
      // commit with no blank line between; the default layout separates them.
      if (/^tformat:/.test(format)) format = format.slice(7);
      else if (/^format:/.test(format)) format = format.slice(7);
      blank = '';
    }
    const oneline = flags.has('oneline') || /oneline/.test(rawPretty ?? '');
    const graph = flags.has('graph');
    const decorate = flags.has('decorate') || oneline || all;
    const stat = flags.has('stat') || flags.has('numstat') || flags.has('shortstat');
    const dashDash = rest.indexOf('--');
    const candidates = dashDash >= 0 ? rest.slice(0, dashDash) : rest;
    const paths = dashDash >= 0 ? rest.slice(dashDash + 1) : [];

    const seeds = new Set();
    if (all) {
      for (const name of repo.refs.keys()) {
        if (name.startsWith('refs/stash')) continue;
        const hash = repo.resolveRef(name);
        if (hash) repo.collect(hash, seeds);
      }
      const head = repo.headHash();
      if (head) repo.collect(head, seeds);
    } else {
      const start = candidates.find((token) => repo.revParse(token, { quiet: true })) ?? 'HEAD';
      const hash = repo.revParse(start, { quiet: true });
      if (!hash) throw new GitError(`fatal: your current branch '${repo.headBranch()}' does not have any commits yet`);
      repo.collect(hash, seeds);
    }

    let hashes = repo.order(seeds);
    if (paths.length) {
      hashes = hashes.filter((hash) => {
        const commit = parseCommit(hash, repo.objects);
        const oldMap = commit.parents[0] ? this.filesOf(commit.parents[0]) : new Map();
        const newMap = this.filesOf(hash);
        return [...new Set([...oldMap.keys(), ...newMap.keys()])].some(
          (path) => paths.some((spec) => path === spec || path.startsWith(`${spec}/`)) && (oldMap.get(path)?.hash ?? null) !== (newMap.get(path)?.hash ?? null),
        );
      });
    }
    const limit = Number(values.get('n') ?? values.get('max-count') ?? (flags.has('oneline') ? 0 : 0));
    if (limit > 0) hashes = hashes.slice(0, limit);

    if (!hashes.length) return [`fatal: your current branch '${repo.headBranch() ?? 'HEAD'}' does not have any commits yet`];

    const rows = hashes.map((hash) => {
      const commit = parseCommit(hash, repo.objects);
      const rowFormat = format && !/oneline/.test(format) ? format : oneline ? '%h %s%d' : '%h %s';
      const text = prettyLine(repo, rowFormat, hash, commit, decorate);
      return { hash, parents: commit.parents, text };
    });

    if (graph) return renderGraph(rows);
    if (oneline && !stat) return rows.map((row) => row.text);

    const out = [];
    for (const row of rows) {
      out.push(...formatCommit(repo, row.hash, { format: format && !/oneline/.test(format) ? format : null, decorate }));
      if (stat) {
        const commit = parseCommit(row.hash, repo.objects);
        const oldMap = commit.parents[0] ? this.filesOf(commit.parents[0]) : new Map();
        out.push(...this.renderDiff(oldMap, this.filesOf(row.hash), { stat: true }));
      }
      if (blank) out.push(blank);    }
    while (out.length && out[out.length - 1] === '') out.pop();
    this.note('log 是只读命令：对象库、引用、工作区都不会变');
    return out;
  }

  cmdShow(args) {
    const { args: rest } = parseArgs(args, { stat: 'flag' });
    const rev = rest[0] ?? 'HEAD';
    const hash = this.repo.revParse(rev);
    const object = this.repo.objects.get(hash);
    if (object.type === 'tag') return splitLines(this.repo.objects.text(hash));
    if (object.type === 'blob') return splitLines(this.repo.objects.text(hash));
    if (object.type === 'tree') return this.cmdLsTree([hash]);
    const out = formatCommit(this.repo, hash, { decorate: true });
    const commit = parseCommit(hash, this.repo.objects);
    const oldMap = commit.parents[0] ? this.filesOf(commit.parents[0]) : new Map();
    out.push('', ...this.renderDiff(oldMap, this.filesOf(hash)));
    return out;
  }

  cmdCatFile(args) {
    const { flags, args: rest } = parseArgs(args, {});
    const mode = flags.has('t') ? 't' : flags.has('p') ? 'p' : flags.has('s') ? 's' : 'p';
    const name = rest.find((token) => !/^[tps]$/.test(token)) ?? rest[rest.length - 1];
    if (!name) throw new GitError('usage: git cat-file (-t|-s|-p) <object>');
    let hash;
    try {
      hash = this.repo.revParse(name);
    } catch {
      throw new GitError(`fatal: Not a valid object name ${name}`);
    }
    const object = this.repo.objects.get(hash);
    if (mode === 't') return [object.type];
    if (mode === 's') return [String(object.size)];
    if (object.type === 'tree') {
      return parseTree(hash, this.repo.objects).entries.map(
        (entry) => `${entry.mode} ${entry.mode === '40000' ? 'tree' : 'blob'} ${entry.hash}\t${entry.name}`,
      );
    }
    return splitLines(this.repo.objects.text(hash));
  }

  cmdLsFiles(args) {
    const { flags } = parseArgs(args, {});
    const out = [];
    for (const [path, entry] of [...this.repo.index.entries()].sort((a, b) => compareText(a[0], b[0]))) {
      if (entry.conflicted) {
        for (const stage of [1, 2, 3]) {
          const hash = entry.conflicted[stage];
          if (hash) out.push(`${100644 + stage} ${hash} ${stage}\t${path}`);
        }
        continue;
      }
      out.push(flags.has('s') ? `${entry.mode} ${entry.hash} 0\t${path}` : path);
    }
    return out;
  }

  cmdLsTree(args) {
    const { flags, args: rest } = parseArgs(args, {});
    const rev = rest.find((token) => this.repo.revParse(token, { quiet: true })) ?? 'HEAD';
    const tree = this.treeOf(rev);
    const out = [];
    const walk = (treeHash, prefix) => {
      for (const entry of parseTree(treeHash, this.repo.objects).entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const type = entry.mode === '40000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob';
        if (entry.mode === '40000' && flags.has('r')) walk(entry.hash, path);
        else out.push(`${entry.mode} ${type} ${entry.hash}\t${path}`);
      }
    };
    walk(tree, '');
    return out;
  }

  cmdRevParse(args) {
    const { flags, args: rest } = parseArgs(args, {});
    if (!rest.length) throw new GitError('usage: git rev-parse <revision>...');
    const out = [];
    for (const token of rest) {
      if (token === '--git-dir') {
        out.push('.git');
        continue;
      }
      if (token === '--show-toplevel') {
        out.push(this.repo.dir);
        continue;
      }
      if (token === '--abbrev-ref' ) continue;
      if (token === 'HEAD' || token === '@') {
        if (flags.has('abbrev-ref')) {
          out.push(this.repo.headBranch() ?? 'HEAD');
          continue;
        }
      }
      const hash = this.repo.revParse(token);
      out.push(flags.has('short') ? this.short(hash) : hash);
    }
    return out;
  }

  cmdConfig(args) {
    const { flags, args: rest } = parseArgs(args, {});
    if (flags.has('list') || flags.has('l')) return Object.entries(this.common.config).map(([key, value]) => `${key}=${value}`);
    if (flags.has('get') || flags.has('get-all')) {
      const value = this.common.config[rest[0]];
      if (value === undefined) throw new GitError(`error: key does not contain a value: ${rest[0]}`);
      return [String(value)];
    }
    const [key, ...valueParts] = rest;
    if (!key) throw new GitError('usage: git config <name> [<value>]');
    if (!valueParts.length) {
      const value = this.common.config[key];
      if (value === undefined) throw new GitError(`error: key does not contain a value: ${key}`);
      return [String(value)];
    }
    this.common.config[key] = valueParts.join(' ');
    if (key === 'user.name') this.common.user.name = valueParts.join(' ');
    if (key === 'user.email') this.common.user.email = valueParts.join(' ');
    this.note(`config ${key} = ${valueParts.join(' ')}（提交里记录的作者信息会变）`);
    return [];
  }

  /** Point every index entry at a revision's version, leaving the worktree alone. */
  resetIndexTo(rev) {
    const repo = this.repo;
    const from = this.filesOf(rev);
    for (const path of [...repo.index.keys()]) {
      const entry = from.get(path);
      if (entry) repo.index.set(path, { mode: entry.mode, hash: entry.hash, stage: 0 });
      else repo.index.delete(path);
    }
  }

  moveHead(hash, message) {
    this.repo.updateRef('HEAD', hash, message);
  }

  /** Refuse to switch when the checkout would throw away local edits. */
  ensureCleanSwitch(target) {
    const repo = this.repo;
    const head = repo.headHash();
    if (!head) return;
    const targetMap = this.filesOf(target);
    const headMap = this.filesOf(head);
    const blocked = [];
    // A path only blocks the switch if it carries edits that the target does
    // not already have: either it differs from HEAD, or it is already exactly
    // the target's version (then the checkout is a no-op for it).
    const check = (path, targetEntry) => {
      const headHash = headMap.get(path)?.hash ?? null;
      const workHash = repo.files.has(path) ? repo.hashContent(repo.readFile(path)) : null;
      const staged = repo.index.get(path)?.hash ?? null;
      const targetHash = targetEntry?.hash ?? null;
      const clean = workHash === headHash && staged === headHash;
      const alreadyTarget = workHash === targetHash && staged === targetHash;
      if (!clean && !alreadyTarget) blocked.push(path);
    };
    for (const [path, entry] of targetMap) {
      if ((headMap.get(path)?.hash ?? null) === entry.hash) continue;
      check(path, entry);
    }
    for (const path of headMap.keys()) {
      if (targetMap.has(path)) continue;
      check(path, null);
    }
    if (blocked.length) {
      throw new GitError(
        [
          'error: Your local changes to the following files would be overwritten by checkout:',
          ...blocked.sort(compareText).map((path) => `\t${path}`),
          'Please commit your changes or stash them before you switch branches.',
          'Aborting',
        ].join('\n'),
      );
    }
  }

  switchTo(name) {
    const repo = this.repo;
    const target = repo.refs.get(`refs/heads/${name}`);
    if (!target) throw new GitError(`fatal: invalid reference: ${name}`);
    this.ensureCleanSwitch(target);
    const from = repo.headBranch() ?? (repo.headHash() ? this.short(repo.headHash()) : 'main');
    const previous = repo.headHash() ?? target;
    repo.headRef = `refs/heads/${name}`;
    repo.headCommit = null;
    this.checkoutTree(target);
    this.recordCheckout(previous, target, `checkout: moving from ${from} to ${name}`);
    this.note(`HEAD 改指分支 ${name}，工作区和暂存区换成它的快照`);
  }

  detachTo(hash) {
    const repo = this.repo;
    this.ensureCleanSwitch(hash);
    const from = repo.headBranch() ?? (repo.headHash() ? this.short(repo.headHash()) : 'main');
    const previous = repo.headHash() ?? hash;
    repo.headRef = null;
    repo.headCommit = hash;
    this.checkoutTree(hash);
    this.recordCheckout(previous, hash, `checkout: moving from ${from} to ${this.short(hash)}`);
    this.note('detached HEAD：HEAD 直接指向 commit 而不指向分支，在这里提交没有任何分支会跟着前移');
  }

  /** `git switch` / `git checkout` leave a trail in HEAD's reflog, like Git. */
  recordCheckout(from, to, message) {
    const repo = this.repo;
    const branch = repo.headBranch();
    this.common.pushReflog('HEAD', from, to, message, this.common.clock);
    if (branch) this.common.pushReflog(`refs/heads/${branch}`, from, to, message, this.common.clock);
  }

  cmdBranch(args) {
    const { flags, args: rest } = parseArgs(args, {
      m: 'flag',
      M: 'flag',
      move: 'flag',
      d: 'flag',
      D: 'flag',
      delete: 'flag',
      a: 'flag',
      all: 'flag',
      r: 'flag',
      remotes: 'flag',
      v: 'flag',
      verbose: 'flag',
    });
    const repo = this.repo;
    const current = repo.headBranch();
    const verbose = flags.has('v') || flags.has('verbose');

    if (flags.has('show-current')) return [current ?? 'HEAD'];

    if (flags.has('m') || flags.has('M') || flags.has('move')) {
      const force = flags.has('M') || flags.has('move');
      const from = rest[0] ?? current;
      const to = rest[1] ?? rest[0];
      const ref = `refs/heads/${from}`;
      if (!repo.refs.has(ref)) throw new GitError(`error: refname refs/heads/${from} not found`);
      if (repo.refs.has(`refs/heads/${to}`) && !force) throw new GitError(`fatal: a branch named '${to}' already exists`);
      const hash = repo.refs.get(ref);
      repo.refs.delete(ref);
      repo.updateRef(`refs/heads/${to}`, hash, `branch: renamed ${ref} to refs/heads/${to}`);
      if (current === from) repo.headRef = `refs/heads/${to}`;
      return [];
    }

    if (flags.has('d') || flags.has('D') || flags.has('delete')) {
      const force = flags.has('D') || flags.has('delete');
      const name = rest[0];
      if (!name) throw new GitError('fatal: branch name required');
      const ref = `refs/heads/${name}`;
      if (!repo.refs.has(ref)) throw new GitError(`error: branch '${name}' not found.`);
      if (name === current) throw new GitError(`error: Cannot delete branch '${name}' checked out at '${repo.dir}'`);
      const hash = repo.refs.get(ref);
      if (!force && repo.headHash()) {
        const unmerged = repo.uniqueCommits(hash, [repo.headHash()]);
        if (unmerged.length) {
          throw new GitError(
            [`error: The branch '${name}' is not fully merged.`, `If you are sure you want to delete it, run 'git branch -D ${name}'.`].join('\n'),
          );
        }
      }
      repo.updateRef(ref, null, `branch: deleted ${name}`);
      return [`Deleted branch ${name} (was ${this.short(hash)}).`];
    }

    if (rest.length) {
      const name = rest[0];
      const start = rest[1] ?? 'HEAD';
      const ref = `refs/heads/${name}`;
      if (repo.refs.has(ref)) throw new GitError(`fatal: a branch named '${name}' already exists`);
      const hash = this.resolveCommit(start);
      repo.updateRef(ref, hash, `branch: Created from ${start}`);
      this.note('分支只是一个写着 commit 哈希的小文件，创建几乎零成本');
      return [];
    }

    const locals = repo.branches().map((branch) => ({ name: branch.name, hash: branch.hash, current: branch.name === current }));
    const remotes = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/remotes/'))
      .map(([name, hash]) => ({ name: name.slice('refs/remotes/'.length), hash, remote: true }));
    const onlyRemotes = flags.has('r') || flags.has('remotes');
    const list = onlyRemotes ? remotes : flags.has('a') || flags.has('all') ? [...locals, ...remotes] : locals;
    const out = [];
    if (!onlyRemotes && repo.isDetached()) {
      out.push(`* (HEAD detached at ${this.short(repo.headHash())})`);
    }
    for (const item of list) {
      const hash = item.remote ? repo.resolveRef(`refs/remotes/${item.name}`) : item.hash;
      const suffix = verbose && hash ? ` ${this.short(hash)} ${subjectOf(parseCommit(hash, repo.objects).message)}` : '';
      out.push(`${item.current ? '*' : ' '} ${item.name}${suffix}`);
    }
    return out;
  }

  cmdSwitch(args) {
    const { flags, args: rest } = parseArgs(args, {
      c: 'flag',
      C: 'flag',
      create: 'flag',
      forceCreate: 'flag',
      detach: 'flag',
      guess: 'flag',
    });
    const repo = this.repo;
    const force = flags.has('C') || flags.has('forceCreate');
    if (flags.has('c') || flags.has('C') || flags.has('create') || flags.has('forceCreate')) {
      const name = rest[0];
      if (!name) throw new GitError('fatal: a branch name is required with -c');
      const start = rest[1] ?? 'HEAD';
      const hash = this.resolveCommit(start);
      const ref = `refs/heads/${name}`;
      if (repo.refs.has(ref) && !force) throw new GitError(`fatal: a branch named '${name}' already exists`);
      repo.updateRef(ref, hash, `branch: Created from ${start}`);
      this.switchTo(name);
      return [`Switched to a new branch '${name}'`];
    }
    const name = rest[0];
    if (!name) throw new GitError('fatal: missing branch or commit argument');
    if (flags.has('detach')) {
      const hash = this.resolveCommit(name);
      this.detachTo(hash);
      return [`HEAD is now at ${this.short(hash)} ${subjectOf(parseCommit(hash, repo.objects).message)}`];
    }
    if (repo.refs.has(`refs/heads/${name}`)) {
      this.switchTo(name);
      return [`Switched to branch '${name}'`];
    }
    throw new GitError([`fatal: invalid reference: ${name}`, `hint: If you meant to create a new branch, use 'git switch -c ${name}'.`].join('\n'));
  }

  cmdCheckout(args) {
    const { flags, args: rest } = parseArgs(args, { b: 'flag', B: 'flag', detach: 'flag', orphan: 'flag' });
    const repo = this.repo;
    if (flags.has('b') || flags.has('B')) {
      const [name, start] = rest;
      return this.cmdSwitch(flags.has('B') ? ['-C', name, ...(start ? [start] : [])] : ['-c', name, ...(start ? [start] : [])]);
    }
    const separator = rest.indexOf('--');
    const revPart = separator >= 0 ? rest.slice(0, separator) : [...rest];
    const pathPart = separator >= 0 ? rest.slice(separator + 1) : [];
    if (!pathPart.length && revPart.length && !revPart.some((token) => repo.revParse(token, { quiet: true }))) {
      pathPart.push(...revPart);
      revPart.length = 0;
    }
    if (pathPart.length) {
      const source = revPart[0] ?? 'HEAD';
      return this.cmdRestore([`--source=${source}`, '--worktree', '--staged', ...pathPart]);
    }
    const name = revPart[0];
    if (!name) throw new GitError('fatal: you must specify a branch name');
    if (repo.refs.has(`refs/heads/${name}`)) {
      this.switchTo(name);
      return [`Switched to branch '${name}'`];
    }
    const hash = this.resolveCommit(name, { quiet: true });
    if (!hash) throw new GitError([`error: pathspec '${name}' did not match any file(s) known to git`].join('\n'));
    this.detachTo(hash);
    return [`HEAD is now at ${this.short(hash)} ${subjectOf(parseCommit(hash, repo.objects).message)}`];
  }

  cmdRestore(args) {
    const { flags, values, args: rest } = parseArgs(args, {
      source: 'value',
      S: 'value',
      staged: 'flag',
      worktree: 'flag',
      W: 'flag',
    });
    const repo = this.repo;
    const source = values.get('source') ?? values.get('S');
    const staged = flags.has('staged');
    const worktree = flags.has('worktree') || flags.has('W') || !staged;
    const separator = rest.indexOf('--');
    const paths = separator >= 0 ? rest.slice(separator + 1) : rest.filter((token) => !token.startsWith('-'));
    if (!paths.length) throw new GitError('fatal: you must specify path(s) to restore');
    for (const spec of paths) {
      const matched = [...new Set([...repo.files.keys(), ...repo.index.keys()])].filter((path) => path === spec || path.startsWith(`${spec}/`));
      if (!matched.length) throw new GitError(`fatal: pathspec '${spec}' did not match any files`);
      for (const path of matched) {
        if (staged) {
          const from = this.filesOf(source ?? 'HEAD');
          const entry = from.get(path);
          if (entry) repo.index.set(path, { mode: entry.mode, hash: entry.hash, stage: 0 });
          else repo.index.delete(path);
          this.note(`--staged 把 ${path} 的暂存区内容恢复成 ${source ?? 'HEAD'} 的版本，工作区不动`);
        }
        if (worktree) {
          const from = source ? this.filesOf(source) : this.indexFiles();
          const entry = from.get(path);
          if (entry) this.writeWork(path, entry.content);
          else this.repo.removeFile(path);
          if (!staged) this.note(`工作区的 ${path} 被恢复成${source ? ` ${source}` : '暂存区'}的版本`);
        }
      }
    }
    return [];
  }

  cmdTag(args) {
    const { flags, values, args: rest } = parseArgs(args, {
      a: 'flag',
      annotate: 'flag',
      s: 'flag',
      sign: 'flag',
      m: 'value',
      message: 'value',
      d: 'flag',
      delete: 'flag',
      l: 'flag',
      list: 'flag',
      f: 'flag',
      force: 'flag',
    });
    const repo = this.repo;
    if (flags.has('d') || flags.has('delete')) {
      const name = rest[0];
      const ref = `refs/tags/${name}`;
      if (!repo.refs.has(ref)) throw new GitError(`error: tag '${name}' not found.`);
      const hash = repo.refs.get(ref);
      repo.updateRef(ref, null, `tag: deleted ${name}`);
      return [`Deleted tag '${name}' (was ${this.short(hash)})`];
    }
    if (!rest.length || flags.has('l') || flags.has('list')) return repo.tags().map((tag) => tag.name).sort(compareText);
    const name = rest[0];
    const rev = rest[1] ?? 'HEAD';
    const hash = repo.peel(repo.revParse(rev));
    const ref = `refs/tags/${name}`;
    if (repo.refs.has(ref) && !flags.has('f') && !flags.has('force')) throw new GitError(`fatal: tag '${name}' already exists`);
    const annotated = flags.has('a') || flags.has('annotate') || flags.has('s') || flags.has('sign');
    if (annotated) {
      const message = values.get('m') ?? values.get('message');
      if (!message) throw new GitError('fatal: no tag message? use -m <message>');
      const tagHash = buildTag(repo.objects, {
        object: hash,
        type: repo.objects.get(hash).type,
        tag: name,
        tagger: this.common.ident('committer', repo),
        message: `${message}\n`,
      });
      repo.updateRef(ref, tagHash, `tag: creating tag ${name}`);
      this.note('附注标签本身也是一个对象（type = tag），指向那个 commit');
      return [];
    }
    repo.updateRef(ref, hash, `tag: creating tag ${name}`);
    this.note('轻量标签就是一个不会挪动的引用：tag 也是引用，所以 git tag 只是写了个文件');
    return [];
  }

  cmdReflog(args) {
    const { values, args: rest } = parseArgs(args, { n: 'value' });
    const repo = this.repo;
    const ref = rest.find((token) => token !== 'show') ?? 'HEAD';
    const entries = repo.reflogEntries(ref);
    const limit = Number(values.get('n') ?? 0);
    const shown = limit > 0 ? entries.slice(0, limit) : entries;
    if (!shown.length) return [];
    this.note('reflog 记录每个引用每次移动到哪里；对象库里被“丢掉”的提交还活着，能从这里找回来');
    return shown.map((entry, index) => `${this.short(entry.new ?? entry.old)} ${ref}@{${index}}: ${entry.message}`);
  }

  cmdMerge(args) {
    const { flags, values, args: rest } = parseArgs(args, {
      m: 'value',
      message: 'value',
      noFf: 'flag',
      'no-ff': 'flag',
      ffOnly: 'flag',
      'ff-only': 'flag',
      squash: 'flag',
      abort: 'flag',
      'continue': 'flag',
    });
    const repo = this.repo;

    if (flags.has('abort')) {
      const state = repo.mergeState;
      if (!state) throw new GitError('fatal: There is no merge to abort');
      this.moveHead(state.head, 'reset: moving to ' + this.short(state.head));
      this.checkoutTree(state.head);
      repo.mergeState = null;
      this.note('merge --abort 回到合并前的 HEAD，工作区和暂存区一起恢复');
      return [];
    }
    if (flags.has('continue')) return this.finishMerge();

    const name = rest[0];
    if (!name) throw new GitError('fatal: No commit specified and merge.defaultToUpstream not set.');
    const theirs = this.resolveCommit(name);
    const head = repo.headHash();

    if (!head) {
      // 往一个还没有提交的分支上合并：等于把分支引用建起来
      const theirMap = this.filesOf(theirs);
      this.moveHead(theirs, `merge ${name}: Fast-forward`);
      this.checkoutTree(theirs);
      return [`Updating 0000000..${this.short(theirs)}`, 'Fast-forward', ...this.renderDiff(new Map(), theirMap, { stat: true })];
    }
    const base = repo.mergeBase(head, theirs);
    if (base === theirs) return ['Already up to date.'];

    const ourMap = this.filesOf(head);
    const theirMap = this.filesOf(theirs);
    const noFf = flags.has('noFf') || flags.has('no-ff');
    if (base === head && !noFf) {
      this.moveHead(theirs, `merge ${name}: Fast-forward`);
      this.checkoutTree(theirs);
      this.note('fast-forward：对方就是你历史的直接后继，只需把分支引用往前挪，不产生新 commit');
      return [`Updating ${this.short(head)}..${this.short(theirs)}`, 'Fast-forward', ...this.renderDiff(ourMap, theirMap, { stat: true })];
    }

    const baseMap = base ? this.filesOf(base) : new Map();
    const { result, conflicts, changed } = this.mergeTrees(baseMap, ourMap, theirMap, { theirsLabel: name });
    this.applyMerge(result);
    if (conflicts.length) {
      repo.mergeState = {
        type: 'merge',
        theirs: name,
        head,
        parents: [head, theirs],
        message: values.get('m') ?? values.get('message') ?? `Merge branch '${name}'`,
      };
      const out = [];
      for (const path of changed) out.push(`Auto-merging ${path}`);
      for (const conflict of conflicts) out.push(`CONFLICT (${conflict.kind}): Merge conflict in ${conflict.path}`);
      out.push('Automatic merge failed; fix conflicts and then commit the result.');
      this.note('冲突双方的内容和 <<<<<<< 标记直接写进了工作区的文件；git status 会报 both modified（UU）');
      return { code: 1, stdout: out, stderr: '' };
    }
    const message = values.get('m') ?? values.get('message') ?? `Merge branch '${name}'`;
    const hash = repo.writeCommit({ tree: repo.writeTreeFromIndex(), parents: [head, theirs], message });
    const out = ["Merge made by the 'ort' strategy.", ...this.commitSummary(ourMap, this.filesOf(hash))];
    this.note('两边都分叉前进了，就生成一个有两个父提交的新 commit，历史图上能看到分叉又汇合');
    return out;
  }

  finishMerge() {
    const repo = this.repo;
    const state = repo.mergeState;
    if (!state) throw new GitError('fatal: There is no merge in progress');
    if (repo.conflictedPaths().length) {
      throw new GitError(['error: Committing is not possible because you have unmerged files.', 'fatal: Exiting because of an unresolved conflict.'].join('\n'));
    }
    const parents = state.type === 'merge' ? state.parents : state.head ? [state.head] : [];
    const hash = repo.writeCommit({ tree: repo.writeTreeFromIndex(), parents, message: state.message });
    repo.mergeState = null;
    return [`[${repo.headBranch() ?? 'detached HEAD'} ${this.short(hash)}] ${subjectOf(state.message)}`];
  }

  cmdRebase(args) {
    const { flags, args: rest } = parseArgs(args, { onto: 'value' });
    const repo = this.repo;

    if (flags.has('abort')) {
      const state = repo.rebaseState;
      if (!state) throw new GitError('fatal: No rebase in progress?');
      repo.headRef = `refs/heads/${state.branch}`;
      repo.headCommit = null;
      this.moveHead(state.originalHead, `rebase (abort): returning to ${state.branch}`);
      this.checkoutTree(state.originalHead);
      repo.rebaseState = null;
      this.note('rebase --abort 回到重放前的分支位置');
      return [];
    }
    if (flags.has('continue')) {
      const state = repo.rebaseState;
      if (!state) throw new GitError('fatal: No rebase in progress?');
      if (repo.conflictedPaths().length) {
        throw new GitError(['error: could not apply the conflicts are still there', 'hint: fix them, git add, then "git rebase --continue"'].join('\n'));
      }
      if (state.stoppedAt) {
        const commit = parseCommit(state.stoppedAt, repo.objects);
        repo.writeCommit({ tree: repo.writeTreeFromIndex(), parents: [repo.headHash()], message: commit.message, authorOverride: commit.author });
        state.done.push(state.stoppedAt);
        state.stoppedAt = null;
        state.todo.shift();
      }
      return this.rebaseContinue();
    }
    if (flags.has('skip')) {
      const state = repo.rebaseState;
      if (!state) throw new GitError('fatal: No rebase in progress?');
      if (state.stoppedAt) {
        state.done.push(state.stoppedAt);
        state.stoppedAt = null;
        state.todo.shift();
      }
      this.checkoutTree(repo.headHash());
      return this.rebaseContinue();
    }

    const upstream = rest[0];
    if (!upstream) throw new GitError('fatal: No rebase in progress?');
    const branch = repo.headBranch();
    if (!branch) throw new GitError('fatal: cannot rebase a detached HEAD in this simulator; switch to a branch first');
    const onto = this.resolveCommit(flags.has('onto') ? values.get('onto') : upstream);
    const originalHead = repo.headHash();
    if (!originalHead) throw new GitError(`fatal: invalid upstream '${upstream}'`);
    const todo = repo.uniqueCommits(originalHead, [onto]);
    if (!todo.length) {
      this.moveHead(onto, `rebase: fast-forward to ${upstream}`);
      this.checkoutTree(onto);
      return [`Current branch ${branch} is up to date.`];
    }
    repo.rebaseState = { branch, onto, originalHead, done: [], todo, stoppedAt: null };
    repo.headRef = null;
    repo.headCommit = onto;
    this.checkoutTree(onto);
    this.note(`rebase 先把 HEAD 挪到 ${upstream}，再逐个重放 ${todo.length} 个提交`);
    return this.rebaseContinue();
  }

  /** Replay the pending commits of a rebase, stopping on the first conflict. */
  rebaseContinue() {
    const repo = this.repo;
    const state = repo.rebaseState;
    if (!state) throw new GitError('fatal: No rebase in progress?');
    while (state.todo.length) {
      const next = state.todo[0];
      const commit = parseCommit(next, repo.objects);
      const baseTree = commit.parents[0] ? this.treeOf(commit.parents[0]) : EMPTY_TREE;
      const { result, conflicts } = this.mergeTrees(this.filesOf(baseTree), this.filesOf('HEAD'), this.filesOf(next), {
        theirsLabel: subjectOf(commit.message),
      });
      if (conflicts.length) {
        this.applyMerge(result);
        state.stoppedAt = next;
        const out = [
          `error: could not apply ${this.short(next)}... ${subjectOf(commit.message)}`,
          '',
          'hint: Resolve all conflicts manually, mark them as resolved with',
          'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".',
        ];
        for (const conflict of conflicts) out.push(`CONFLICT (content): Merge conflict in ${conflict.path}`);
        this.note('重放也可能冲突：Git 停下，把标记写进文件，等你解决后 --continue');
        return { code: 1, stdout: out, stderr: '' };
      }
      this.applyMerge(result);
      repo.writeCommit({ tree: repo.writeTreeFromIndex(), parents: [repo.headHash()], message: commit.message, authorOverride: commit.author });
      state.done.push(next);
      state.todo.shift();
    }
    const tip = repo.headHash();
    repo.headRef = `refs/heads/${state.branch}`;
    repo.headCommit = null;
    repo.refs.set(`refs/heads/${state.branch}`, tip);
    repo.rebaseState = null;
    this.note('重放出来的提交是新对象：父提交变了，commit 内容就变了，哈希也跟着变；原来的提交还在对象库里，只是没有分支指向它');
    return [`Successfully rebased and updated refs/heads/${state.branch}.`];
  }

  cmdCherryPick(args) {
    const { flags, values, args: rest } = parseArgs(args, { m: 'value', message: 'value', abort: 'flag', 'continue': 'flag', quit: 'flag' });
    const repo = this.repo;
    if (flags.has('abort')) {
      const state = repo.mergeState;
      if (!state) throw new GitError('fatal: no cherry-pick in progress');
      if (state.head) {
        this.moveHead(state.head, 'reset: moving to ' + this.short(state.head));
        this.checkoutTree(state.head);
      }
      repo.mergeState = null;
      return [];
    }
    if (flags.has('continue')) return this.finishMerge();
    const names = rest.filter((token) => !token.startsWith('-'));
    if (!names.length) throw new GitError('fatal: empty commit set passed');
    const out = [];
    for (const name of names) {
      const hash = this.resolveCommit(name);
      const commit = parseCommit(hash, repo.objects);
      const head = repo.headHash();
      const baseTree = commit.parents[0] ? this.treeOf(commit.parents[0]) : EMPTY_TREE;
      const { result, conflicts } = this.mergeTrees(this.filesOf(baseTree), head ? this.filesOf(head) : new Map(), this.filesOf(hash), {
        theirsLabel: subjectOf(commit.message),
      });
      this.applyMerge(result);
      if (conflicts.length) {
        repo.mergeState = { type: 'cherry-pick', head, parents: head ? [head] : [], message: values.get('m') ?? values.get('message') ?? commit.message };
        out.push(`error: could not apply ${this.short(hash)}... ${subjectOf(commit.message)}`);
        for (const conflict of conflicts) out.push(`CONFLICT (content): Merge conflict in ${conflict.path}`);
        out.push('hint: After resolving the conflicts, mark them with "git add/rm <paths>", then run "git cherry-pick --continue".');
        return { code: 1, stdout: out, stderr: '' };
      }
      const newHash = repo.writeCommit({ tree: repo.writeTreeFromIndex(), parents: head ? [head] : [], message: commit.message, authorOverride: commit.author });
      out.push(`[${repo.headBranch() ?? 'detached HEAD'} ${this.short(newHash)}] ${subjectOf(commit.message)}`);
    }
    this.note('cherry-pick 把某一个提交的改动三方合并到当前分支，作者信息保留、提交时间更新');
    return out;
  }

  cmdReset(args) {
    const { flags, args: rest } = parseArgs(args, {});
    const repo = this.repo;
    const separator = rest.indexOf('--');
    const before = separator >= 0 ? rest.slice(0, separator) : [...rest];
    const after = separator >= 0 ? rest.slice(separator + 1) : [];
    const revs = before.filter((token) => repo.revParse(token, { quiet: true }));
    const paths = [...before.filter((token) => !repo.revParse(token, { quiet: true })), ...after];

    if (paths.length) {
      const source = revs[0] ?? 'HEAD';
      const from = this.filesOf(source);
      for (const spec of paths) {
        const matched = [...repo.index.keys()].filter((path) => path === spec || path.startsWith(`${spec}/`));
        if (!matched.length && !from.has(spec)) throw new GitError(`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
        for (const path of matched) {
          const entry = from.get(path);
          if (entry) repo.index.set(path, { mode: entry.mode, hash: entry.hash, stage: 0 });
          else repo.index.delete(path);
        }
      }
      this.note('带路径的 reset 只改暂存区：不动 HEAD，也不动工作区');
      return [];
    }

    const rev = revs[0] ?? 'HEAD';
    const target = this.resolveCommit(rev);
    const mode = flags.has('hard') ? 'hard' : flags.has('soft') ? 'soft' : 'mixed';
    this.moveHead(target, `reset: moving to ${rev}`);
    if (mode === 'soft') {
      this.note('--soft 只移动分支引用，暂存区和工作区都保持原样');
      return [];
    }
    if (mode === 'mixed') {
      this.resetIndexTo(target);
      const out = [];
      const unstaged = computeStatus(repo).filter((entry) => !entry.untracked && !entry.ignored && !entry.conflicted && entry.y !== ' ' && entry.y !== '?');
      if (unstaged.length) {
        out.push('Unstaged changes after reset:');
        for (const entry of unstaged) out.push(`${entry.y === 'D' ? 'D' : 'M'}\t${entry.path}`);
      }
      this.note('--mixed（默认）把暂存区也重置到目标提交，工作区不动，于是修改变成“未暂存”');
      return out;
    }
    this.checkoutTree(target);
    this.note('--hard 连工作区一起重置：没提交的修改直接消失，reflog 也救不回来');
    return [`HEAD is now at ${this.short(target)} ${subjectOf(parseCommit(target, repo.objects).message)}`];
  }

  cmdStash(args) {
    const { flags, values, args: rest } = parseArgs(args, { m: 'value', message: 'value', u: 'flag', 'include-untracked': 'flag', i: 'flag', index: 'flag', p: 'flag', patch: 'flag' });    const repo = this.repo;
    const sub = rest.find((token) => ['push', 'list', 'pop', 'apply', 'drop', 'clear', 'show'].includes(token));
    const selector = rest.filter((token) => !['push', 'list', 'pop', 'apply', 'drop', 'clear', 'show'].includes(token) && !token.startsWith('-'))[0] ?? 'stash@{0}';
    const entries = () => repo.stashEntries();
    const indexOf = (token) => (/^\d+$/.test(token) ? Number(token) : Number(/^stash@\{(\d+)\}$/.exec(token)?.[1] ?? 0));

    if (sub === 'list') return entries().map((entry) => `stash@{${entry.index}}: ${entry.message}`);
    if (sub === 'clear') {
      repo.refs.delete('refs/stash');
      this.common.reflogs.delete('refs/stash');
      this.note('stash 清空（那些提交还在对象库里，直到被垃圾回收）');
      return [];
    }
    if (sub === 'drop') {
      const index = indexOf(selector);
      const list = this.common.reflogs.get('refs/stash') ?? [];
      if (!list[index]) throw new GitError(`fatal: ${selector} is not a valid reference`);
      const [removed] = list.splice(index, 1);
      if (list.length) repo.refs.set('refs/stash', list[0].new);
      else repo.refs.delete('refs/stash');
      return [`Dropped ${selector} (${this.short(removed.new)})`];
    }
    if (sub === 'show') {
      const entry = entries()[indexOf(selector)];
      if (!entry) throw new GitError(`fatal: ${selector} is not a valid reference`);
      const commit = parseCommit(entry.hash, repo.objects);
      const oldMap = commit.parents[0] ? this.filesOf(commit.parents[0]) : new Map();
      return this.renderDiff(oldMap, this.filesOf(entry.hash), { stat: !flags.has('p') && !flags.has('patch') });
    }
    if (sub === 'pop' || sub === 'apply') {
      const index = indexOf(selector);
      const entry = entries()[index];
      if (!entry) throw new GitError(`fatal: ${selector} is not a valid reference`);
      const head = repo.headHash();
      const headMap = head ? this.filesOf(head) : new Map();
      const { result, conflicts } = this.mergeTrees(headMap, headMap, this.filesOf(entry.hash), { oursLabel: 'HEAD', theirsLabel: 'Stashed changes' });
      // Like Git, the working tree gets the changes but the index is only
      // restored with `--index`.
      if (conflicts.length || flags.has('i') || flags.has('index')) {
        this.applyMerge(result);
      } else {
        for (const [path, item] of result) this.writeWork(path, item.content);
        if (head) this.resetIndexTo(head);
      }
      const out = [`On branch ${repo.headBranch() ?? 'HEAD'}`];
      if (conflicts.length) {
        out.push('CONFLICT (content): Merge conflict in the stashed changes');
        this.note('stash 应用时也可能冲突：stash 本身就是提交，pop 就是一次合并');
      } else {
        this.note('stash pop = 把存起来的修改合回来 + 丢掉这条 stash');
      }
      if (sub === 'pop') {
        const list = this.common.reflogs.get('refs/stash') ?? [];
        list.splice(index, 1);
        if (list.length) repo.refs.set('refs/stash', list[0].new);
        else repo.refs.delete('refs/stash');
        out.push(`Dropped ${selector} (${this.short(entry.hash)})`);
      }
      return out;
    }

    // git stash [push -m msg]
    const head = repo.headHash();
    const dirty = computeStatus(repo).filter((entry) => !entry.untracked && !entry.ignored && (entry.x !== ' ' || entry.y !== ' '));
    if (!dirty.length) return { code: 0, stdout: 'No local changes to save', stderr: '' };
    const branch = repo.headBranch() ?? 'HEAD (no branch)';
    const subject = head ? subjectOf(parseCommit(head, repo.objects).message) : '';
    const label = values.get('m') ?? values.get('message');
    const message = label ? `On ${branch}: ${label}` : `WIP on ${branch}: ${this.short(head)} ${subject}`;
    const paths = [...repo.index.keys()]
      .filter((path) => repo.files.has(path))
      .map((path) => ({ path, hash: repo.objects.write('blob', toBytes(repo.readFile(path))), mode: repo.index.get(path).mode }));
    const tree = repo.buildTreeFromPaths(paths);
    const hash = buildCommit(repo.objects, {
      tree,
      parents: head ? [head] : [],
      author: this.common.ident('author', repo),
      committer: this.common.ident('committer', repo),
      message: `${message}\n`,
    });
    repo.updateRef('refs/stash', hash, `stash@{0}: ${message}`);
    if (head) this.checkoutTree(head);
    else {
      repo.files.clear();
      repo.index.clear();
    }
    this.note('stash 把未提交的修改存成一个特殊提交（refs/stash），工作区随之恢复干净');
    return [`Saved working directory and index state ${message}`];
  }

  // ---- remotes -----------------------------------------------------------

  /** Copy objects from `source` that we do not have yet; returns how many. */
  copyObjects(source) {
    const repo = this.repo;
    let copied = 0;
    for (const object of source.objects.list()) {
      if (repo.objects.has(object.hash)) continue;
      repo.objects.writeRaw(object.type, object.bytes);
      copied++;
    }
    return copied;
  }

  fetchRemote(name) {
    const repo = this.repo;
    const remote = this.remotes.get(name);
    if (!remote) throw new GitError(`fatal: '${name}' does not appear to be a git repository`);
    this.copyObjects(remote.repo);
    const out = [];
    for (const [ref, hash] of [...remote.repo.refs.entries()].sort((a, b) => compareText(a[0], b[0]))) {
      if (!ref.startsWith('refs/heads/')) continue;
      const short = ref.slice('refs/heads/'.length);
      const target = `refs/remotes/${name}/${short}`;
      const previous = repo.refs.get(target) ?? null;
      if (previous === hash) continue;
      repo.updateRef(target, hash, `fetch ${name}: storing head`);
      out.push(`From ${remote.url}`, `   ${previous ? this.short(previous) : '0000000'}..${this.short(hash)}  ${short}\t-> ${name}/${short}`);
    }
    return out;
  }

  cmdRemote(args) {
    const { flags, args: rest } = parseArgs(args, {});
    const verbose = flags.has('v') || flags.has('verbose');
    const [sub, name, url] = rest;
    if (!sub) {
      return verbose
        ? [...this.remotes.entries()].flatMap(([key, remote]) => [`${key}\t${remote.url} (fetch)`, `${key}\t${remote.url} (push)`])
        : [...this.remotes.keys()].sort(compareText);
    }
    if (sub === 'add') {
      if (!name || !url) throw new GitError('usage: git remote add <name> <url>');
      if (this.remotes.has(name)) throw new GitError(`error: remote ${name} already exists.`);
      this.remotes.set(name, { url, repo: createRemote(url) });
      this.note('远端也就是另一组“对象 + 引用”；demo:// 开头的是本模拟器里的示例远端');
      return [];
    }
    if (sub === 'remove' || sub === 'rm') {
      if (!this.remotes.has(name)) throw new GitError(`error: No such remote: '${name}'`);
      this.remotes.delete(name);
      return [];
    }
    if (sub === 'get-url') {
      const remote = this.remotes.get(name);
      if (!remote) throw new GitError(`error: No such remote '${name}'`);
      return [remote.url];
    }
    if (!this.remotes.has(sub)) throw new GitError(`error: No such remote '${sub}'`);
    return verbose
      ? [...this.remotes.entries()].flatMap(([key, remote]) => [`${key}\t${remote.url} (fetch)`, `${key}\t${remote.url} (push)`])
      : [...this.remotes.keys()].sort(compareText);
  }

  cmdFetch(args) {
    const { args: rest } = parseArgs(args, { all: 'flag', prune: 'flag', p: 'flag' });
    const name = rest.find((token) => this.remotes.has(token)) ?? (this.remotes.size === 1 ? [...this.remotes.keys()][0] : null);
    if (!name) throw new GitError("fatal: 'origin' does not appear to be a git repository");
    const out = this.fetchRemote(name);
    this.note('fetch 只把对方的对象和引用拷过来（origin/main 这类远端跟踪引用），不碰你的工作区和分支');
    return out;
  }

  cmdPull(args) {
    const { flags, args: rest } = parseArgs(args, { 'ff-only': 'flag', rebase: 'flag', noRebase: 'flag' });
    const repo = this.repo;
    const name = rest.find((token) => this.remotes.has(token)) ?? (this.remotes.size ? [...this.remotes.keys()][0] : null);
    if (!name) throw new GitError("fatal: No remote repository specified.");
    const branch = repo.headBranch();
    const mergeRef = this.common.config[`branch.${branch}.merge`] ?? `refs/heads/${branch}`;
    const tracking = `refs/remotes/${name}/${mergeRef.replace(/^refs\/heads\//, '')}`;
    const out = this.fetchRemote(name);
    if (!repo.refs.has(tracking)) throw new GitError(`fatal: no tracking information for the current branch`);
    out.push(`From ${this.remotes.get(name).url}`, ` * branch ${branch} -> FETCH_HEAD`);
    const mergeArgs = flags.has('rebase') ? ['--rebase', tracking] : [tracking];
    return [...out, ...this.cmdMerge(mergeArgs)];
  }

  cmdPush(args) {
    const { flags, args: rest } = parseArgs(args, { u: 'flag', 'set-upstream': 'flag', f: 'flag', force: 'flag' });
    const repo = this.repo;
    const name = rest.find((token) => this.remotes.has(token)) ?? (this.remotes.size === 1 ? [...this.remotes.keys()][0] : 'origin');
    const remote = this.remotes.get(name);
    if (!remote) throw new GitError(`fatal: '${name}' does not appear to be a git repository`);
    const refspec = rest.find((token) => token.includes(':'));
    const branch = refspec ? refspec.split(':')[0] : rest.find((token) => !this.remotes.has(token) && token !== name) ?? repo.headBranch();
    if (!branch) throw new GitError('fatal: You are not currently on a branch.');
    const hash = repo.refs.get(`refs/heads/${branch}`);
    if (!hash) throw new GitError(`error: src refspec ${branch} does not match any`);
    const remoteRef = refspec ? refspec.split(':')[1] : `refs/heads/${branch}`;
    const previous = remote.repo.refs.get(remoteRef) ?? null;
    for (const object of repo.objects.list()) {
      if (remote.repo.objects.has(object.hash)) continue;
      remote.repo.objects.writeRaw(object.type, object.bytes);
    }
    remote.repo.refs.set(remoteRef, hash);
    if (flags.has('u') || flags.has('set-upstream')) {
      this.common.config[`branch.${branch}.remote`] = name;
      this.common.config[`branch.${branch}.merge`] = `refs/heads/${branch}`;
      this.note(`-u 记下 ${branch} 的上游是 ${name}/${branch}，之后 git status 会显示领先/落后几个提交`);
    }
    const short = remoteRef.replace(/^refs\/heads\//, '');
    const out = [`To ${remote.url}`];
    out.push(previous ? `   ${this.short(previous)}..${this.short(hash)}  ${branch} -> ${short}` : ` * [new branch]      ${branch} -> ${short}`);
    this.note('push 把本地对象传到远端并更新远端的分支引用；你的工作区和本地分支都不变');
    return out;
  }

  cmdClone(args) {
    const { args: rest } = parseArgs(args, {});
    const url = rest[0];
    if (!url) throw new GitError('usage: git clone <url> [<dir>]');
    const source = createRemote(url);
    const dir = normalizePath(rest[1] ?? url.replace(/^demo:\/\//, '').replace(/\.git$/, ''));
    const common = new CommonStore({ name: this.common.user.name, email: this.common.user.email, clock: this.common.clock });
    for (const object of source.objects.list()) common.objects.writeRaw(object.type, object.bytes);
    const branch = 'main';
    const head = source.refs.get(`refs/heads/${branch}`);
    if (!head) throw new GitError(`fatal: repository '${url}' has no ${branch} branch`);
    for (const [ref, hash] of source.refs) if (ref.startsWith('refs/heads/')) common.refs.set(ref, hash);
    const git = new Git({ common, dir });
    git.initialized = true;
    git.repo.headRef = `refs/heads/${branch}`;
    git.repo.checkoutCommit(head);
    git.remotes.set('origin', { url, repo: source });
    git.common.config[`branch.${branch}.remote`] = 'origin';
    git.common.config[`branch.${branch}.merge`] = `refs/heads/${branch}`;
    git.notes.push(`cloning '${url}' into '${dir}'`);
    git.notes.push('clone 把远端的对象和引用整份拷过来，并设置 origin 作为上游');
    return { code: 0, stdout: [`Cloning into '${dir}'...`, 'done.'], stderr: '', replace: git };
  }

  // ---- worktrees ---------------------------------------------------------

  cmdWorktree(args) {
    const { flags, args: rest } = parseArgs(args, { b: 'flag', B: 'flag', f: 'flag', force: 'flag' });
    const repo = this.repo;
    const sub = rest[0];
    if (!sub || sub === 'list') {
      return [...this.worktrees.values()].map((worktree) => {
        const head = worktree.headHash();
        const branch = worktree.headBranch();
        return `${worktree.dir.padEnd(24)} ${head ? this.short(head) : '0000000'} [${branch ?? 'HEAD detached'}]`;
      });
    }
    if (sub === 'prune') return [];
    if (sub === 'remove') {
      const dir = rest[1];
      if (!dir || !this.worktrees.has(dir)) throw new GitError(`fatal: '${dir}' is not a working tree`);
      this.worktrees.delete(dir);
      if (this.repo.dir === dir) {
        const next = [...this.worktrees.values()][0];
        if (next) this.repo = next;
      }
      return [];
    }
    if (sub !== 'add') throw new GitError('usage: git worktree add [-b <branch>] <dir> [<commit-ish>]');
    const paths = rest.slice(1).filter((token) => !token.startsWith('-'));
    const create = flags.has('b') || flags.has('B');
    const branchName = create ? paths[0] : null;
    const dir = normalizePath(create ? paths[1] : paths[0]);
    const start = create ? paths[2] ?? 'HEAD' : paths[1];
    if (!dir) throw new GitError('fatal: missing working tree path');
    if (this.worktrees.has(dir)) throw new GitError(`fatal: '${dir}' already exists`);
    const hash = this.resolveCommit(start ?? 'HEAD');
    let headRef = null;
    if (branchName) headRef = `refs/heads/${branchName}`;
    else if (!create && start && repo.refs.has(`refs/heads/${start}`)) headRef = `refs/heads/${start}`;
    if (branchName) repo.updateRef(`refs/heads/${branchName}`, hash, `branch: Created from ${start ?? 'HEAD'}`);
    const worktree = this.addWorktree(dir, { headRef, headCommit: headRef ? null : hash });
    worktree.checkoutCommit(hash);
    this.note(`新工作目录 ${dir} 与主仓库共享对象库和 refs/，但有自己的 HEAD、暂存区和工作区`);
    return [`Preparing worktree (new branch '${branchName ?? 'HEAD'}')`, `HEAD is now at ${this.short(hash)} ${subjectOf(parseCommit(hash, repo.objects).message)}`];
  }

  useWorktree(dir) {
    const worktree = this.worktrees.get(dir);
    if (!worktree) throw new GitError(`fatal: '${dir}' is not a working tree`);
    this.repo = worktree;
  }

  // ---- extras ------------------------------------------------------------

  cmdBlame(args) {
    const { args: rest } = parseArgs(args, {});
    const repo = this.repo;
    const path = normalizePath(rest[0] ?? '');
    if (!path) throw new GitError('fatal: no path given');
    const head = repo.headHash();
    if (!head) throw new GitError(`fatal: no such path '${path}' in HEAD`);
    const file = repo.readFile(path);
    if (file === null) throw new GitError(`fatal: no such path '${path}' in HEAD`);
    const lines = splitLines(file);
    const owners = new Array(lines.length).fill(null);
    for (const hash of repo.order(repo.ancestorsOf(head)).reverse()) {
      const commit = parseCommit(hash, repo.objects);
      const before = commit.parents[0] ? (this.filesOf(commit.parents[0]).get(path)?.content ?? null) : null;
      const after = this.filesOf(hash).get(path)?.content ?? null;
      if (before === after) continue;
      for (const op of diffLines(before ?? '', after ?? '')) if (op.type === 'add') owners[op.bIndex] = hash;
    }
    const width = String(lines.length).length;
    return lines.map((line, index) => {
      const hash = owners[index];
      if (!hash) return `${'0000000'} (Not Committed Yet ${String(index + 1).padStart(width)}) ${line}`;
      const commit = parseCommit(hash, repo.objects);
      return `${this.short(hash)} (${commit.author.name} ${isoDate(commit.author.timestamp, commit.author.tz)} ${String(index + 1).padStart(width)}) ${line}`;
    });  }

  cmdHelp(args) {
    const { args: rest } = parseArgs(args, {});
    if (!rest.length) return this.help();
    const wanted = rest[0];
    const matches = HELP_GROUPS.flatMap((group) => group.commands).filter(([name]) => name.startsWith(wanted));
    if (!matches.length) return [`没有找到 '${wanted}' 的说明；直接输入 git help 看全部命令。`];
    return [`${wanted}:`, ...matches.flatMap(([name, text]) => [`  ${name.padEnd(28)} ${text}`])];
  }

  cmdVersion() {
    return ['git version 2.43.0 (gse-git-notes simulator)'];
  }
}

/** An in-memory "remote": another object database plus refs, like a bare repo. */
function createRemote(url) {
  const key = String(url);
  if (!/^demo:\/\//.test(key)) {
    throw new GitError(`fatal: unable to access '${url}': 本模拟器没有网络，只能访问 demo:// 开头的示例远端`);
  }
  // One in-memory repository per URL, so pushing and then cloning sees the
  // same history — the way two machines talking to one remote would.
  if (REMOTES.has(key)) return REMOTES.get(key);
  const name = key.replace(/^demo:\/\//, '').replace(/\.git$/, '');
  const common = new CommonStore({ name: 'Upstream Author', email: 'upstream@example.com', clock: 1_700_100_000, initDefaultBranch: 'main' });
  const repo = new Repo({ common, dir: `${name}.git`, headRef: 'refs/heads/main' });
  const commit = (path, content, message) => {
    repo.files.set(path, content);
    repo.stageFile(path, content);
    repo.writeCommit({ tree: repo.writeTreeFromIndex(), parents: repo.headHash() ? [repo.headHash()] : [], message });
  };
  commit('README.md', '# demo notes\n\n这是一个演示用的远端仓库。\n', 'docs: add README');
  commit('hello.py', 'print("hello from upstream")\n', 'feat: hello world');
  REMOTES.set(key, repo);
  return repo;
}

const REMOTES = new Map();

/** Forget every simulated remote (used by tests and the UI's reset button). */
export function resetRemotes() {
  REMOTES.clear();
}

const COMMANDS = {
  init: 'cmdInit',
  'hash-object': 'cmdHashObject',
  add: 'cmdAdd',
  rm: 'cmdRm',
  commit: 'cmdCommit',
  status: 'cmdStatus',
  diff: 'cmdDiff',
  log: 'cmdLog',
  show: 'cmdShow',
  'cat-file': 'cmdCatFile',
  'ls-files': 'cmdLsFiles',
  'ls-tree': 'cmdLsTree',
  'rev-parse': 'cmdRevParse',
  config: 'cmdConfig',
  branch: 'cmdBranch',
  switch: 'cmdSwitch',
  checkout: 'cmdCheckout',
  restore: 'cmdRestore',
  tag: 'cmdTag',
  reflog: 'cmdReflog',
  merge: 'cmdMerge',
  rebase: 'cmdRebase',
  'cherry-pick': 'cmdCherryPick',
  reset: 'cmdReset',
  stash: 'cmdStash',
  remote: 'cmdRemote',
  fetch: 'cmdFetch',
  pull: 'cmdPull',
  push: 'cmdPush',
  clone: 'cmdClone',
  worktree: 'cmdWorktree',
  blame: 'cmdBlame',
  help: 'cmdHelp',
  version: 'cmdVersion',
};

const HELP_GROUPS = [
  {
    title: '建立仓库与提交',
    commands: [
      ['init [-b main]', '建立空仓库，HEAD 指向还不存在的分支'],
      ['add <path>...', '把工作区内容写成 blob，记入暂存区'],
      ['rm [--cached] <path>', '从暂存区（和工作区）删除'],
      ['commit -m <msg>', '把暂存区固化成 tree + commit，分支前移'],
      ['status [-s] [-b]', '看三个区域之间的差异'],
      ['diff [--cached] [rev]', '工作区 vs 暂存区 / 暂存区 vs HEAD'],
      ['log [--oneline --graph]', '读历史，只读命令'],
    ],
  },
  {
    title: '读对象',
    commands: [
      ['cat-file -p|-t|-s <obj>', '打印对象内容 / 类型 / 大小'],
      ['hash-object [-w] <file>', '计算（并可写入）blob 的哈希'],
      ['ls-files [-s]', '暂存区里有什么'],
      ['ls-tree [-r] <rev>', '某个提交的目录树'],
      ['show <rev>', '提交内容 + 相对父提交的 diff'],
      ['rev-parse <rev>', '把 HEAD、main~2、abc1234 解析成哈希'],
      ['blame <file>', '每一行来自哪个提交'],
    ],
  },
  {
    title: '分支与切换',
    commands: [
      ['branch [name] [-d] [-m]', '引用就是文件：建、删、改名字'],
      ['switch [-c] <branch>', '切换分支，HEAD 改指'],
      ['checkout <branch|rev>', '老命令，身兼切换与恢复文件'],
      ['restore [--staged] <path>', '恢复文件到暂存区或 HEAD 的版本'],
      ['tag [-a] [-d] <name>', '不会挪动的引用'],
    ],
  },
  {
    title: '汇合历史',
    commands: [
      ['merge <branch>', '三方合并：fast-forward、合并提交或冲突'],
      ['rebase <upstream>', '把提交重放到另一条线上，哈希会变'],
      ['cherry-pick <rev>', '把某一个提交的改动搬过来'],
      ['reset [--soft|--hard] [rev]', '移动分支，按程度重置暂存区/工作区'],
      ['stash [pop|list|drop]', '把未提交修改存成特殊提交'],
      ['reflog', '引用移动记录，误操作后的安全网'],
    ],
  },
  {
    title: '远端与多工作目录',
    commands: [
      ['remote [-v] [add <n> <url>]', '管理远端；demo://xxx 会生成一个示例远端'],
      ['clone demo://notes', '把示例远端克隆成一个新仓库'],
      ['fetch / pull / push', '只拿引用 / 拿完再合 / 把提交推上去'],
      ['worktree add [-b b] <dir>', '同一对象库挂多个工作目录'],
    ],
  },
];

function emptyEffects() {
  return { objects: [], refs: [], worktree: [], index: [] };
}

function diffStates(before, after, git) {
  const effects = emptyEffects();
  for (const hash of after.objects) {
    if (before.objects.has(hash)) continue;
    const object = git.repo.objects.get(hash);
    effects.objects.push({ hash, type: object.type, size: object.size });
  }
  for (const [ref, hash] of after.refs) {
    const from = before.refs.get(ref) ?? null;
    if (from !== hash) effects.refs.push({ ref, from, to: hash });
  }
  for (const [ref, hash] of before.refs) {
    if (!after.refs.has(ref)) effects.refs.push({ ref, from: hash, to: null });
  }
  for (const [path, hash] of after.files) {
    const from = before.files.get(path) ?? null;
    if (from !== hash) effects.worktree.push({ path, action: from ? 'modified' : 'created', hash });
  }
  for (const [path, hash] of before.files) {
    if (!after.files.has(path)) effects.worktree.push({ path, action: 'deleted', hash });
  }
  for (const [path, value] of after.index) {
    const from = before.index.get(path) ?? null;
    if (from !== value) effects.index.push({ path, action: from ? 'modified' : 'staged', value });
  }
  for (const [path, value] of before.index) {
    if (!after.index.has(path)) effects.index.push({ path, action: 'unstaged', value });
  }
  return effects;
}
