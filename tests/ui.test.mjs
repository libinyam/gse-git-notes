/**
 * UI 粘连层的行为测试：用 tests/dom-stub.mjs 在 Node 里驱动 web/app.js，
 * 覆盖提交命令、四个问题的回答、三个区域、选项卡、tour、补全和工作目录切换。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDom } from './dom-stub.mjs';

const dom = createDom();
globalThis.window = dom.window;
globalThis.document = dom.document;
globalThis.location = dom.location;
globalThis.setTimeout = setTimeout;

await import('../web/app.js');

const el = dom.element;
const terminal = () => el('terminal').text;
const graph = () => el('graph').text;
const explain = () => el('explain').text;
const areas = () => el('areas').text;

function run(line) {
  const input = el('command-input');
  input.value = line;
  el('command-form').dispatch('submit', { preventDefault() {} });
}

function key(target, k) {
  target.dispatch('keydown', { key: k, preventDefault() {} });
}


test('UI 粘连层：命令、解释面板、图、三个区域、tour、补全、工作目录', () => {

assert.match(terminal(), /先预测，再观察/, '启动时打印欢迎语');
assert.match(graph(), /还没有任何提交/, '空仓库说明 HEAD 指向未出生的分支');
assert.match(el('prompt').textContent, /^lab:main\$$/, '提示符显示当前分支');

// ---- 一条命令的完整回路 ----------------------------------------------------

run('echo v1 > hello.c && git add hello.c && git commit -m "feat: hello"');
assert.match(terminal(), /feat: hello/, '终端回显命令输出');
assert.match(graph(), /feat: hello/, '提交图出现新节点');
assert.match(explain(), /工作区变了吗？/, '解释面板回答 jyy 的四个问题');
assert.match(explain(), /refs\/heads\/main/, '解释面板说明引用移动');
assert.match(explain(), /hello.c/, '解释面板列出变化的文件');
assert.match(areas(), /hello\.c/, '三个区域面板出现文件');
assert.match(el('tab-objects').text, /commit/, '对象库面板有 commit');
assert.match(el('store-count').textContent, /commit×1/, '对象库统计按类型计数');

// 点一个对象看内容
const objectRows = el('tab-objects').querySelectorAll('.row.clickable');
assert.ok(objectRows.length > 0, '对象库有可点击的行');
objectRows.find((row) => row.text.includes('commit')).dispatch('click');
assert.match(el('tab-objects').text, /cat-file -p/, '点击对象显示内容');
assert.match(el('tab-objects').text, /tree [0-9a-f]{40}/, 'commit 内容里能看到 tree 行');

// ---- 预测开关 --------------------------------------------------------------

el('predict-toggle').checked = false;
el('predict-toggle').dispatch('change', { target: el('predict-toggle') });
const beforePredictOff = terminal().length;
run('git status');
assert.doesNotMatch(terminal().slice(beforePredictOff), /先预测（jyy 的四个问题）：/, '关掉预测后不再提问');
el('predict-toggle').checked = true;
el('predict-toggle').dispatch('change', { target: el('predict-toggle') });
const beforePredictOn = terminal().length;
run('git status');
assert.match(terminal().slice(beforePredictOn), /先预测（jyy 的四个问题）：/, '打开预测后重新提问');

// ---- 分支、切换与提示符 ----------------------------------------------------

run('git switch -c topic');
assert.match(terminal(), /Switched to a new branch 'topic'/);
assert.match(el('prompt').textContent, /^lab:topic\$$/, '提示符跟随分支');
assert.match(graph(), /HEAD -> topic/, '提交图标注 HEAD');

// ---- 冲突 ------------------------------------------------------------------

run('printf "1\\n" > r.txt && git add r.txt && git commit -m base');
run('git switch main');
run('printf "2\\n" > r.txt && git add r.txt && git commit -m main');
run('git switch topic');
run('printf "3\\n" > r.txt && git commit -am topic');
run('git switch main && git merge topic');
assert.match(terminal(), /CONFLICT \(content\): Merge conflict in r\.txt/, '冲突在终端里报告');
run('cat r.txt');
assert.match(terminal(), /<<<<<<< HEAD/, '冲突标记写进工作区文件');
assert.match(explain(), /有冲突/, '解释面板提示还有未合并路径');
assert.match(el('tab-reflog').text, /checkout: moving from/, 'reflog 记录切换');

run('printf "merged\\n" > r.txt && git add r.txt && git commit -m resolved');
assert.doesNotMatch(explain(), /有冲突/, '解决后不再提示冲突');
assert.match(graph(), /merge/, '提交图区分合并提交');
assert.match(explain(), /合并提交有两个父提交|父提交/, '解释面板说明合并提交的父提交');

// ---- 历史与补全 ------------------------------------------------------------

run('git log --oneline');
key(el('command-input'), 'ArrowUp');
assert.equal(el('command-input').value, 'git log --oneline', '↑ 取上一条命令');
key(el('command-input'), 'ArrowDown');
assert.equal(el('command-input').value, '', '↓ 回到空输入');
el('command-input').value = 'git log';
key(el('command-input'), 'Tab');
assert.equal(el('command-input').value, 'git log ', 'Tab 补全子命令');
el('command-input').value = 'hel';
key(el('command-input'), 'Tab');
assert.equal(el('command-input').value, 'git ', '只有一个候选时补全为 git 前缀');
el('command-input').value = 'git add r.';
key(el('command-input'), 'Tab');
assert.equal(el('command-input').value, 'git add r.txt ', 'Tab 补全工作区路径');

// ---- 选项卡、速查、help ----------------------------------------------------

dom.tabs[2].dispatch('click');
assert.equal(el('tab-reflog').hidden, false, 'reflog 选项卡可见');
assert.equal(el('tab-objects').hidden, true, '对象库选项卡隐藏');
dom.tabs[0].dispatch('click');
assert.equal(el('tab-objects').hidden, false, '切回对象库');

const cheats = el('cheats').querySelectorAll('button');
assert.ok(cheats.length > 10, '速查面板有按钮');
cheats[0].dispatch('click');
assert.equal(el('command-input').value, cheats[0].textContent, '点速查按钮填入输入框');
el('command-input').value = '';

el('help-button').dispatch('click');
assert.match(terminal(), /这些命令可以在本模拟器里运行/, '命令清单按钮打印帮助');

// ---- 工作目录 --------------------------------------------------------------

run('git worktree add -b ui ../ui');
const select = el('worktree-select');
assert.deepEqual(
  [...select.options].map((option) => option.value),
  ['lab', '../ui'],
  'worktree 出现在选择器里',
);
select.value = '../ui';
select.dispatch('change', { target: select });
assert.match(el('prompt').textContent, /\.\.\/ui/, '切换后提示符换成新工作目录');
select.value = 'lab';
select.dispatch('change', { target: select });

// ---- tour ------------------------------------------------------------------

const tours = el('tour-list').querySelectorAll('li');
assert.ok(tours.length >= 5, '讲解列表有多个 tour');
tours[0].dispatch('click');
assert.equal(el('tour-stage').hidden, false, '开始 tour 后显示讲解台');
const before = terminal();
el('tour-next').dispatch('click');
assert.notEqual(terminal(), before, '执行下一步会产生新的终端输出');
assert.match(el('tour-progress').textContent, /^\d+\/\d+$/, '显示进度');
el('tour-prev').dispatch('click');

// ---- 重置 ------------------------------------------------------------------

el('reset-button').dispatch('click');
assert.match(graph(), /还没有任何提交/, '重置后回到空仓库');
assert.match(terminal(), /仓库已重置/);

});
