import { Git, resetRemotes } from '../src/engine/commands.js';
import { parseCommit, parseTree } from '../src/engine/objects.js';
import { computeStatus } from '../src/engine/format.js';
import { renderGraph } from './graph.js';
import { TOURS } from './tours.js';

const el = (id) => document.getElementById(id);

const CHEATS = [
  'git init -b main',
  'git status',
  'git status -s',
  'git diff',
  'git diff --cached',
  'git log --oneline',
  'git log --graph --oneline --all',
  'git add .',
  'git commit -m "feat: ..."',
  'git commit -am "fix: ..."',
  'git branch topic',
  'git switch -c topic',
  'git switch main',
  'git merge topic',
  'git rebase main',
  'git cherry-pick HEAD~1',
  'git reset --hard HEAD~1',
  'git restore --staged hello.c',
  'git stash',
  'git stash pop',
  'git reflog',
  'git tag v1',
  'git cat-file -p HEAD',
  'git ls-files -s',
  'git rev-parse HEAD',
  'git remote add origin demo://notes',
  'git fetch origin',
  'git pull origin main',
  'git push origin main',
  'git worktree add -b agent-ui ../project-ui',
  'git help',
];

const PREDICT_QUESTIONS = [
  '工作区会变吗？',
  '下一次提交包含什么？',
  '哪个引用会移动？',
  '历史里会多出什么关系？',
];

const state = {
  git: null,
  predict: true,
  tour: null,
  history: [],
  historyIndex: -1,
};

// ---------------------------------------------------------------- helpers --

function short(hash) {
  return hash ? hash.slice(0, 7) : '———';
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0] ?? '';
}

function prompt() {
  const repo = state.git.repo;
  const branch = repo.headBranch();
  const where = branch ?? (repo.isDetached() ? `(${short(repo.headHash())})` : repo.headRef?.replace('refs/heads/', '') ?? 'main');
  return `${repo.dir}:${where}$`;
}

function print(text, cls = 'out') {
  const terminal = el('terminal');
  for (const line of String(text ?? '').split('\n')) {
    const node = document.createElement('p');
    node.className = `line ${cls}`;
    node.innerHTML = highlight(line);
    terminal.append(node);
  }
  terminal.scrollTop = terminal.scrollHeight;
}

/** Give 7–40 位哈希一点颜色，其他内容原样输出。 */
function highlight(line) {
  return line
    .replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch])
    .replace(/\b[0-9a-f]{7,40}\b/g, (hash) => `<span class="hash">${hash}</span>`);
}

function scrollTerminal() {
  const terminal = el('terminal');
  terminal.scrollTop = terminal.scrollHeight;
}

// ------------------------------------------------------------------ boot ---

function boot() {
  state.git = new Git();
  state.git.run('git init -b main');
  print('Git 可视化讲解 · 先预测，再观察', 'dim');
  print('这个仓库跑在浏览器里：三种对象、一张 DAG、一组引用，全部由本地代码实现。', 'dim');
  print('哈希与真 git 逐字节一致（npm run oracle 可以对拍），右边每个面板都会随命令更新。', 'dim');
  print('试试：git status、git log --graph --oneline --all，或者点左侧“跟着练”。', 'dim');
  print('', 'dim');
  renderAll();
  el('command-input').focus();
}

function resetRepo() {  resetRemotes();
  state.git = new Git();
  state.git.run('git init -b main');
  print('—— 仓库已重置 ——', 'dim');
  renderAll();
}

// --------------------------------------------------------------- execute ---

