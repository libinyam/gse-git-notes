import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Git, resetRemotes } from '../src/engine/commands.js';

/** A fresh repository with one commit on main. */
function lab() {
  resetRemotes();
  const git = new Git();
  git.run('git init -b main');
  return git;
}

/**
 * Run a command that must succeed. Git writes progress notes ("Switched to
 * branch ...") to stderr, so only real error lines count as failure here.
 */
function ok(git, line) {
  const result = git.run(line);
  const errors = String(result.stderr).split('\n').filter((text) => /^(fatal|error):/.test(text));
  assert.deepEqual(errors, [], `unexpected error for \`${line}\`:\n${result.stderr}`);
  assert.equal(result.code, 0, `unexpected exit code for \`${line}\`:\n${result.stdout}`);
  return result.stdout;
}

const objectCount = (git) => git.repo.objects.list().length;

test('内容寻址：哈希就是“类型头 + 内容”的 SHA-1', () => {
  const git = lab();
  assert.equal(ok(git, 'echo hello | git hash-object --stdin'), 'ce013625030ba8dba906f756967f9e9ca394464a\n');
});

test('jyy 的题：add 之后又改，提交进去的是 add 时的版本', () => {
  const git = lab();
  ok(git, 'echo v1 > hello.c');
  ok(git, 'git add hello.c');
  assert.equal(objectCount(git), 1, 'add 的那一刻 blob 已经写进对象库');
  ok(git, 'echo v2 > hello.c');
  assert.equal(objectCount(git), 1, '改工作区不会产生新对象');
  ok(git, 'git commit -m "feat: add hello"');
  assert.equal(ok(git, 'git show HEAD:hello.c'), 'v1\n');
  assert.equal(ok(git, 'cat hello.c'), 'v2\n');
  assert.match(ok(git, 'git status --short'), /^ M hello\.c$/m);
  assert.match(ok(git, 'git diff'), /^-v1$/m);
  assert.match(ok(git, 'git diff'), /^\+v2$/m);
  assert.equal(ok(git, 'git diff --cached'), '');
});

test('只读命令不写对象', () => {
  const git = lab();
  ok(git, 'echo v1 > hello.c');
  ok(git, 'git add hello.c');
  ok(git, 'git commit -m "feat: add hello"');
  ok(git, 'echo v2 > hello.c');
  const before = objectCount(git);
  ok(git, 'git status');
  ok(git, 'git status -s');
  ok(git, 'git diff');
  ok(git, 'git log --oneline');
  ok(git, 'git log --graph --all');
  ok(git, 'git ls-files -s');
  ok(git, 'git cat-file -p HEAD');
  assert.equal(objectCount(git), before);
});

test('init 之后 HEAD 指向还不存在的分支', () => {
  const git = new Git();
  ok(git, 'git init -b main');
  assert.equal(git.repo.headRef, 'refs/heads/main');
  assert.equal(git.repo.headHash(), null);
  assert.match(ok(git, 'git status'), /No commits yet/);
});

test('还没有提交时 git diff --cached 把 HEAD 当空目录', () => {
  const git = new Git();
  ok(git, 'git init -b main');
  ok(git, 'echo v1 > hello.c');
  ok(git, 'git add hello.c');
  // 真 git 在这里输出 new file，而不是报错
  const staged = ok(git, 'git diff --cached');
  assert.match(staged, /^new file mode 100644$/m);
  assert.match(staged, /^index 0000000\.\.626799f$/m);
  assert.match(staged, /^@@ -0,0 \+1 @@$/m);
  assert.match(staged, /^\+v1$/m);
  assert.match(ok(git, 'git diff --staged'), /^new file mode 100644$/m);
  // 不带 --cached 仍然是工作区 vs 暂存区
  ok(git, 'echo v2 > hello.c');
  assert.match(ok(git, 'git diff'), /^-v1$/m);
  assert.match(ok(git, 'git diff'), /^\+v2$/m);
});

test('还没有提交时显式写出 HEAD 仍然报错', () => {
  const git = new Git();
  ok(git, 'git init -b main');
  ok(git, 'echo v1 > hello.c');
  ok(git, 'git add hello.c');
  const expected = [
    ['git diff HEAD', 'HEAD'],
    ['git diff @', '@'],
    ['git diff --cached HEAD', 'HEAD'],
    ['git diff HEAD hello.c', 'HEAD'],
    ['git diff nope', 'nope'],
  ];
  for (const [line, token] of expected) {
    const result = git.run(line);
    assert.equal(result.code, 128, `\`${line}\` 应该以 128 退出`);
    assert.equal(result.stderr, `fatal: ambiguous argument '${token}': unknown revision or path not in the working tree.\n`);
  }
});

