/**
 * stdout 对拍：同一串命令分别交给真 git 和模拟器，逐字节比较 stdout / stderr / 退出码。
 *
 * 网页里的终端像真终端一样默认显示引用装饰（(HEAD -> main)），而管道里的真 git 不会，
 * 所以涉及 log 的命令一律显式带 --decorate 再比。
 * 用法：node tests/stdout-oracle.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git, resetRemotes, tokenize } from '../src/engine/commands.js';

const IDENT = { name: 'Git Learner', email: 'learner@example.com' };
const TZ = '+0800';
const BASE = 1_700_000_000;
const OPTS = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'log.decorate=false'];

const clock = { step: 0 };
function nextDate() {
  const author = BASE + clock.step * 60;
  clock.step += 1;
  return { author, committer: author + 1 };
}

function real(dir, args, { date = null } = {}) {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: IDENT.name,
    GIT_AUTHOR_EMAIL: IDENT.email,
    GIT_COMMITTER_NAME: IDENT.name,
    GIT_COMMITTER_EMAIL: IDENT.email,
    HOME: dir,
  };
  if (date) {
    env.GIT_AUTHOR_DATE = `${date.author} ${TZ}`;
    env.GIT_COMMITTER_DATE = `${date.committer} ${TZ}`;
  }
  // execFileSync only captures stdout; spawnSync gets both streams.
  const run = spawnSync('git', [...OPTS, ...args], { cwd: dir, env, encoding: 'utf8' });
  return { code: run.status ?? 1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

const big = (prefix, count) => {
  let text = '';
  for (let i = 0; i < count; i++) text += `${prefix}${i}\n`;
  return text;
};

/** [命令, 是否提交（需要固定时间戳）] */
const SCRIPT = [
  ['printf "a\\nb\\n" > f.txt', false],
  ['printf "x\\n" > s.txt', false],
  ['git add .', false],
  ['git commit -m "feat: first"', true],
  ['printf "a\\nB\\nc\\n" > f.txt', false],
  ['git add f.txt', false],
  ['git commit -m "feat: second"', true],
  ['printf "new\\n" > n.txt', false],
  ['git add n.txt', false],
  ['git commit -m "feat: third"', true],
  ['git log --oneline --decorate', false],
  ['git log --graph --oneline --all --decorate', false],
  ['git log --oneline --decorate', false],
  ['git status -s', false],
  ['git ls-files', false],
  ['git rev-parse HEAD', false],
  ['git show --decorate HEAD', false],
  ['git tag v1', false],
  ['git tag', false],
  ['git branch', false],
  // 大文件：diffstat 的加减条要按 80 列缩放
  [`printf "${big('line', 100)}" > big.txt`, false],
  ['git add big.txt', false],
  ['git commit -m "feat: big"', true],
  [`printf "${big('CHANGED', 100)}" > big.txt`, false],
  ['git diff --stat', false],
  ['git diff --numstat', false],
  ['git diff --shortstat', false],
  ['git diff', false],
  // 冲突与 Stage
  ['git checkout -b other', false],
  ['printf "a\\nX\\nc\\n" > f.txt', false],
  ['git commit -am other', true],
  ['git switch main', false],
  ['printf "a\\nY\\nc\\n" > f.txt', false],
  ['git commit -am ours', true],
  ['git merge other', false],
  ['git status -s', false],
  ['git show :2:f.txt', false],
  ['git show :3:f.txt', false],
  ['git diff --cached', false],
  ['git restore --source=:2 f.txt', false],
  ['cat f.txt', false],
  ['git checkout --theirs f.txt', false],
  ['cat f.txt', false],
  ['git restore --ours f.txt', false],
  ['cat f.txt', false],
  ['git status -s', false],
  ['git log --oneline --decorate', false],
  ['git commit -m "resolve"', true],
  ['git log --oneline --decorate', false],
];

const dir = mkdtempSync(join(tmpdir(), 'stdout-oracle-'));
const git = new Git();
resetRemotes();
let bad = 0;

const report = (line, field, theirs, ours) => {
  bad += 1;
  console.log(`\n✗ ${line}（${field}）`);
  console.log(`    真 git  ${JSON.stringify(theirs)}`);
  console.log(`    模拟器  ${JSON.stringify(ours)}`);
};

try {
  real(dir, ['init', '-q', '-b', 'main', '.']);
  git.run('git init -b main');
  for (const [line, isCommit] of SCRIPT) {
    const date = isCommit ? nextDate() : null;
    if (date) {
      git.repo.authorTime = date.author;
      git.repo.commitTime = date.committer;
    }
    const tokens = tokenize(line);
    let theirs;
    if (tokens[0] === 'printf') {
      const open = line.indexOf('"');
      const close = line.lastIndexOf('" > ');
      const content = line.slice(open + 1, close).replace(/\\n/g, '\n');
      const path = line.slice(close + 4);
      writeFileSync(join(dir, path), content);
      git.repo.writeFile(path, content);
      continue;
    }
    if (tokens[0] === 'cat') {
      try {
        theirs = { code: 0, stdout: readFileSync(join(dir, tokens[1]), 'utf8'), stderr: '' };
      } catch {
        theirs = { code: 1, stdout: '', stderr: `cat: ${tokens[1]}: No such file or directory\n` };
      }
    } else {
      theirs = real(dir, tokens.slice(1), { date });
    }
    const ours = git.run(line);
    if (ours.code !== theirs.code) report(line, '退出码', theirs.code, ours.code);
    if (ours.stdout !== theirs.stdout) report(line, 'stdout', theirs.stdout, ours.stdout);
    if (ours.stderr !== theirs.stderr) report(line, 'stderr', theirs.stderr, ours.stderr);
  }
  console.log(bad ? `\n✗ ${bad} 处不一致` : '\n✓ 全部一致');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