function execute(line) {
  const text = String(line ?? '').trim();
  if (!text) return;
  state.history.push(text);
  state.historyIndex = state.history.length;
  print(text, 'cmd');

  const before = commitHashes();
  if (state.predict) {
    print('⌥ 先预测（jyy 的四个问题）：', 'predict');
    PREDICT_QUESTIONS.forEach((question, index) => print(`   ${index + 1}. ${question}`, 'predict'));
  }

  const result = state.git.run(text);
  if (result.replace) {
    state.git = result.replace;
    print(`（已切换到克隆出来的仓库 ${state.git.repo.dir}）`, 'dim');
  }
  if (result.stdout) print(result.stdout, 'out');
  if (result.stderr) print(result.stderr, 'err');

  const after = commitHashes();
  const fresh = [...after].filter((hash) => !before.has(hash));
  renderExplain(result, fresh.length);
  renderAll(fresh);
}

function commitHashes() {
  const repo = state.git.repo;
  const seeds = new Set();
  for (const name of repo.refs.keys()) {
    if (name.startsWith('refs/stash')) continue;
    const hash = repo.resolveRef(name);
    if (hash) repo.collect(hash, seeds);
  }
  const head = repo.headHash();
  if (head) repo.collect(head, seeds);
  return seeds;
}

// --------------------------------------------------------------- explain ---

function describeEffects(result) {
  const { objects, refs, worktree, index } = result.effects;
  const counts = {};
  for (const object of objects) counts[object.type] = (counts[object.type] ?? 0) + 1;
  const objectSummary = objects.length
    ? Object.entries(counts)
        .map(([type, count]) => `${type}×${count}`)
        .join('、')
    : '';

  const answers = [
    {
      question: '工作区变了吗？',
      answer: worktree.length
        ? worktree.map((item) => `${item.path}（${item.action === 'created' ? '新建' : item.action === 'deleted' ? '删除' : '修改'}）`).join('、')
        : '没变',
    },
    {
      question: '暂存区变了吗？',
      answer: index.length
        ? index
            .map((item) => {
              const hash = /(\b[0-9a-f]{40}\b)/.exec(item.value)?.[1];
              return `${item.path}${hash ? ` → blob ${short(hash)}` : ''}（${item.action === 'staged' ? '加入' : item.action === 'unstaged' ? '移出' : '更新'}）`;
            })
            .join('、')
        : '没变',
    },
    {
      question: '哪个引用动了？',
      answer: refs.length
        ? refs
            .map((item) => {
              return `${item.ref}: ${item.from ? short(item.from) : '（新建）'} → ${short(item.to)}`;
            })
            .join('、')
        : '没动',
    },
    {
      question: '对象库多了什么？',
      answer: objects.length ? objectSummary : '没有新对象（只读命令）',
    },
  ];
  return answers;
}

function renderExplain(result, fresh) {
  const box = el('explain');
  box.replaceChildren();
  if (!result) return;

  const head = document.createElement('p');
  head.className = 'hint';
  head.textContent = `$ ${result.line ?? ''}`;  box.append(head);

  if (result.code !== 0) {
    const failure = document.createElement('p');
    failure.innerHTML = '<span class="tag warn">失败</span>这条命令没有改变仓库（退出码非 0）。';
    box.append(failure);
  }

  const list = document.createElement('dl');
  list.className = 'answer';
  for (const item of describeEffects(result)) {
    const term = document.createElement('dt');
    term.textContent = item.question;
    const description = document.createElement('dd');
    description.textContent = item.answer;
    list.append(term, description);
  }
  box.append(list);

  if (result.notes.length) {
    const notes = document.createElement('ul');
    for (const note of result.notes) {
      const item = document.createElement('li');
      item.textContent = note;
      notes.append(item);
    }
    box.append(notes);
  }

  if (fresh) {
    const line = document.createElement('p');
    line.className = 'hint';
    line.innerHTML = `<span class="tag yes">新提交 ×${fresh}</span>提交图里高亮的就是它们。`;
    box.append(line);
  }

  const conflicts = state.git.repo.conflictedPaths();
  if (conflicts.length) {
    const warn = document.createElement('p');
    warn.innerHTML = `<span class="tag warn">有冲突</span>${conflicts.map((item) => item.path).join('、')} 还处于未合并状态：改好、git add、再 commit。`;
    box.append(warn);
  }
  if (state.git.repo.mergeState || state.git.repo.rebaseState) {
    const warn = document.createElement('p');
    const kind = state.git.repo.rebaseState ? 'rebase' : 'merge';
    warn.innerHTML = `<span class="tag warn">${kind} 进行中</span>解决后 <code>git ${kind} --continue</code>，或者 <code>git ${kind} --abort</code> 回到原状。`;
    box.append(warn);
  }
}

