/**
 * 把提交历史画成 SVG：一行一个提交（新的在上，和 git log 一致），一条泳道一个
 * 待处理的父提交，箭头指向父提交——表示“来自”，不是“下一个”。
 */

const ROW = 52;
const LANE = 98;
const NODE_W = 168;
const NODE_H = 30;
const LEFT = 14;
const TOP = 30;

const charWidth = (text) => text.length * 6.6 + 12;

/**
 * @param {HTMLElement} container
 * @param {object} model
 * @param {string[]} model.order      commit hashes, newest first
 * @param {Map} model.commits         hash -> { hash, parents, subject, short, merge }
 * @param {Map} model.refs            hash -> [{ label, kind }]
 * @param {{ branch: string|null, detached: boolean, hash: string|null }} model.head
 * @param {Set<string>} model.highlight  commits that just appeared
 */
export function renderGraph(container, model) {
  container.replaceChildren();
  if (!model.order.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有任何提交：HEAD 指向一个还不存在的分支（unborn）。执行 git commit 就会出现第一个节点。';
    container.append(empty);
    return;
  }

  const rowIndex = new Map(model.order.map((hash, index) => [hash, index]));
  const laneOf = assignLanes(model);

  let maxBadges = 1;
  for (const hash of model.order) maxBadges = Math.max(maxBadges, (model.refs.get(hash) ?? []).length);
  const badgeLane = maxBadges ? 108 + maxBadges * 96 : 0;
  const width = LEFT + (laneCount(laneOf) + 1) * LANE + badgeLane;
  const height = TOP + model.order.length * ROW + 16;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(Math.max(width, 320)));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${Math.max(width, 320)} ${height}`);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#3b4a63"></path>
    </marker>
    <marker id="arrow-new" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#6ea8fe"></path>
    </marker>`;
  svg.append(defs);

  const centerX = (lane) => LEFT + lane * LANE + NODE_W / 2;
  const centerY = (row) => TOP + row * ROW + NODE_H / 2;

  // 边：从提交指向它的每个父提交
  for (const hash of model.order) {
    const row = rowIndex.get(hash);
    const commit = model.commits.get(hash);
    for (const parent of commit.parents) {
      if (!rowIndex.has(parent)) continue;
      const targetRow = rowIndex.get(parent);
      const x1 = centerX(laneOf.get(hash));
      const y1 = centerY(row);
      const x2 = centerX(laneOf.get(parent));
      const y2 = centerY(targetRow);
      const fresh = model.highlight.has(hash) || model.highlight.has(parent);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const bend = Math.max(18, (y2 - y1) / 2);
      path.setAttribute('d', `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2 - 3}`);
      path.setAttribute('class', `edge${fresh ? ' new' : ''}`);
      path.setAttribute('marker-end', fresh ? 'url(#arrow-new)' : 'url(#arrow)');
      svg.append(path);
    }
  }

  // 节点与引用
  for (const hash of model.order) {
    const row = rowIndex.get(hash);
    const commit = model.commits.get(hash);
    const x = LEFT + laneOf.get(hash) * LANE;
    const y = TOP + row * ROW;
    const isHead = model.head.hash === hash;
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', `node${commit.merge ? ' merge' : ''}${isHead ? ' head' : ''}${model.highlight.has(hash) ? ' new' : ''}`);

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(NODE_W));
    rect.setAttribute('height', String(NODE_H));
    rect.setAttribute('rx', '6');
    group.append(rect);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(x + 8));
    label.setAttribute('y', String(y + 13));
    label.textContent = commit.short;
    group.append(label);

    const subject = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    subject.setAttribute('class', 'subject');
    subject.setAttribute('x', String(x + 8));
    subject.setAttribute('y', String(y + 25));
    subject.textContent = commit.subject.length > 24 ? `${commit.subject.slice(0, 23)}…` : commit.subject;
    group.append(subject);

    if (commit.merge) {
      const tag = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      tag.setAttribute('x', String(x + NODE_W - 6));
      tag.setAttribute('y', String(y + 13));
      tag.setAttribute('text-anchor', 'end');
      tag.setAttribute('fill', '#c79bff');
      tag.textContent = 'merge';
      group.append(tag);
    }
    svg.append(group);

    let offset = 0;
    for (const badge of model.refs.get(hash) ?? []) {
      const widthOf = charWidth(badge.label);
      const badgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      badgeGroup.setAttribute('class', `badge ${badge.kind}`);
      const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      box.setAttribute('x', String(x + NODE_W + 6 + offset));
      box.setAttribute('y', String(y + 7));
      box.setAttribute('width', String(widthOf));
      box.setAttribute('height', '16');
      box.setAttribute('rx', '8');
      badgeGroup.append(box);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(x + NODE_W + 6 + offset + widthOf / 2));
      text.setAttribute('y', String(y + 19));
      text.setAttribute('text-anchor', 'middle');
      text.textContent = badge.label;
      badgeGroup.append(text);
      svg.append(badgeGroup);
      offset += widthOf + 6;
    }
  }

  // 未出生的分支：HEAD 指着一个还不存在的提交
  if (model.head.unborn) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(centerX(0)));
    line.setAttribute('y1', '6');
    line.setAttribute('x2', String(centerX(0)));
    line.setAttribute('y2', String(TOP - 4));
    line.setAttribute('stroke', '#6ea8fe');
    line.setAttribute('stroke-dasharray', '3 3');
    svg.append(line);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(centerX(0) + 6));
    label.setAttribute('y', '14');
    label.setAttribute('fill', '#6ea8fe');
    label.textContent = `HEAD -> ${model.head.branch ?? 'main'}（还没有提交）`;
    svg.append(label);
  }

  container.append(svg);
}

/** 每条泳道记着“下一个该出现在这里的父提交”。 */
function assignLanes(model) {
  const laneOf = new Map();
  const lanes = [];
  for (const hash of model.order) {
    let lane = lanes.indexOf(hash);
    if (lane < 0) {
      lane = lanes.findIndex((entry) => entry === null);
      if (lane < 0) {
        lane = lanes.length;
        lanes.push(null);
      }
    }
    laneOf.set(hash, lane);
    lanes[lane] = null;
    const parents = model.commits.get(hash).parents;
    for (const [index, parent] of parents.entries()) {
      if (laneOf.has(parent) || lanes.includes(parent)) continue;
      let target = index === 0 ? lane : lanes.findIndex((entry) => entry === null);
      if (target < 0) {
        target = lanes.length;
        lanes.push(null);
      }
      lanes[target] = parent;
    }
  }
  return laneOf;
}

function laneCount(laneOf) {
  let max = 0;
  for (const lane of laneOf.values()) max = Math.max(max, lane);
  return max;
}
