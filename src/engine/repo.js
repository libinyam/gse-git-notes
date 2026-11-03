import {
  ObjectStore,
  GitError,
  buildTree,
  buildCommit,
  buildTag,
  parseTree,
  parseCommit,
  parseTag,
} from './objects.js';
import { splitLines, toBytes } from './bytes.js';

export { GitError, parseCommit, parseTree, parseTag, buildCommit, buildTree, buildTag };

/**
 * Everything worktrees share: the object database, the refs, their reflogs,
 * config and the clock. A Repo is one working tree sitting on top of this.
 */
export class CommonStore {
  constructor(options = {}) {
    this.objects = new ObjectStore();
    this.refs = new Map();
    this.reflogs = new Map();
    this.remotes = new Map();
    this.clock = options.clock ?? 1_700_000_000;
    this.stepSeconds = options.stepSeconds ?? 1;
    this.tz = options.tz ?? '+0800';
    this.user = { name: options.name || 'Git Learner', email: options.email || 'learner@example.com' };
    this.initDefaultBranch = options.initDefaultBranch || 'main';
    this.config = {
      'core.editor': 'vi',
      'alias.v': 'status',
      'user.name': this.user.name,
      'user.email': this.user.email,
      ...(options.config || {}),
    };
    this.ignore = [];
  }

  ident(kind, repo) {
    const timestamp = kind === 'author' ? (repo?.authorTime ?? this.clock) : (repo?.commitTime ?? this.clock);
    return { name: this.user.name, email: this.user.email, timestamp, tz: this.tz };
  }

  tick() {
    const value = this.clock;
    this.clock += this.stepSeconds;
    return value;
  }

  pushReflog(ref, oldHash, newHash, message, timestamp) {
    if (!this.reflogs.has(ref)) this.reflogs.set(ref, []);
    this.reflogs.get(ref).unshift({ old: oldHash, new: newHash, message, timestamp });
  }

  reflog(ref) {
    return this.reflogs.get(ref) || [];
  }

  refNames(prefix = '') {
    return [...this.refs.keys()].filter((name) => name.startsWith(prefix));
  }
}

export class Repo {
  constructor(options = {}) {
    this.common = options.common || new CommonStore(options);
    this.dir = options.dir ?? 'lab';
    this.headRef = options.headRef ?? null;
    this.headCommit = options.headCommit ?? null;
    this.index = new Map();
    this.files = new Map();
    this.mergeState = options.mergeState ?? null;
    this.rebaseState = options.rebaseState ?? null;
    this.authorTime = options.authorTime ?? null;
    this.commitTime = options.commitTime ?? null;
    this.worktrees = new Map();
  }

  get objects() {
    return this.common.objects;
  }

  get refs() {
    return this.common.refs;
  }

  // ---- HEAD -------------------------------------------------------------

  headBranch() {
    if (!this.headRef || !this.headRef.startsWith('refs/heads/')) return null;
    return this.headRef.slice('refs/heads/'.length);
  }

  isDetached() {
    return this.headRef === null;
  }

  headHash() {
    if (this.isDetached()) return this.headCommit;
    // An unborn branch has no ref yet; headCommit is the only thing we know.
    return this.refs.get(this.headRef) ?? this.headCommit ?? null;
  }

  /** The name Git prints in prompts and status headers. */
  headDescription() {
    const branch = this.headBranch();
    if (branch) return branch;
    const hash = this.headHash();
    if (!hash) return 'unknown';
    const tag = this.tagPointingAt(hash);
    if (tag) return tag;
    const branchNamed = this.branches().find((b) => b.hash === hash);
    if (branchNamed) return branchNamed.name;
    return `HEAD detached at ${this.shortHash(hash)}`;
  }

  tagPointingAt(hash) {
    for (const [name, target] of this.refs) {
      if (!name.startsWith('refs/tags/')) continue;
      const object = this.objects.get(target);
      const resolved = object?.type === 'tag' ? parseTag(target, this.objects).object : target;
      if (resolved === hash) return name.slice('refs/tags/'.length);
    }
    return null;
  }

  // ---- references -------------------------------------------------------

  /**
   * The object a ref names, without peeling: an annotated tag ref resolves to
   * the tag object, exactly as `git rev-parse v1` prints it. Callers that need
   * a commit peel with `peel()`.
   */
  resolveRef(name) {
    if (name === 'HEAD') return this.headHash();
    return this.refs.get(name) ?? null;
  }