// ----------------------------------------------------------------- areas ---

function renderAreas() {
  const repo = state.git.repo;
  const box = el('areas');
  box.replaceChildren();
  const status = new Map(computeStatus(repo).map((entry) => [entry.path, entry]));
  const head = repo.headHash();
  const headFiles = new Map((head ? repo.listTree(head) : []).map((entry) => [entry.path, entry]));
  const paths = [...new Set([...repo.files.keys(), ...repo.index.keys(), ...headFiles.keys()])].sort();

  const columns = [
    { title: '工作区', kind: 'work' },
    { title: '暂存区', kind: 'index' },
    { title: 'HEAD', kind: 'head' },
  ];

  for (const column of columns) {
    const section = document.createElement('div');
    section.className = 'area';
    const title = document.createElement('h3');
    title.textContent = column.title;
    section.append(title);
    const visible = paths.filter((path) => (column.kind === 'work' ? repo.files.has(path) : column.kind === 'index' ? repo.index.has(path) : headFiles.has(path)));
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = column.kind === 'head' && !head ? '还没有提交' : '空';
      section.append(empty);
    }
    for (const path of visible) {
      const entry = status.get(path);
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.className = `path ${entry ? stateClass(entry) : ''}`;
      name.textContent = path;
      const meta = document.createElement('span');
      meta.className = 'meta';
      if (column.kind === 'work') {
        const content = repo.readFile(path);
        meta.textContent = entry?.conflicted ? '冲突标记' : short(repo.hashContent(content));
      } else if (column.kind === 'index') {
        const staged = repo.index.get(path);
        meta.textContent = staged?.conflicted ? `stage ${JSON.stringify(staged.conflicted).length > 0 ? '1/2/3' : ''}` : short(staged?.hash);
      } else {
        meta.textContent = short(headFiles.get(path).hash);
      }
      row.append(name, meta);
      section.append(row);
    }
    box.append(section);
  }
}

function stateClass(entry) {
  if (entry.conflicted) return 'modified';
  if (entry.untracked) return 'untracked';
  if (entry.x === 'A') return 'staged';
  if (entry.x === 'D') return 'deleted';
  if (entry.x === 'M' && entry.y === 'M') return 'modified';
  if (entry.x === 'M') return 'staged';
  return 'modified';
}

// ------------------------------------------------------------------ graph ---

function renderGraphPanel(fresh) {
  const model = buildGraphModel(new Set(fresh ?? []));
  renderGraph(el('graph'), model);
}

function buildGraphModel(highlight) {
  const repo = state.git.repo;
  const order = [...commitHashes()].sort((a, b) => {
    const left = parseCommit(a, repo.objects);
    const right = parseCommit(b, repo.objects);
    return right.committer.timestamp - left.committer.timestamp || (a < b ? -1 : 1);
  });

  const commits = new Map(
    order.map((hash) => {
      const commit = parseCommit(hash, repo.objects);
      return [
        hash,
        {
          hash,
          parents: commit.parents,
          subject: firstLine(commit.message),
          short: repo.shortHash(hash),
          merge: commit.parents.length > 1,
        },
      ];
    }),
  );

  const refs = new Map();
  const add = (hash, label, kind) => {
    if (!hash) return;
    if (!refs.has(hash)) refs.set(hash, []);
    refs.get(hash).push({ label, kind });
  };
  const branch = repo.headBranch();
  const head = repo.headHash();
  if (branch && head) add(head, `HEAD -> ${branch}`, 'head');
  else if (repo.isDetached() && head) add(head, 'HEAD', 'head');

  for (const [name, target] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (name.startsWith('refs/stash')) continue;
    if (name.startsWith('refs/heads/')) {
      const shortName = name.slice('refs/heads/'.length);
      if (shortName !== branch) add(repo.peel(target), shortName, 'branch');
    } else if (name.startsWith('refs/remotes/')) {
      add(repo.peel(target), name.slice('refs/remotes/'.length), 'remote');
    } else if (name.startsWith('refs/tags/')) {
      add(repo.peel(target), `tag: ${name.slice('refs/tags/'.length)}`, 'tag');
    }
  }

  return {
    order,
    commits,
    refs,
    highlight,
    head: { hash: head, branch, detached: repo.isDetached(), unborn: !head && !!repo.headRef },
  };
}