test('hunk 头：起始行号按行数算，与真 git 一致', () => {
  const cases = [
    ['改第一行', 'a\nb\nc\n', 'A\nb\nc\n', '@@ -1,3 +1,3 @@'],
    ['删掉第一行', 'a\nb\nc\n', 'b\nc\n', '@@ -1,3 +1,2 @@'],
    ['末尾追加', 'a\nb\nc\n', 'a\nb\nc\nd\n', '@@ -1,3 +1,4 @@'],
    ['中间插入', 'a\nb\nc\n', 'a\nX\nb\nc\n', '@@ -1,3 +1,4 @@'],
    ['改第一行并删第三行', 'a\nb\nc\n', 'A\nb\n', '@@ -1,3 +1,2 @@'],
    ['只改一行', 'v1\n', 'v2\n', '@@ -1 +1 @@'],
  ];
  for (const [name, before, after, header] of cases) {
    const git = lab();
    ok(git, `printf '${before}' > f.txt`);
    ok(git, 'git add f.txt');
    ok(git, 'git commit -m base');
    ok(git, `printf '${after}' > f.txt`);
    const out = ok(git, 'git diff');
    assert.ok(out.includes(`\n${header}\n`), `${name}：期望 ${header}\n${out}`);
  }
});

test('未跟踪的文件不出现在任何 diff 里，只出现在 status 里', () => {
  const git = lab();
  ok(git, 'echo tracked > f.txt');
  ok(git, 'git add f.txt');
  ok(git, 'git commit -m base');
  ok(git, 'echo loose > u.txt');
  assert.equal(ok(git, 'git diff'), '');
  assert.equal(ok(git, 'git diff --cached'), '');
  assert.equal(ok(git, 'git diff HEAD'), '');
  assert.equal(ok(git, 'git diff --name-only'), '');
  assert.match(ok(git, 'git status --short'), /^\?\? u\.txt$/m);
  // add 之后就进了 diff
  ok(git, 'git add u.txt');
  assert.equal(ok(git, 'git diff --cached --name-only'), 'u.txt\n');
});

test('-- 之后是纯路径，认不出的路径不报错；不带 -- 就报错', () => {
  const git = lab();
  ok(git, 'echo a > keep.txt');
  ok(git, 'echo b > gone.txt');
  ok(git, 'git add .');
  ok(git, 'git commit -m one');
  ok(git, 'git rm gone.txt');
  ok(git, 'git commit -m two');
  // gone.txt 已经不在工作区和暂存区里，但仍然是两个提交之间的合法路径
  assert.match(ok(git, 'git diff HEAD~1 HEAD -- gone.txt'), /^deleted file mode 100644$/m);
  assert.equal(ok(git, 'git diff HEAD~1 HEAD -- missing.txt'), '');
  const result = git.run('git diff HEAD~1 gone.txt');
  assert.equal(result.code, 128);
  assert.equal(result.stderr, "fatal: ambiguous argument 'gone.txt': unknown revision or path not in the working tree.\n");
});

test('--name-only 与 --name-status', () => {
  const git = lab();
  ok(git, "printf 'a\\nb\\n' > f.txt");
  ok(git, 'git add f.txt');
  ok(git, 'git commit -m base');
  ok(git, "printf 'a\\nB\\n' > f.txt");
  ok(git, 'echo new > n.txt');
  ok(git, 'git add n.txt');
  assert.equal(ok(git, 'git diff --name-only'), 'f.txt\n');
  assert.equal(ok(git, 'git diff --cached --name-only'), 'n.txt\n');
  assert.equal(ok(git, 'git diff --name-status'), 'M\tf.txt\n');
  assert.equal(ok(git, 'git diff --cached --name-status'), 'A\tn.txt\n');
  assert.match(ok(git, 'git diff --stat'), /^ f\.txt \| 2 \+-$/m);
});

test('新文件与删除整个文件的 hunk 头', () => {
  const git = lab();
  ok(git, 'echo only > f.txt');
  ok(git, 'git add f.txt');
  assert.match(ok(git, 'git diff --cached'), /^@@ -0,0 \+1 @@$/m);
  ok(git, 'git commit -m base');
  ok(git, 'git rm f.txt');
  // git rm 同时动了暂存区，所以删除出现在 --cached 里，和真 git 一样
  assert.equal(ok(git, 'git diff'), '');
  assert.match(ok(git, 'git diff --cached'), /^deleted file mode 100644$/m);
  assert.match(ok(git, 'git diff --cached'), /^@@ -1 \+0,0 @@$/m);
});

