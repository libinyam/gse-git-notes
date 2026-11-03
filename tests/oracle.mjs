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

/** realGit, but a failing command returns instead of throwing. */
function realGitAttempt(dir, args, options = {}) {
  try {
    return { code: 0, stdout: realGit(dir, args, options), stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/**
 * diff 对拍：同一串编辑分别交给两边，`git diff` 的输出必须逐行相同。
 * 重点看 hunk 头的起始行号——纯新增、纯删除、增删混合三种都要和真 git 一致。
 */
const DIFF_EDITS = [
  ['改第一行', 'a\nb\nc\n', 'A\nb\nc\n'],
  ['删掉第一行', 'a\nb\nc\n', 'b\nc\n'],
  ['末尾追加', 'a\nb\nc\n', 'a\nb\nc\nd\n'],
  ['中间插入', 'a\nb\nc\n', 'a\nX\nb\nc\n'],
  ['改第一行并删第三行', 'a\nb\nc\n', 'A\nb\n'],
  ['插入空行', 'a\nb\nc\n', 'a\n\nb\nc\n'],
  ['整个文件重写', 'a\nb\nc\n', 'x\ny\nz\nw\n'],
];

const DIFF_PROBES = [
  ['diff'],
  ['diff', '--cached'],
  ['diff', 'HEAD'],
  ['diff', '--name-only'],
  ['diff', '--name-status'],
  ['diff', '--stat'],
  ['diff', 'f.txt'],
  ['diff', '--', 'f.txt'],
];

function compareDiff(dir, git) {
  let ok = true;

  // 1. 还没有任何提交：--cached 把 HEAD 当空目录，显式写 HEAD 则报错
  const unborn = mkdtempSync(join(tmpdir(), 'git-oracle-unborn-'));
  const fresh = new Git();
  try {
    realGit(unborn, ['init', '-q', '-b', 'main', '.']);
    fresh.run('git init -b main');
    writeFileSync(join(unborn, 'hello.c'), 'v1\n');
    fresh.repo.writeFile('hello.c', 'v1\n');
    realGit(unborn, ['add', 'hello.c']);
    fresh.run('git add hello.c');
    ok = compare('未提交时 git diff --cached', fresh.run('git diff --cached').stdout, realGit(unborn, ['diff', '--cached']).replace(/\r/g, '')) && ok;
    for (const args of [['diff', 'HEAD'], ['diff', '@'], ['diff', '--cached', 'HEAD'], ['diff', 'nope']]) {
      const ours = fresh.run(`git ${args.join(' ')}`);
      const theirs = realGitAttempt(unborn, args);
      ok = compare(`未提交时 git ${args.join(' ')}（退出码）`, ours.code, theirs.code) && ok;
      // 真 git 在 fatal 之后还附了两行 "Use '--' ..." 提示，模拟器只打第一行
      ok = compare(`未提交时 git ${args.join(' ')}（报错）`, ours.stderr, theirs.stderr.split('\n')[0]) && ok;
    }
  } finally {
    rmSync(unborn, { recursive: true, force: true });
  }

  // 2. 有提交之后，逐个编辑对拍各种 diff 写法
  for (const [name, , after] of DIFF_EDITS) {
    writeFileSync(join(dir, 'f.txt'), after);
    git.repo.writeFile('f.txt', after);
    for (const args of DIFF_PROBES) {
      const label = `${name}：git ${args.join(' ')}`;
      const ours = git.run(`git ${args.join(' ')}`);
      const theirs = realGit(dir, args);
      if (ours.code !== 0) {
        console.error(`\n✗ ${label} 模拟器执行失败：${ours.stderr}`);
        ok = false;
        continue;
      }
      ok = compare(label, ours.stdout, theirs.replace(/\r/g, '')) && ok;
    }
    // 收尾：add + commit，让下一个编辑从干净的 HEAD 出发
    realGit(dir, ['add', 'f.txt']);
    git.run('git add f.txt');
    const date = nextDate();
    git.repo.authorTime = date.author;
    git.repo.commitTime = date.committer;
    realGit(dir, ['commit', '-q', '-m', `edit: ${name}`], { date });
    git.run(`git commit -m "edit: ${name}"`);
  }

  // 3. 两个提交之间的 diff
  ok = compare('git diff HEAD~1 HEAD', git.run('git diff HEAD~1 HEAD').stdout, realGit(dir, ['diff', 'HEAD~1', 'HEAD']).replace(/\r/g, '')) && ok;
  ok = compare('git diff HEAD~1', git.run('git diff HEAD~1').stdout, realGit(dir, ['diff', 'HEAD~1']).replace(/\r/g, '')) && ok;

  // 4. 合并冲突：组合 diff（diff --cc）、`* Unmerged path`、以及冲突中的各种写法
  const conflict = mkdtempSync(join(tmpdir(), 'git-oracle-conflict-'));
  const merged = new Git();
  const step = (repo, args) => {
    const date = nextDate();
    repo.authorTime = date.author;
    repo.commitTime = date.committer;
    // 冲突的 merge 两边都以 1 退出，所以这里比退出码而不是假设成功
    const real = realGitAttempt(conflict, args, { date });
    const ours = repo.run(`git ${args.join(' ')}`);
    if (ours.code !== real.code) {
      console.error(`\n✗ 冲突场景 \`git ${args.join(' ')}\` 退出码不同：真 git ${real.code}，模拟器 ${ours.code}`);      ok = false;
    }
  };  try {
    realGit(conflict, ['init', '-q', '-b', 'main', '.']);
    merged.run('git init -b main');
    writeFileSync(join(conflict, 'f.txt'), 'a\nb\nc\n');
    merged.repo.writeFile('f.txt', 'a\nb\nc\n');
    realGit(conflict, ['add', '.']);
    merged.run('git add .');
    step(merged, ['commit', '-q', '-m', 'base']);
    step(merged, ['checkout', '-q', '-b', 'other']);
    writeFileSync(join(conflict, 'f.txt'), 'a\nX\nc\n');
    merged.repo.writeFile('f.txt', 'a\nX\nc\n');
    step(merged, ['commit', '-q', '-am', 'other']);
    step(merged, ['checkout', '-q', 'main']);
    writeFileSync(join(conflict, 'f.txt'), 'a\nY\nc\n');
    merged.repo.writeFile('f.txt', 'a\nY\nc\n');
    step(merged, ['commit', '-q', '-am', 'ours']);
    step(merged, ['merge', 'other']);
    for (const args of [['diff'], ['diff', 'HEAD'], ['diff', '--cached'], ['diff', '--stat'], ['diff', '--shortstat'], ['diff', '--numstat'], ['diff', '--name-only'], ['diff', '--name-status']]) {
      const label = `冲突中：git ${args.join(' ')}`;
      ok = compare(label, merged.run(`git ${args.join(' ')}`).stdout, realGit(conflict, args).replace(/\r/g, '')) && ok;
    }
    // 工作区被改成和某一 Stage 相同：Git 仍然列出文件，但没有任何 hunk
    for (const [label, content] of [['工作区==ours', 'a\nY\nc\n'], ['工作区==theirs', 'a\nX\nc\n'], ['工作区删掉文件', null]]) {
      if (content === null) {
        rmSync(join(conflict, 'f.txt'));
        merged.repo.files.delete('f.txt');
      } else {
        writeFileSync(join(conflict, 'f.txt'), content);
        merged.repo.writeFile('f.txt', content);
      }
      for (const args of [['diff'], ['diff', '--stat'], ['diff', '--name-status']]) {
        const name = `${label}：git ${args.join(' ')}`;
        ok = compare(name, merged.run(`git ${args.join(' ')}`).stdout, realGit(conflict, args).replace(/\r/g, '')) && ok;
      }
    }
  } finally {
    rmSync(conflict, { recursive: true, force: true });
  }
  return ok;
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
      ok = compareDiff(dir, git) && ok;
    }

    console.log(ok ? '\n✓ 模拟器与真 git 的对象完全一致' : '\n✗ 存在差异，见上');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

main();
