import { sha1Hex } from './sha1.js';
import { toBytes, concat, hexToBytes, bytesToHex } from './bytes.js';

/** An error Git itself would print: `message` on stderr, optional stdout lines. */
export class GitError extends Error {
  constructor(message, { stdout = '', exitCode = 128 } = {}) {
    super(message);
    this.stdout = stdout;
    this.exitCode = exitCode;
  }
}

function header(type, length) {
  return toBytes(`${type} ${length}\0`);
}

/**
 * Content-addressed object database: the name of an object is the SHA-1 of
 * "type length\0" followed by its content, exactly like `.git/objects`.
 */
export class ObjectStore {
  constructor() {
    this.objects = new Map();
  }

  has(hash) {
    return this.objects.has(hash);
  }

  get(hash) {
    const object = this.objects.get(hash);
    if (!object) throw new GitError(`fatal: not a valid object name ${hash}`);
    return object;
  }

  /** Store bytes under a type and return the id Git would print. */
  write(type, content) {
    const bytes = toBytes(content);
    const hash = sha1Hex(concat(header(type, bytes.length), bytes));
    const existing = this.objects.get(hash);
    if (!existing) this.objects.set(hash, { hash, type, bytes, size: bytes.length });
    return hash;
  }

  /** Store an already serialized object whose type/length header is implicit. */
  writeRaw(type, body) {
    return this.write(type, body);
  }

  /**
   * The id Git would give this content, without storing anything. `git status`
   * and `git diff` hash working tree contents but never write objects, so the
   * simulator must not either.
   */
  hashOnly(type, content) {
    const bytes = toBytes(content);
    return sha1Hex(concat(header(type, bytes.length), bytes));
  }

  text(hash) {
    const object = this.get(hash);
    return new TextDecoder('utf-8').decode(object.bytes);
  }

  list() {
    return [...this.objects.values()];
  }

  reachable(hashes) {
    const seen = new Set();
    const walk = (hash) => {
      if (!hash || seen.has(hash) || !this.objects.has(hash)) return;
      seen.add(hash);
      const object = this.objects.get(hash);
      if (object.type === 'tree') {
        for (const entry of parseTree(hash).entries) {
          if (entry.mode === '40000' || entry.mode === '160000') walk(entry.hash);
        }
      } else if (object.type === 'commit') {
        const commit = parseCommit(hash);
        walk(commit.tree);
        for (const parent of commit.parents) walk(parent);
      } else if (object.type === 'tag') {
        walk(parseTag(hash).object);
      }
    };
    for (const hash of hashes) walk(hash);
    return seen;
  }

  serialize() {
    return [...this.objects.entries()].map(([hash, object]) => ({
      hash,
      type: object.type,
      bytes: bytesToHex(object.bytes),
    }));
  }

  static restore(records) {
    const store = new ObjectStore();
    for (const record of records) {
      const bytes = hexToBytes(record.bytes);
      store.objects.set(record.hash, { hash: record.hash, type: record.type, bytes, size: bytes.length });
    }
    return store;
  }
}

export function treeEntryBytes(entry) {
  const mode = entry.mode === '100000' ? '100644' : entry.mode;
  return concat(toBytes(`${mode} ${entry.name}\0`), hexToBytes(entry.hash));
}

/** Git orders tree entries by name, treating subtrees as "name/". */
export function sortTreeEntries(entries) {
  const key = (entry) => (entry.mode === '40000' ? `${entry.name}/` : entry.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function buildTree(store, entries) {
  const sorted = sortTreeEntries(entries);
  const body = concat(...sorted.map(treeEntryBytes));
  const hash = store.write('tree', body);
  return { hash, entries: sorted };
}

export function parseTree(hash, store) {
  const bytes = store.get(hash).bytes;
  const entries = [];
  let start = 0;
  while (start < bytes.length) {
    const nul = bytes.indexOf(0, start);
    if (nul < 0) throw new GitError(`fatal: bad tree object ${hash}`);
    const head = new TextDecoder().decode(bytes.subarray(start, nul));
    const space = head.indexOf(' ');
    const mode = head.slice(0, space);
    const name = head.slice(space + 1);
    entries.push({ mode, name, hash: bytesToHex(bytes.subarray(nul + 1, nul + 21)) });
    start = nul + 21;
  }
  return { hash, entries };
}

export function formatIdent(ident) {
  return `${ident.name} <${ident.email}> ${ident.timestamp} ${ident.tz}`;
}

export function buildCommit(store, { tree, parents, author, committer, message, gpgsig }) {
  let body = `tree ${tree}\n`;
  for (const parent of parents) body += `parent ${parent}\n`;
  body += `author ${formatIdent(author)}\n`;
  body += `committer ${formatIdent(committer)}\n`;
  if (gpgsig) body += `gpgsig ${gpgsig.split('\n').join('\n ')}\n`;
  body += `\n${message}`;
  return store.write('commit', toBytes(body));
}

export function parseCommit(hash, store) {
  const text = store.text(hash);
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const fields = { tree: null, parents: [], author: null, committer: null };
  const pending = [];
  for (const line of headerText.split('\n')) {
    if (/^[ \t]/.test(line) && pending.length) {
      pending[pending.length - 1][1] += '\n' + line.slice(1);
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    pending.push([key, space < 0 ? '' : line.slice(space + 1)]);
  }
  for (const [key, value] of pending) {
    if (key === 'tree') fields.tree = value;
    else if (key === 'parent') fields.parents.push(value);
    else if (key === 'author' || key === 'committer') fields[key] = parseIdent(value);
    else fields[key] = value;
  }
  return { hash, ...fields, message };
}

export function parseIdent(text) {
  const match = /^(.*?) <(.*?)> (-?\d+) ([+-]\d{4})$/.exec(text);
  if (!match) return { name: text, email: '', timestamp: 0, tz: '+0000', raw: text };
  return { name: match[1], email: match[2], timestamp: Number(match[3]), tz: match[4], raw: text };
}

export function buildTag(store, { object, type, tag, tagger, message }) {
  let body = `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${formatIdent(tagger)}\n\n${message}`;
  return store.write('tag', toBytes(body));
}

export function parseTag(hash, store) {
  const text = store.text(hash);
  const split = text.indexOf('\n\n');
  const fields = {};
  for (const line of text.slice(0, split).split('\n')) {
    const space = line.indexOf(' ');
    fields[line.slice(0, space)] = line.slice(space + 1);
  }
  return { hash, object: fields.object, type: fields.type, tag: fields.tag, tagger: parseIdent(fields.tagger || ''), message: text.slice(split + 2) };
}

export function catFileType(store, hash) {
  const object = store.get(hash);
  if (object.type === 'commit') {
    const commit = parseCommit(hash, store);
    return `${commit.tree} ${commit.parents.length ? `parent ${commit.parents.join(' parent ')}` : ''}`.trim();
  }
  return '';
}