test('分支、fast-forward 与合并提交', () => {
  const git = lab();
  ok(git, 'echo a > a.txt');
  ok(git, 'git add a.txt');
  ok(git, 'git commit -m "feat: a"');
  ok(git, 'git branch topic');
  ok(git, 'git switch topic');
  ok(git, 'echo b > b.txt');
  ok(git, 'git add b.txt');
  ok(git, 'git commit -m "feat: b"');
  ok(git, 'git switch main');
  assert.match(ok(git, 'git merge topic'), /^Fast-forward$/m);

  ok(git, 'git switch -c side main~1');
  ok(git, 'echo c > c.txt');
  ok(git, 'git add c.txt');
  ok(git, 'git commit -m "feat: c"');
  ok(git, 'git switch main');
  assert.match(ok(git, 'git merge side'), /Merge made by the 'ort' strategy\./);
  const merge = ok(git, 'git cat-file -p HEAD');
  assert.equal(merge.split('\n').filter((line) => line.startsWith('parent ')).length, 2, '合并提交有两个父提交');
  assert.match(ok(git, 'git log --graph --oneline --all'), /\|/);
});

test('冲突：标记写进工作区文件，status 报 both modified', () => {
  const git = lab();
  ok(git, 'printf "1 cup sugar\n2 eggs\n" > recipe.txt');
  ok(git, 'git add recipe.txt');
  ok(git, 'git commit -m "feat: recipe"');
  ok(git, 'git branch salty');
  ok(git, 'git branch sweet');
  ok(git, 'git switch salty');
  ok(git, 'printf "1 cup salt\n2 eggs\n" > recipe.txt');
  ok(git, 'git commit -am "salt"');
  ok(git, 'git switch sweet');
  ok(git, 'printf "2 cups sugar\n2 eggs\n" > recipe.txt');
  ok(git, 'git commit -am "sugar"');
  ok(git, 'git switch main');
  ok(git, 'git merge salty');

  const merged = git.run('git merge sweet');
  assert.equal(merged.code, 1);
  assert.match(merged.stdout, /CONFLICT \(content\): Merge conflict in recipe\.txt/);
  assert.match(ok(git, 'git status'), /both modified\s+recipe\.txt/);
  assert.match(ok(git, 'git status --short'), /^UU recipe\.txt$/m);
  const file = ok(git, 'cat recipe.txt');
  assert.match(file, /^<<<<<<< HEAD$/m);
  assert.match(file, /^=======$/m);
  assert.match(file, /^>>>>>>> sweet$/m);
  assert.match(file, /^1 cup salt$/m);
  assert.match(file, /^2 cups sugar$/m);

  assert.equal(git.run('git commit -m "too early"').code, 128, '冲突没解决不能提交');
  ok(git, 'printf "1 cup salt\n2 cups sugar\n2 eggs\n" > recipe.txt');
  ok(git, 'git add recipe.txt');
  assert.doesNotMatch(ok(git, 'git status --short'), /UU/);
  ok(git, 'git commit -m "merge sweet"');
  assert.equal(ok(git, 'cat recipe.txt'), '1 cup salt\n2 cups sugar\n2 eggs\n');
});

/** 一个正在冲突的仓库：ours 改成 salt，theirs 改成 sugar。 */
function conflicted() {
  const git = lab();
  ok(git, 'printf "1 cup sugar\n2 eggs\n" > recipe.txt');
  ok(git, 'git add recipe.txt');
  ok(git, 'git commit -m "feat: recipe"');
  ok(git, 'git branch salty');
  ok(git, 'git branch sweet');
  ok(git, 'git switch salty');
  ok(git, 'printf "1 cup salt\n2 eggs\n" > recipe.txt');
  ok(git, 'git commit -am "salt"');
  ok(git, 'git switch sweet');
  ok(git, 'printf "2 cups sugar\n2 eggs\n" > recipe.txt');
  ok(git, 'git commit -am "sugar"');
  ok(git, 'git switch main');
  ok(git, 'git merge salty');
  const merge = git.run('git merge sweet');
  assert.equal(merge.code, 1);
  return git;
}