// ------------------------------------------------------- store / refs / log ---

function renderStore() {
  const repo = state.git.repo;
  const objects = repo.objects.list();
  const counts = {};
  for (const object of objects) counts[object.type] = (counts[object.type] ?? 0) + 1;
  el('store-count').textContent = `${objects.length} 个对象 · ${Object.entries(counts)
    .map(([type, count]) => `${type}×${count}`)
    .join(' ')}`;

  const box = el('tab-objects');
  box.replaceChildren();
  if (!objects.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '对象库还是空的。git add 会写入第一个 blob。';
    box.append(empty);
  }
  const sorted = [...objects].sort((a, b) => a.type.localeCompare(b.type) || (a.hash < b.hash ? -1 : 1));
  for (const object of sorted) {
    const row = document.createElement('div');
    row.className = 'row clickable';
    row.append(typeBadge(object.type), hashSpan(short(object.hash)));
    const summary = document.createElement('span');
    summary.className = 'meta';
    summary.textContent = describeObject(object);
    row.append(summary);
    row.addEventListener('click', () => showObject(object.hash));
    box.append(row);
  }

  renderRefs();
  renderReflog();
}

function typeBadge(type) {
  const span = document.createElement('span');
  span.className = `type ${type}`;
  span.textContent = type;
  return span;
}

function hashSpan(text) {
  const span = document.createElement('span');
  span.className = 'hash';
  span.textContent = text;
  return span;
}

function describeObject(object) {
  if (object.type === 'commit') {
    const commit = parseCommit(object.hash, state.git.repo.objects);
    return firstLine(commit.message) || '（无说明）';
  }
  if (object.type === 'blob') return `${object.size} 字节 · ${firstLine(new TextDecoder().decode(object.bytes)).slice(0, 24) || '（空文件）'}`;
  if (object.type === 'tree') {
    const entries = parseTree(object.hash, state.git.repo.objects).entries;
    return entries.map((entry) => `${entry.mode === '40000' ? 'tree' : 'blob'} ${entry.name}`).join('、').slice(0, 40) || '（空目录）';
  }
  return `${object.size} 字节`;
}

function showObject(hash) {
  const repo = state.git.repo;
  const object = repo.objects.get(hash);
  const box = el('tab-objects');
  box.querySelector('.detail')?.remove();
  const detail = document.createElement('div');
  detail.className = 'detail';
  detail.textContent = repo.objects.text(hash);
  const title = document.createElement('p');
  title.className = 'hint';
  title.textContent = `cat-file -p ${hash.slice(0, 7)}（${object.type}，${object.size} 字节）`;
  detail.before(title);
  box.append(detail);
}

function renderRefs() {
  const repo = state.git.repo;
  const box = el('tab-refs');
  box.replaceChildren();
  const entries = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有任何引用。第一个 commit 会创建 refs/heads/main。';
    box.append(empty);
  }
  for (const [name, target] of entries) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.textContent = name;
    row.append(label, hashSpan(short(target)));
    const subject = document.createElement('span');
    subject.className = 'meta';
    const peeled = repo.peel(target);
    const object = repo.objects.get(peeled);
    subject.textContent = object.type === 'commit' ? firstLine(parseCommit(peeled, repo.objects).message) : object.type;
    row.append(subject);
    box.append(row);
  }
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = '引用就是 .git/refs 下的几十字节小文件：分支、HEAD、标签都是引用，也是仓库里唯一会变的东西。';
  box.append(note);
}

