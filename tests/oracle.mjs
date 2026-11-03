/**
 * 对拍：把同一串命令分别交给真 git 和本模拟器，比较它们产生的对象。
 *
 * 这不是单元测试，而是一份证据：模拟器写的 blob / tree / commit 与真 git
 * 逐字节一致（同样的 SHA-1、同样的树排序、同样的提交头），所以网页上看到的
 * 哈希就是你在终端里会看到的哈希。
 *
 * 运行：npm run oracle
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Git, tokenize } from '../src/engine/commands.js';

const IDENT = { name: 'Git Learner', email: 'learner@example.com' };
const TZ = '+0800';
const BASE = 1_700_000_000;

/** 每一步：要么写文件，要么跑一条 git 命令（两边都跑）。 */
const SCRIPT = [
  { write: ['hello.c', 'hello\n'] },
  { run: 'git add hello.c' },
  { run: 'git commit -m "feat: hello"' },
  { write: ['src/main.c', 'int main(void) { return 0; }\n'] },
  { run: 'git add src/main.c' },
  { run: 'git commit -m "feat: main"' },
  { write: ['hello.c', 'hello\nworld\n'] },
  { run: 'git add hello.c' },
  { run: 'git commit -m "feat: world"' },
  { run: 'git tag v1' },
  { run: 'git branch topic' },
  { run: 'git switch topic' },
  { write: ['hello.c', 'hello\nworld\ntopic\n'] },
  { run: 'git add hello.c' },
  { run: 'git commit -m "topic"' },
  { run: 'git switch main' },
  { run: 'git merge topic' },
  { run: 'git switch -c side main~1' },
  { write: ['side.txt', 'side\n'] },
  { run: 'git add side.txt' },
  { run: 'git commit -m "side"' },
  { run: 'git switch main' },
  { run: 'git merge -m "merge side" side' },
];

const GIT_OPTS = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];

function realGit(dir, args, { date = null } = {}) {
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
  return execFileSync('git', [...GIT_OPTS, ...args], { cwd: dir, env, encoding: 'utf8' });
}

/** 每次提交用一个固定时间戳，保证两边的提交对象字节一致。 */
const clock = { step: 0 };
function nextDate() {
  const author = BASE + clock.step * 60;
  clock.step += 1;
  return { author, committer: author + 1 };
}

function compare(label, ours, theirs) {
  if (String(ours).trim() === String(theirs).trim()) return true;
  console.error(`\n✗ ${label} 不一致`);
  const ourLines = ours.split('\n');
  const theirLines = theirs.split('\n');
  for (let i = 0; i < Math.max(ourLines.length, theirLines.length); i++) {
    if (ourLines[i] !== theirLines[i]) {
      console.error(`    真 git : ${theirLines[i]}`);
      console.error(`    模拟器 : ${ourLines[i]}`);
    }
  }
  return false;
}

function objectList(dir) {
  return realGit(dir, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'])
    .split('\n')
    .filter(Boolean)
    .sort()
    .join('\n');
}

function objectListOurs(git) {
  return git.repo.objects
    .list()
    .map((object) => `${object.hash} ${object.type}`)
    .sort()
    .join('\n');
}

function treeListing(dir) {
  return realGit(dir, ['ls-tree', '-r', 'HEAD']).trim();
}

function treeListingOurs(git) {
  // 不排序：git 按树对象的顺序输出，模拟器的 listTree 也是同一个顺序
  return git.repo
    .listTree(git.repo.headHash())
    .map((entry) => `${entry.mode} ${entry.mode === '40000' ? 'tree' : 'blob'} ${entry.hash}\t${entry.path}`)
    .join('\n');
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'git-oracle-'));
  const git = new Git();
  let ok = true;

  try {
    realGit(dir, ['init', '-q', '-b', 'main', '.']);
    git.run('git init -b main');

    for (const step of SCRIPT) {
      if (step.write) {
        const [path, content] = step.write;
        const target = join(dir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
        git.repo.writeFile(path, content);
        continue;
      }
      const date = /commit|merge|tag/.test(step.run) ? nextDate() : null;
      if (date) {
        // 让模拟器用和真 git 相同的作者/提交时间，提交对象才能逐字节相同
        git.repo.authorTime = date.author;
        git.repo.commitTime = date.committer;
      }
      realGit(dir, tokenize(step.run).slice(1), { date });
      const ours = git.run(step.run);
      if (ours.code !== 0) {
        console.error(`\n✗ 模拟器执行 \`${step.run}\` 失败：${ours.stderr || ours.stdout}`);
        ok = false;
        break;
      }
      // 每条会写对象的命令之后都对拍一次
      if (/commit|merge/.test(step.run)) {
        ok = compare(`${step.run} → HEAD`, git.repo.headHash(), realGit(dir, ['rev-parse', 'HEAD']).trim()) && ok;
        ok = compare(`${step.run} → tree`, git.treeOf('HEAD'), realGit(dir, ['rev-parse', 'HEAD^{tree}']).trim()) && ok;
      }
    }

    if (ok) {
      ok = compare('对象库（全部 blob/tree/commit）', objectListOurs(git), objectList(dir)) && ok;
      ok = compare('工作区快照 ls-tree -r HEAD', treeListingOurs(git), treeListing(dir)) && ok;
      ok = compare('git status --short', git.run('git status --short').stdout, realGit(dir, ['status', '--short']).replace(/\r/g, '')) && ok;
      ok = compare('git ls-files', git.run('git ls-files').stdout, realGit(dir, ['ls-files']).replace(/\r/g, '')) && ok;
    }

    console.log(ok ? '\n✓ 模拟器与真 git 的对象完全一致' : '\n✗ 存在差异，见上');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

main();