  /** Follow tag objects until a non-tag object; other ids pass through. */
  peel(hash) {
    let current = hash;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const object = this.objects.get(current);
      if (object?.type !== 'tag') return current;
      current = parseTag(current, this.objects).object;
    }
    return current;
  }

  updateRef(ref, hash, message, { failIfMissing = false } = {}) {
    if (ref === 'HEAD') {
      const old = this.headHash();
      if (this.headRef) {
        this.refs.set(this.headRef, hash);
        this.common.pushReflog(this.headRef, old, hash, message, this.common.clock);
      } else {
        this.headCommit = hash;
      }
      this.common.pushReflog('HEAD', old, hash, message, this.common.clock);
      return;
    }
    if (failIfMissing && !this.refs.has(ref)) throw new GitError(`error: ref ${ref} is missing`);
    const old = this.refs.get(ref) ?? null;
    if (hash === null) this.refs.delete(ref);
    else this.refs.set(ref, hash);
    this.common.pushReflog(ref, old, hash, message, this.common.clock);
  }

  branches(includeRemote = false) {
    return [...this.refs.entries()]
      .filter(([name]) => (includeRemote ? /^refs\/(heads|remotes)\//.test(name) : name.startsWith('refs/heads/')))
      .map(([name, hash]) => ({
        name: name.replace(/^refs\/(heads|remotes)\//, ''),
        fullName: name,
        hash,
      }));
  }

  tags() {
    return [...this.refs.entries()]
      .filter(([name]) => name.startsWith('refs/tags/'))
      .map(([name, hash]) => ({ name: name.slice('refs/tags/'.length), hash }));
  }

  /** Turn `HEAD`, `main~2`, `HEAD^{tree}`, `abc1234` into an object id. */
  revParse(revision, { quiet = false } = {}) {
    const text = String(revision ?? '').trim();
    const modifiers = [];
    let base = text;
    for (;;) {
      const typeMatch = /\^\{\s*(tree|commit|blob)\s*\}$/.exec(base);
      const caret = typeMatch ? null : /\^(\d*)$/.exec(base);
      const tilde = typeMatch || caret ? null : /~(\d*)$/.exec(base);
      const match = typeMatch || caret || tilde;
      if (!match) break;
      if (typeMatch) modifiers.unshift({ kind: typeMatch[1] });
      else if (caret) modifiers.unshift({ kind: 'parent', n: caret[1] ? Number(caret[1]) : 1 });
      else modifiers.unshift({ kind: 'tilde', n: tilde[1] ? Number(tilde[1]) : 1 });
      base = base.slice(0, match.index);
    }

    let hash = this.resolveBase(base);
    if (!hash) {
      if (quiet) return null;
      throw new GitError(`fatal: ambiguous argument '${text}': unknown revision or path not in the working tree.`);
    }
    for (const modifier of modifiers) {
      const fail = () => {
        if (quiet) return null;
        throw new GitError(`fatal: ambiguous argument '${text}': unknown revision or path not in the working tree.`);
      };
      if (modifier.kind === 'tree') return parseCommit(hash, this.objects).tree;
      if (modifier.kind === 'blob') return hash;
      if (modifier.kind === 'commit') {
        const object = this.objects.get(hash);
        if (object.type === 'tag') hash = parseTag(hash, this.objects).object;
        continue;
      }
      if (modifier.kind === 'parent') {
        hash = parseCommit(hash, this.objects).parents[modifier.n - 1] ?? fail();
        if (!hash) return fail();
      } else {
        for (let i = 0; i < modifier.n; i++) {
          const parents = parseCommit(hash, this.objects).parents;
          if (!parents.length) return fail();
          hash = parents[0];
        }
      }
    }
    return hash;
  }

  resolveBase(name) {
    if (!name) return null;
    if (name === 'HEAD' || name === '@') return this.headHash();
    const colon = name.indexOf(':');
    if (colon >= 0) return this.resolvePathSyntax(name, colon);
    const stashMatch = /^stash@\{(\d+)\}$/.exec(name);
    if (stashMatch) return this.stashEntries()[Number(stashMatch[1])]?.hash ?? null;
    if (name === 'stash') return this.refs.get('refs/stash') ?? null;
    const reflogMatch = /^(HEAD|@)?@\{(\d+)\}$/.exec(name);
    if (reflogMatch) {
      const entries = this.reflogEntries(reflogMatch[1] === 'HEAD' || !reflogMatch[1] ? 'HEAD' : reflogMatch[1]);
      return entries[Number(reflogMatch[2])]?.new ?? null;
    }
    const direct = this.refs.get(name);
    if (direct) return this.resolveRef(name);
    for (const prefix of ['refs/heads/', 'refs/tags/', 'refs/remotes/', 'refs/remotes/origin/']) {
      if (this.refs.has(prefix + name)) return this.resolveRef(prefix + name);
    }
    if (/^[0-9a-f]{4,40}$/.test(name)) {
      const matches = this.objects.list().filter((object) => object.hash.startsWith(name));
      if (matches.length === 1) return matches[0].hash;
      if (matches.length > 1) throw new GitError(`error: short object id ${name} is ambiguous`);
    }
    return null;
  }

  /** `<rev>:<path>`, `:<path>` and `:<stage>:<path>` — the blob at a path. */
  resolvePathSyntax(name, colon) {
    const rev = name.slice(0, colon);
    const rest = name.slice(colon + 1);
    const stageMatch = /^(\d+):/.exec(rest);
    const stage = stageMatch ? Number(stageMatch[1]) : 0;
    const path = normalizePath(stageMatch ? rest.slice(2) : rest);
    if (!rev) {
      const entry = this.index.get(path);
      if (!entry) return null;
      // `:path` is stage 0; a conflicted path only answers `:1:`/`:2:`/`:3:`
      if (stage === 0) return entry.conflicted ? null : entry.hash;
      return entry.conflicted?.[stage] ?? null;
    }
    const hash = this.resolveRef(rev);
    if (!hash) return null;
    const found = this.listTree(hash).find((entry) => entry.path === path);
    return found && found.mode !== '40000' ? found.hash : null;
  }

  reflogEntries(ref) {    return this.common.reflog(ref === 'HEAD' ? 'HEAD' : this.refFullName(ref));
  }

  refFullName(name) {
    if (name.startsWith('refs/')) return name;
    if (name === 'HEAD') return 'HEAD';
    for (const prefix of ['refs/heads/', 'refs/tags/', 'refs/remotes/']) {
      if (this.refs.has(prefix + name)) return prefix + name;
    }
    return `refs/${name}`;
  }

  shortHash(hash) {
    if (!hash) return '';
    const all = [...new Set([...this.objects.list().map((object) => object.hash), ...this.refs.values()])];
    for (let length = 7; length <= 40; length++) {
      const prefix = hash.slice(0, length);
      if (all.filter((candidate) => candidate.startsWith(prefix)).length === 1) return prefix;
    }
    return hash;
  }

  // ---- index & working tree --------------------------------------------

  /** Blob id for working tree content; nothing is written to the object store. */
  hashContent(content) {
    return this.objects.hashOnly('blob', toBytes(this.applyFilters(content)));
  }

  applyFilters(content) {
    // core.autocrlf is off by default here; kept as a hook for future lessons.
    return content;
  }

  listTree(revision = 'HEAD', { recursive = true } = {}) {
    const hash = typeof revision === 'string' ? this.revParse(revision, { quiet: true }) : revision;
    if (!hash) return [];
    const object = this.objects.get(hash);
    const root = object.type === 'commit' ? parseCommit(hash, this.objects).tree : hash;
    const out = [];
    const walk = (treeHash, prefix) => {
      for (const entry of parseTree(treeHash, this.objects).entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') {
          if (recursive) walk(entry.hash, path);
          else out.push({ path, mode: '40000', hash: entry.hash });
        } else {
          out.push({ path, mode: entry.mode, hash: entry.hash });
        }
      }
    };
    walk(root, '');
    return out;
  }

  readFromCommit(revision, path) {
    const hash = this.revParse(revision, { quiet: true });
    if (!hash) return null;
    const entry = this.listTree(hash).find((item) => item.path === path);
    if (!entry || entry.mode === '40000') return null;
    return { content: this.objects.text(entry.hash), mode: entry.mode, hash: entry.hash };
  }

  stageFile(path, content) {
    const bytes = toBytes(this.applyFilters(content));
    const hash = this.objects.write('blob', bytes);
    const mode = this.executablePaths?.has(path) ? '100755' : '100644';
    this.index.set(path, { mode, hash, stage: 0 });
    return hash;
  }

  unstagePath(path) {
    const head = this.headHash();
    const inHead = head ? this.listTree(head).find((entry) => entry.path === path) : null;
    if (inHead) this.index.set(path, { mode: inHead.mode, hash: inHead.hash, stage: 0 });
    else this.index.delete(path);
  }

  writeTreeFromIndex() {
    const paths = this.indexEntries().map((entry) => ({ path: entry.path, mode: entry.mode, hash: entry.hash }));
    return this.buildTreeFromPaths(paths);
  }

  /** Index entries; conflicted paths contribute nothing until they are resolved. */
  indexEntries() {
    return [...this.index.entries()]
      .filter(([, entry]) => !entry.conflicted)
      .map(([path, entry]) => ({ path, mode: entry.mode, hash: entry.hash }));
  }

  conflictedPaths() {
    return [...this.index.entries()].filter(([, entry]) => entry.conflicted).map(([path, entry]) => ({ path, entry }));
  }

  buildTreeFromPaths(paths) {
    const root = { kind: 'dir', children: new Map() };
    for (const { path, mode, hash } of paths) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const name = parts[i];
        if (!node.children.has(name)) node.children.set(name, { kind: 'dir', name, children: new Map() });
        node = node.children.get(name);
      }
      node.children.set(parts[parts.length - 1], { kind: 'file', name: parts[parts.length - 1], mode, hash });
    }
    // Empty directories have no tree object, so they drop out here.
    const build = (node) => {
      const entries = [];
      for (const child of node.children.values()) {
        if (child.kind === 'dir') {
          entries.push({ mode: '40000', name: child.name, hash: buildTree(this.objects, build(child)).hash });
        } else {
          entries.push({ mode: child.mode, name: child.name, hash: child.hash });
        }
      }
      return entries;
    };
    return buildTree(this.objects, build(root)).hash;
  }

  parentsOfHead() {
    const hash = this.headHash();
    return hash ? [hash] : [];
  }

  commitIndex({ message, parents, amend = false, gpgsig }) {
    const tree = this.writeTreeFromIndex();
    return this.writeCommit({ tree, parents, message, amend, gpgsig });
  }

  writeCommit({ tree, parents, message, amend = false, gpgsig, authorOverride, committerOverride }) {
    const author = authorOverride ?? this.common.ident('author', this);
    let committer = committerOverride ?? this.common.ident('committer', this);
    committer = { ...committer, timestamp: this.commitTime ?? this.common.tick() };
    const hash = buildCommit(this.objects, {
      tree,
      parents,
      author,
      committer,
      message: message.endsWith('\n') ? message : `${message}\n`,
      gpgsig,
    });
    const reflogMessage = amend
      ? `commit (amend): ${subjectOf(message)}`
      : parents.length === 0
        ? `commit (initial): ${subjectOf(message)}`
        : /^Merge\b/.test(subjectOf(message))
          ? `commit (merge): ${subjectOf(message)}`
          : `commit: ${subjectOf(message)}`;
    this.updateRef('HEAD', hash, reflogMessage);
    return hash;
  }

  /** Replace working tree + index with a commit's snapshot. */
  checkoutCommit(hash, { paths = null, keeping = new Set(), from = null } = {}) {
    const wanted = new Map(this.listTree(hash).map((entry) => [entry.path, entry]));
    if (paths) {
      for (const path of paths) {
        const entry = wanted.get(path);
        if (!entry) {
          this.files.delete(path);
          this.index.delete(path);
          continue;
        }
        this.files.set(path, this.objects.text(entry.hash));
        this.index.set(path, { mode: entry.mode, hash: entry.hash, stage: 0 });
      }
      return;
    }
    // `from` is the commit being left behind. A path that is identical on both
    // sides keeps its local edits, the way Git carries them across a switch;
    // only paths the checkout really changes get rewritten.
    const previous = from ? new Map(this.listTree(from).map((entry) => [entry.path, entry])) : null;
    for (const [path, entry] of wanted) {
      if (keeping.has(path)) continue;
      const was = previous?.get(path) ?? null;
      if (was && was.hash === entry.hash && this.files.has(path) && this.files.get(path) !== this.objects.text(was.hash)) continue;
      this.files.set(path, this.objects.text(entry.hash));
      this.index.set(path, { mode: entry.mode, hash: entry.hash, stage: 0 });
    }
    for (const path of [...this.files.keys()]) {
      if (!wanted.has(path) && this.index.has(path)) this.files.delete(path);
    }
    for (const path of [...this.index.keys()]) {
      if (!wanted.has(path)) this.index.delete(path);
    }
  }

  // ---- stash ------------------------------------------------------------

  stashEntries() {
    return this.common.reflog('refs/stash').map((entry, index) => ({
      index,
      hash: entry.new,
      message: entry.message.replace(/^stash@{\d+}: /, ''),
    }));
  }

  // ---- history ----------------------------------------------------------

  allRefHashes({ all = false, reflog = false } = {}) {
    const hashes = new Set();
    const names = all
      ? [...this.refs.keys(), 'HEAD']
      : [...this.refs.keys()].filter((name) => !name.startsWith('refs/stash'));
    for (const name of names) {
      const hash = this.resolveRef(name);
      if (hash) this.collect(hash, hashes);
    }
    if (reflog) {
      for (const ref of this.common.reflogs.keys()) {
        for (const entry of this.reflog(ref)) if (entry.new) this.collect(entry.new, hashes);
      }
    }
    return hashes;
  }

  collect(hash, set) {
    let current = hash;
    const seen = new Set();
    while (current && !set.has(current) && !seen.has(current)) {
      seen.add(current);
      const object = this.objects.get(current);
      if (!object) return;
      if (object.type === 'tag') {
        current = parseTag(current, this.objects).object;
        continue;
      }
      if (object.type !== 'commit') return;
      set.add(current);
      for (const parent of parseCommit(current, this.objects).parents) this.collect(parent, set);
      current = null;
    }
  }

  ancestorsOf(hash) {
    const set = new Set();
    this.collect(hash, set);
    return set;
  }

  /** Newest first, the default order of `git log`. */
  order(hashes) {
    return [...hashes]
      .map((hash) => ({ hash, commit: parseCommit(hash, this.objects) }))
      .filter((item) => item.commit)
      .sort((a, b) => b.commit.committer.timestamp - a.commit.committer.timestamp || compareHash(a.hash, b.hash))
      .map((item) => item.hash);
  }

  mergeBase(a, b) {
    if (!a) return b;
    if (!b) return a;
    const fromA = this.ancestorsOf(a);
    const candidates = [...this.ancestorsOf(b)].filter((hash) => fromA.has(hash));
    if (!candidates.length) return null;
    const parentsOfCandidates = new Set();
    for (const hash of candidates) {
      for (const parent of parseCommit(hash, this.objects).parents) {
        if (candidates.includes(parent)) parentsOfCandidates.add(parent);
      }
    }
    const maximal = candidates.filter((hash) => !parentsOfCandidates.has(hash));
    if (maximal.length === 1) return maximal[0];
    return this.order(new Set(maximal))[0] ?? null;
  }

  /** Commits reachable from `from` but not from any of `exclude`, oldest first. */
  uniqueCommits(from, exclude) {
    const excluded = new Set();
    for (const stop of exclude) this.collect(stop, excluded);
    const set = new Set();
    this.collect(from, set);
    const mine = [...set].filter((hash) => !excluded.has(hash));
    return this.orderTopological(mine);
  }

  orderTopological(hashes) {
    const list = new Set(hashes);
    const result = [];
    const seen = new Set();
    const visit = (hash) => {
      if (seen.has(hash) || !list.has(hash)) return;
      seen.add(hash);
      for (const parent of parseCommit(hash, this.objects).parents) visit(parent);
      result.push(hash);
    };
    for (const hash of this.order(list)) visit(hash);
    return result;
  }

  // ---- files ------------------------------------------------------------

  writeFile(path, content) {
    this.files.set(normalizePath(path), content);
  }

  readFile(path) {
    return this.files.get(normalizePath(path)) ?? null;
  }

  removeFile(path) {
    this.files.delete(normalizePath(path));
  }

  listFiles() {
    return [...this.files.keys()].sort(compareText);
  }

  isIgnored(path) {
    return this.common.ignore.some((pattern) => pattern.matches(path));
  }

  serialize() {
    return {
      dir: this.dir,
      headRef: this.headRef,
      headCommit: this.headCommit,
      index: [...this.index],
      files: [...this.files],
      mergeState: this.mergeState,
      rebaseState: this.rebaseState,
    };
  }

  static restore(state, common) {
    const repo = new Repo({ common, dir: state.dir, headRef: state.headRef, headCommit: state.headCommit });
    repo.index = new Map(state.index);
    repo.files = new Map(state.files);
    repo.mergeState = state.mergeState;
    repo.rebaseState = state.rebaseState;
    return repo;
  }
}

function compareHash(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizePath(path) {
  return String(path)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

export function subjectOf(message) {
  return splitLines(message)[0] ?? '';
}

export function parseGitIgnore(text) {
  return splitLines(text)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(toPattern);
}

/** Translate a .gitignore line into a matcher over repository-relative paths. */
function toPattern(line) {
  const negated = line.startsWith('!');
  const text = negated ? line.slice(1) : line;
  const anchored = text.startsWith('/') || text.includes('/', text.startsWith('/') ? 1 : 0);
  const bare = text.replace(/^\//, '').replace(/\/$/, '');
  const dirOnly = text.endsWith('/');
  const parts = bare.split('/').filter(Boolean);
  const regex = new RegExp(
    `^${(anchored ? '' : '(?:.*/)?') + parts.map((p) => wildcardToRegex(p)).join('/')}${dirOnly ? '/.*' : '(?:/.*)?$'}`,
  );
  return { line, negated, matches: (path) => regex.test(path) };
}

function wildcardToRegex(pattern) {
  return pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
}