function renderReflog() {
  const repo = state.git.repo;
  const box = el('tab-reflog');
  box.replaceChildren();
  const refs = ['HEAD', ...[...repo.refs.keys()].filter((name) => !name.startsWith('refs/remotes/')).sort()];
  let any = false;
  for (const ref of refs) {
    const entries = repo.reflogEntries(ref);
    if (!entries.length) continue;
    any = true;
    const title = document.createElement('p');
    title.className = 'hint';
    title.textContent = ref;
    box.append(title);
    entries.forEach((entry, index) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.append(hashSpan(short(entry.new ?? entry.old)));
      const label = document.createElement('span');
      label.textContent = `${ref}@{${index}}: ${entry.message}`;
      row.append(label);
      box.append(row);
    });
  }
  if (!any) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'reflog 还是空的：引用每移动一次就记一条，误操作后可以从这里找回提交。';
    box.append(empty);
  }
}

// ------------------------------------------------------------- rendering ---

function renderAll(fresh = []) {
  el('prompt').textContent = prompt();
  el('prompt-hint').textContent = prompt();
  renderGraphPanel(fresh);
  renderAreas();
  renderStore();
  renderWorktrees();
}

function renderWorktrees() {
  const select = el('worktree-select');
  const current = state.git.repo.dir;
  select.replaceChildren();
  for (const dir of state.git.worktrees.keys()) {
    const option = document.createElement('option');
    option.value = dir;
    option.textContent = dir;
    if (dir === current) option.selected = true;
    select.append(option);
  }
}

// ------------------------------------------------------------------ tours ---

function renderTours() {
  const list = el('tour-list');
  list.replaceChildren();
  for (const tour of TOURS) {
    const item = document.createElement('li');
    item.textContent = tour.title;
    item.dataset.tour = tour.id;
    item.addEventListener('click', () => startTour(tour.id));
    list.append(item);
  }
  renderCheats();
}

function renderCheats() {
  const box = el('cheats');
  box.replaceChildren();
  for (const command of CHEATS) {
    const button = document.createElement('button');
    button.textContent = command;
    button.addEventListener('click', () => {
      const input = el('command-input');
      input.value = command;
      input.focus();
    });
    box.append(button);
  }
}

function startTour(id) {
  const tour = TOURS.find((item) => item.id === id);
  if (!tour) return;
  for (const item of el('tour-list').children) item.classList.toggle('active', item.dataset.tour === id);
  resetRepo();
  state.tour = { id, step: 0 };
  el('tour-stage').hidden = false;
  print(`⌥ ${tour.title}`, 'predict');
  print(tour.intro, 'dim');
  showTourStep();
}

function showTourStep() {
  const tour = TOURS.find((item) => item.id === state.tour?.id);
  if (!tour) return;
  const step = tour.steps[state.tour.step];
  if (!step) {
    el('tour-say').textContent = '练完了。可以改改上面的命令自己试，或者换一个 tour。';
    el('tour-progress').textContent = `${tour.steps.length}/${tour.steps.length}`;
    return;
  }
  el('tour-say').textContent = step.say || `执行：${step.cmd}`;
  el('tour-progress').textContent = `${state.tour.step + 1}/${tour.steps.length}`;
}

function tourNext() {
  const tour = TOURS.find((item) => item.id === state.tour?.id);
  if (!tour) return;
  const step = tour.steps[state.tour.step];
  if (!step) return;
  if (step.say) print(step.say, 'dim');
  el('command-input').value = step.cmd;
  execute(step.cmd);
  el('command-input').value = '';
  state.tour.step += 1;
  showTourStep();
}