test('冲突时 git diff 输出组合 diff（diff --cc）', () => {
  const git = conflicted();
  const out = ok(git, 'git diff');
  assert.match(out, /^diff --cc recipe\.txt$/m);
  assert.match(out, /^index [0-9a-f]{7},[0-9a-f]{7}\.\.0000000$/m);
  assert.match(out, /^--- a\/recipe\.txt$/m);
  assert.match(out, /^\+\+\+ b\/recipe\.txt$/m);
  assert.match(out, /^@@@ -\d+,\d+ -\d+,\d+ \+\d+,\d+ @@@$/m);
  // 一行一个前缀列：+ 是相对某个父提交新增，两个空格是两边都有
  assert.match(out, /^\+\+<<<<<<< HEAD$/m);
  assert.match(out, /^ \+1 cup salt$/m);
  assert.match(out, /^\+\+=======$/m);
  assert.match(out, /^\+ 2 cups sugar$/m);
  assert.match(out, /^\+\+>>>>>>> sweet$/m);
  // 上下文行两边都有，前缀是两个空格
  assert.match(out, /^ {2}2 eggs$/m);
  assert.doesNotMatch(out, /^diff --git /);
});

test('冲突时其他 diff 写法：--cached 报未合并，HEAD 是普通 diff', () => {
  const git = conflicted();
  assert.equal(ok(git, 'git diff --cached'), '* Unmerged path recipe.txt\n');
  assert.equal(ok(git, 'git diff --cached HEAD'), '* Unmerged path recipe.txt\n');
  // 和某个具体版本比是普通的两方 diff，不是组合 diff
  const head = ok(git, 'git diff HEAD');
  assert.match(head, /^diff --git a\/recipe\.txt b\/recipe\.txt$/m);
  assert.match(head, /^index [0-9a-f]{7}\.\.[0-9a-f]{7} 100644$/m);
  assert.match(head, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  assert.doesNotMatch(head, /^diff --cc /);
});

test('冲突时工作区等于某一 Stage：只列文件，没有 hunk', () => {
  const git = conflicted();
  ok(git, 'printf "1 cup salt\n2 eggs\n" > recipe.txt');   // 等于 ours
  const ours = ok(git, 'git diff');
  assert.match(ours, /^diff --cc recipe\.txt$/m);
  assert.doesNotMatch(ours, /^@@@/);
  assert.equal(ok(git, 'git diff --stat'), ' recipe.txt | Unmerged\n 0 files changed\n');
  assert.equal(ok(git, 'git diff --name-status'), 'U\trecipe.txt\n');
});

test('冲突时删掉工作区文件：deleted file mode 列出两个父提交的模式', () => {
  const git = conflicted();
  // 直接删磁盘上的文件（git rm 会把暂存区里的冲突项一起清掉）
  git.repo.files.delete('recipe.txt');
  const out = ok(git, 'git diff');
  assert.match(out, /^diff --cc recipe\.txt$/m);
  assert.match(out, /^deleted file mode 100644,100644$/m);
  assert.match(out, /^\+\+\+ \/dev\/null$/m);
  assert.doesNotMatch(out, /^@@@/);
  assert.equal(ok(git, 'git diff --stat'), ' recipe.txt | Unmerged\n recipe.txt | 2 --\n 1 file changed, 2 deletions(-)\n');
  assert.equal(ok(git, 'git diff --name-status'), 'U\trecipe.txt\nD\trecipe.txt\n');
});

test('冲突时的摘要模式：未合并那一行加上按 ours 量的常规改动', () => {
  const git = conflicted();
  assert.equal(ok(git, 'git diff --stat'), ' recipe.txt | Unmerged\n recipe.txt | 4 ++++\n 1 file changed, 4 insertions(+)\n');
  assert.equal(ok(git, 'git diff --shortstat'), ' 1 file changed, 4 insertions(+)\n');
  assert.equal(ok(git, 'git diff --numstat'), '0\t0\trecipe.txt\n4\t0\trecipe.txt\n');
  assert.equal(ok(git, 'git diff --name-only'), 'recipe.txt\nrecipe.txt\n');
  assert.equal(ok(git, 'git diff --name-status'), 'U\trecipe.txt\nM\trecipe.txt\n');
});

test('--numstat 与 --shortstat 的格式', () => {
  const git = lab();
  ok(git, "printf 'a\\nb\\n' > f.txt");
  ok(git, 'git add f.txt');
  ok(git, 'git commit -m base');
  ok(git, "printf 'a\\nB\\nc\\n' > f.txt");
  assert.equal(ok(git, 'git diff --numstat'), '2\t1\tf.txt\n');
  assert.equal(ok(git, 'git diff --shortstat'), ' 1 file changed, 2 insertions(+), 1 deletion(-)\n');
  // --stat 的名字列只按出现在 diff 里的文件对齐
  assert.equal(ok(git, 'git diff --stat'), ' f.txt | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)\n');
});

test('merge --abort 回到合并前', () => {
  const git = lab();
  ok(git, 'echo a > a.txt');
  ok(git, 'git add a.txt');
  ok(git, 'git commit -m "feat: a"');
  ok(git, 'git branch other');
  ok(git, 'git switch other');
  ok(git, 'printf "x\n" > a.txt');
  ok(git, 'git commit -am "other"');
  ok(git, 'git switch main');
  ok(git, 'printf "y\n" > a.txt');
  ok(git, 'git commit -am "main"');
  git.run('git merge other');
  ok(git, 'git merge --abort');
  assert.equal(ok(git, 'cat a.txt'), 'y\n');
  assert.equal(git.run('git merge --abort').stderr, 'fatal: There is no merge to abort\n');
});

test('rebase 重放提交：哈希变了，作者不变，旧提交还在', () => {
  const git = lab();
  ok(git, 'echo a > a.txt');
  ok(git, 'git add a.txt');
  ok(git, 'git commit -m "feat: a"');
  ok(git, 'git switch -c topic HEAD~0');
  ok(git, 'echo t > t.txt');
  ok(git, 'git add t.txt');
  ok(git, 'git commit -m "topic"');
  const original = ok(git, 'git rev-parse HEAD').trimEnd();
  const author = ok(git, 'git log -1 --pretty=%an');
  ok(git, 'git switch main');
  ok(git, 'echo m > m.txt');
  ok(git, 'git add m.txt');
  ok(git, 'git commit -m "feat: m"');
  ok(git, 'git switch topic');
  ok(git, 'git rebase main');
  const replayed = ok(git, 'git rev-parse HEAD');
  assert.notEqual(replayed, original, '父提交变了，哈希跟着变');
  assert.equal(ok(git, 'git log -1 --pretty=%an'), author, '作者信息保留');
  assert.equal(ok(git, 'git log --oneline'), [
    `${replayed.slice(0, 7)} (HEAD -> topic) topic`,
    `${ok(git, 'git rev-parse main').slice(0, 7)} (main) feat: m`,
    `${ok(git, 'git rev-parse main~1').slice(0, 7)} feat: a`,
  ].join('\n') + '\n');
  assert.equal(ok(git, 'git log --pretty=%h'), [
    replayed.slice(0, 7),
    ok(git, 'git rev-parse main').slice(0, 7),
    ok(git, 'git rev-parse main~1').slice(0, 7),
  ].join('\n') + '\n', '--pretty 不带 %d 时不显示引用');
  assert.ok(git.repo.objects.has(original), '原来的提交还在对象库里');
  assert.match(ok(git, 'git log --graph --oneline --all --decorate'), /^\* [0-9a-f]{7} \(HEAD -> topic\) topic$/m);
});

test('rebase 冲突后 --continue', () => {
  const git = lab();
  ok(git, 'printf "one\n" > f.txt');
  ok(git, 'git add f.txt');
  ok(git, 'git commit -m "base"');
  ok(git, 'git switch -c topic');
  ok(git, 'printf "topic\n" > f.txt');
  ok(git, 'git commit -am "topic"');
  ok(git, 'git switch main');
  ok(git, 'printf "main\n" > f.txt');
  ok(git, 'git commit -am "main"');
  ok(git, 'git switch topic');
  const stopped = git.run('git rebase main');
  assert.equal(stopped.code, 1);
  assert.match(stopped.stdout, /could not apply/);
  assert.match(ok(git, 'cat f.txt'), /<<<<<<< HEAD/);
  ok(git, 'printf "both\n" > f.txt');
  ok(git, 'git add f.txt');
  ok(git, 'git rebase --continue');
  assert.equal(ok(git, 'cat f.txt'), 'both\n');
  assert.equal(ok(git, 'git log --oneline').trimEnd().split('\n').length, 3);
});

test('reset 的三步：soft / mixed / hard', () => {
  const git = lab();
  ok(git, 'echo v1 > hello.c');
  ok(git, 'git add hello.c');
  ok(git, 'git commit -m "first"');
  ok(git, 'echo v2 > hello.c');
  ok(git, 'git add hello.c');
  ok(git, 'git commit -m "second"');
  const second = ok(git, 'git rev-parse HEAD');

  ok(git, 'git reset --soft HEAD~1');
  assert.equal(git.repo.headHash() !== second, true);
  assert.match(ok(git, 'git status --short'), /^M  hello\.c$/m, 'soft：暂存区保持 second 的内容');
  assert.equal(ok(git, 'cat hello.c'), 'v2\n', 'soft：工作区也不动');
  ok(git, 'git reset --hard HEAD');
  assert.equal(ok(git, 'git status --short'), '');

  ok(git, 'echo v2 > hello.c');
  ok(git, 'git add hello.c');
  ok(git, 'git commit -m "second again"');
  ok(git, 'git reset --mixed HEAD~1');
  assert.match(ok(git, 'git status --short'), /^ M hello\.c$/m, 'mixed：修变成未暂存');
  assert.equal(ok(git, 'cat hello.c'), 'v2\n', 'mixed：工作区不动');

  ok(git, 'git reset --hard HEAD');
  assert.equal(ok(git, 'git status --short'), '');
  ok(git, 'echo junk > hello.c');
  ok(git, 'git reset --hard HEAD');
  assert.equal(ok(git, 'cat hello.c'), 'v1\n', 'hard：工作区也重置');
  assert.match(ok(git, 'git reflog'), /reset: moving to HEAD/);
});

test('reflog 能救回 reset --hard 丢掉的合并提交', () => {
  const git = lab();
  ok(git, 'echo a > a.txt');
  ok(git, 'git add a.txt');
  ok(git, 'git commit -m "feat: a"');
  ok(git, 'git branch topic');
  ok(git, 'git switch topic');
  ok(git, 'echo t > t.txt');
  ok(git, 'git add t.txt');
  ok(git, 'git commit -m "topic"');
  ok(git, 'git switch main');
  const merge = git.run('git merge topic');
  assert.match(merge.stdout, /Fast-forward/);
  const merged = ok(git, 'git rev-parse HEAD');
  ok(git, 'git reset --hard HEAD~1');
  assert.notEqual(ok(git, 'git rev-parse HEAD'), merged);
  assert.match(ok(git, 'git reflog'), new RegExp(`reset: moving to HEAD~1`));
  assert.match(ok(git, 'git reflog'), new RegExp(merged.slice(0, 7)));
  ok(git, `git reset --hard ${merged}`);
  assert.equal(ok(git, 'git rev-parse HEAD'), merged);
});

test('stash：存成特殊提交，pop 之后修改回到工作区', () => {
  const git = lab();
  ok(git, 'echo v1 > hello.c');
  ok(git, 'git add hello.c');
  ok(git, 'git commit -m "first"');
  assert.equal(git.run('git stash').stdout, 'No local changes to save\n');
  ok(git, 'echo v2 > hello.c');
  assert.match(ok(git, 'git stash'), /Saved working directory and index state/);
  assert.equal(ok(git, 'git status --short'), '', 'stash 之后工作区干净');
  assert.equal(ok(git, 'cat hello.c'), 'v1\n');
  assert.match(ok(git, 'git stash list'), /^stash@\{0\}: WIP on main: /m);
  ok(git, 'git stash pop');
  assert.equal(ok(git, 'cat hello.c'), 'v2\n');
  assert.match(ok(git, 'git status --short'), /^ M hello\.c$/m, '默认不恢复暂存区');
  assert.equal(ok(git, 'git stash list'), '');
});

test('tag：轻量标签是引用，附注标签是对象', () => {
  const git = lab();
  ok(git, 'echo a > a.txt');
  ok(git, 'git add a.txt');
  ok(git, 'git commit -m "feat: a"');
  const head = ok(git, 'git rev-parse HEAD').trimEnd();
  ok(git, 'git tag v1');
  assert.equal(ok(git, 'git rev-parse v1').trimEnd(), head);
  assert.equal(ok(git, 'git cat-file -t v1'), 'commit\n');
  ok(git, 'git tag -a v2 -m "release"');
  assert.equal(ok(git, 'git cat-file -t v2'), 'tag\n');
  assert.equal(ok(git, 'git rev-parse v2^{commit}').trimEnd(), head);
  assert.deepEqual(ok(git, 'git tag').trimEnd().split('\n'), ['v1', 'v2']);
  assert.match(ok(git, 'git log --oneline --decorate'), /tag: v1/);
  ok(git, 'git tag -d v2');
  assert.equal(ok(git, 'git tag').trimEnd(), 'v1');
});

test('switch / restore：三个区域之间搬内容', () => {
  const git = lab();
  ok(git, 'echo v1 > hello.c');
  ok(git, 'git add hello.c');
  ok(git, 'git commit -m "first"');
  ok(git, 'git switch -c topic');
  ok(git, 'echo v2 > hello.c');
  ok(git, 'git add hello.c');
  ok(git, 'git commit -m "second"');
  ok(git, 'git switch main');
  assert.equal(ok(git, 'cat hello.c'), 'v1\n', '切分支会换成那个分支的快照');

  ok(git, 'echo v3 > hello.c');
  ok(git, 'git restore hello.c');
  assert.equal(ok(git, 'cat hello.c'), 'v1\n');
  ok(git, 'echo v3 > hello.c');
  ok(git, 'git add hello.c');
  assert.match(ok(git, 'git status --short'), /^M  hello\.c$/m);
  ok(git, 'git restore --staged hello.c');
  assert.match(ok(git, 'git status --short'), /^ M hello\.c$/m);
  assert.equal(ok(git, 'cat hello.c'), 'v3\n', '--staged 不动工作区');

  assert.equal(git.run('git switch nope').code, 128);
  ok(git, 'echo dirty > hello.c');
  assert.match(git.run('git switch topic').stderr, /would be overwritten by checkout/);
});

test('detached HEAD：提交没有分支跟着走，但能用 reflog 找回', () => {
  const git = lab();
  ok(git, 'echo a > a.txt');
  ok(git, 'git add a.txt');
  ok(git, 'git commit -m "feat: a"');
  ok(git, 'git checkout HEAD');
  assert.match(ok(git, 'git status'), /HEAD detached at/);
  ok(git, 'echo b > b.txt');
  ok(git, 'git add b.txt');
  ok(git, 'git commit -m "detached work"');
  const lost = ok(git, 'git rev-parse HEAD').trimEnd();
  ok(git, 'git switch main');
  assert.equal(ok(git, 'git rev-parse HEAD') !== lost, true);
  assert.ok(git.repo.objects.has(lost));
  assert.match(ok(git, 'git reflog'), new RegExp(lost.slice(0, 7)));
  ok(git, `git switch --detach ${lost}`);
  ok(git, 'git switch -c rescued');
  assert.equal(ok(git, 'git rev-parse HEAD').trimEnd(), lost);
  assert.equal(ok(git, 'cat b.txt'), 'b\n');
});

test('worktree：共享对象库和引用，各有 HEAD 与暂存区', () => {
  const git = lab();
  ok(git, 'echo a > a.txt');
  ok(git, 'git add a.txt');
  ok(git, 'git commit -m "feat: a"');
  ok(git, 'git worktree add -b agent-ui ../project-ui');
  assert.equal(git.worktrees.size, 2);
  assert.match(ok(git, 'git worktree list'), /\.\.\/project-ui\s+[0-9a-f]{7} \[agent-ui\]/);
  git.useWorktree('../project-ui');
  assert.equal(git.repo.headBranch(), 'agent-ui');
  ok(git, 'echo ui > ui.txt');
  ok(git, 'git add ui.txt');
  ok(git, 'git commit -m "feat: ui"');
  git.useWorktree('lab');
  assert.equal(ok(git, 'git status --short'), '');
  assert.equal(ok(git, 'git ls-files').includes('ui.txt'), false, '另一个工作目录的提交不在这个暂存区里');
  assert.ok(git.repo.objects.has(git.worktrees.get('../project-ui').headHash()), '但对象库是共享的');
});

test('远端：clone / fetch / push 在内存里对拍', () => {
  const git = lab();
  ok(git, 'git remote add origin demo://notes');
  assert.equal(ok(git, 'git remote'), 'origin\n');
  assert.match(ok(git, 'git remote -v'), /origin\tdemo:\/\/notes \(fetch\)/);
  const fetched = ok(git, 'git fetch origin');
  assert.match(fetched, /From demo:\/\/notes/);
  assert.match(fetched, /-> origin\/main/);
  assert.equal(ok(git, 'git rev-parse origin/main').trimEnd().length, 40);
  assert.equal(ok(git, 'git ls-files').trimEnd(), '', 'fetch 不碰工作区');

  const pulled = git.run('git pull origin main');
  assert.equal(pulled.code, 0, pulled.stderr);
  assert.match(ok(git, 'git ls-files'), /README\.md/);
  ok(git, 'echo local > local.txt');
  ok(git, 'git add local.txt');
  ok(git, 'git commit -m "feat: local"');
  assert.match(ok(git, 'git push origin main'), /main -> main/);
  const remote = git.remotes.get('origin').repo;
  assert.equal(remote.refs.get('refs/heads/main'), git.repo.refs.get('refs/heads/main'), '远端引用被更新');

  const clone = git.run('git clone demo://notes copy');
  assert.equal(clone.code, 0, clone.stderr);
  assert.ok(clone.replace, 'clone 产出一个新的仓库实例');
  assert.equal(ok(clone.replace, 'git ls-files').includes('local.txt'), true, '克隆拿到了推送过去的历史');
  assert.equal(ok(clone.replace, 'git remote'), 'origin\n');
});

test('cherry-pick 与 blame', () => {
  const git = lab();
  ok(git, 'echo one > f.txt');
  ok(git, 'git add f.txt');
  ok(git, 'git commit -m "one"');
  ok(git, 'git switch -c topic');
  ok(git, 'printf "one\ntwo\n" > f.txt');
  ok(git, 'git add f.txt');
  ok(git, 'git commit -m "two"');
  ok(git, 'git switch main');
  ok(git, 'echo other > other.txt');
  ok(git, 'git add other.txt');
  ok(git, 'git commit -m "other"');
  ok(git, 'git cherry-pick topic');
  assert.equal(ok(git, 'cat f.txt'), 'one\ntwo\n');
  assert.equal(ok(git, 'git log -1 --pretty=%s'), 'two\n');
  const blame = ok(git, 'git blame f.txt').trimEnd().split('\n');
  assert.match(blame[0], /^[0-9a-f]{7} \(Git Learner .* 1\) one$/);
  assert.match(blame[1], /^[0-9a-f]{7} \(Git Learner .* 2\) two$/);
});

test('effects：命令到底改了什么', () => {
  const git = lab();
  const init = git.run('git init -b main');
  assert.deepEqual(init.effects.objects, []);

  const write = git.run('echo v1 > hello.c');
  assert.deepEqual(write.effects.worktree, [{ path: 'hello.c', action: 'created', hash: write.effects.worktree[0].hash }]);

  const add = git.run('git add hello.c');
  assert.equal(add.effects.objects.length, 1);
  assert.equal(add.effects.objects[0].type, 'blob');
  assert.deepEqual(add.effects.index, [{ path: 'hello.c', action: 'staged', value: add.effects.index[0].value }]);

  const commit = git.run('git commit -m "feat: hello"');
  assert.deepEqual(commit.effects.objects.map((object) => object.type).sort(), ['commit', 'tree']);
  assert.deepEqual(commit.effects.refs, [{ ref: 'refs/heads/main', from: null, to: commit.effects.refs[0].to }]);
  assert.match(commit.notes.join(' '), /父提交/);

  const read = git.run('git status');
  assert.deepEqual(read.effects.objects, []);
  assert.deepEqual(read.effects.refs, []);
  assert.deepEqual(read.effects.worktree, []);
  assert.deepEqual(read.effects.index, []);
});

test('config 改变提交里的作者', () => {
  const git = lab();
  ok(git, 'git config user.name "李雷"');
  ok(git, 'git config user.email "lilei@example.com"');
  ok(git, 'echo a > a.txt');
  ok(git, 'git add a.txt');
  ok(git, 'git commit -m "feat: a"');
  assert.match(ok(git, 'git log -1 --pretty="%an <%ae>"'), /^李雷 <lilei@example\.com>$/m);
});

test('小管道：echo / printf / cat / 重定向', () => {
  const git = lab();
  ok(git, 'printf "line1\nline2\n" > notes.txt');
  assert.equal(ok(git, 'cat notes.txt'), 'line1\nline2\n');
  assert.equal(ok(git, 'cat notes.txt | head -1'), 'line1\n');
  ok(git, 'echo more >> notes.txt');
  assert.equal(ok(git, 'cat notes.txt'), 'line1\nline2\nmore\n');
  assert.equal(git.run('cat missing.txt').code, 1);
  assert.equal(git.run('frobnicate').code, 1);
  assert.match(git.run('frobnicate').stderr, /is not a git command/);
  assert.match(git.run('cat notes.txt | wc -l').stderr, /command not found/);
});

test('help 与 version', () => {
  const git = lab();
  assert.match(ok(git, 'git help'), /rebase <upstream>/);
  assert.match(ok(git, 'git version'), /^git version /);
  assert.equal(git.run('git not-a-command').code, 1);
});