function tourPrev() {
  if (!state.tour || state.tour.step === 0) return;
  state.tour.step -= 1;
  showTourStep();
}

// ------------------------------------------------------------------- wire ---

function wire() {
  el('command-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = el('command-input');
    execute(input.value);
    input.value = '';
  });

  const input = el('command-input');
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
      if (state.historyIndex > 0) {
        state.historyIndex -= 1;
        input.value = state.history[state.historyIndex] ?? '';
      }
      event.preventDefault();
    }
    if (event.key === 'ArrowDown') {
      if (state.historyIndex < state.history.length) {
        state.historyIndex += 1;
        input.value = state.history[state.historyIndex] ?? '';
      }
      event.preventDefault();
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const value = input.value;
      const completions = complete(value);
      if (completions.length === 1) input.value = `${completions[0]} `;
      else if (completions.length > 1) print(completions.join('   '), 'dim');
    }
  });

  el('terminal').addEventListener('click', () => input.focus());
  el('reset-button').addEventListener('click', resetRepo);
  el('help-button').addEventListener('click', () => {
    print(state.git.help(), 'out');
  });
  el('predict-toggle').addEventListener('change', (event) => {
    state.predict = event.target.checked;
  });
  el('worktree-select').addEventListener('change', (event) => {
    try {
      state.git.useWorktree(event.target.value);
      print(`（切换到工作目录 ${event.target.value}）`, 'dim');
      renderAll();
    } catch (error) {
      print(error.message, 'err');
    }
  });
  el('tour-next').addEventListener('click', tourNext);
  el('tour-prev').addEventListener('click', tourPrev);

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
      for (const name of ['objects', 'refs', 'reflog']) el(`tab-${name}`).hidden = name !== tab.dataset.tab;
    });
  }
}

/** Complete `git <subcommand>` and file paths from the working tree. */
function complete(value) {
  const words = value.split(/\s+/);
  const last = words[words.length - 1] ?? '';
  const prefix = words.slice(0, -1).join(' ');
  if (words.length <= 1) return ['git'];
  if (words.length === 2 && words[0] === 'git') {
    const subcommands = [
      'init', 'add', 'rm', 'commit', 'status', 'diff', 'log', 'show', 'cat-file', 'hash-object', 'ls-files', 'ls-tree',
      'rev-parse', 'config', 'branch', 'switch', 'checkout', 'restore', 'tag', 'reflog', 'merge', 'rebase',
      'cherry-pick', 'reset', 'stash', 'remote', 'fetch', 'pull', 'push', 'clone', 'worktree', 'blame', 'help',
    ];
    return subcommands.filter((name) => name.startsWith(last)).map((name) => `git ${name}`);
  }
  const paths = [...new Set([...state.git.repo.files.keys(), ...state.git.repo.index.keys()])];
  return paths.filter((path) => path.startsWith(last)).map((path) => (prefix ? `${prefix} ${path}` : path));
}

renderTours();
wire();
boot();

// 便于分享和自测：?run=git%20status;;git%20log 会依次执行这些命令，
// ?tour=merge 会直接开始对应的讲解。
window.addEventListener('error', (event) => {
  print(`页面脚本出错：${event.message}`, 'err');
});

const params = new URLSearchParams(location.search);
const tourId = params.get('tour');
if (tourId) startTour(tourId);
if (params.get('auto') && state.tour) {
  // ?tour=merge&auto=1 自动把整个讲解跑完，用来演示和自测
  const step = () => {
    const tour = TOURS.find((item) => item.id === state.tour?.id);
    if (!tour || state.tour.step >= tour.steps.length) return;
    tourNext();
    setTimeout(step, 20);
  };
  setTimeout(step, 20);
}
const script = params.get('run');
if (script) {
  for (const line of script.split(';;')) {
    const text = line.trim();
    if (text) execute(text);
  }
}
