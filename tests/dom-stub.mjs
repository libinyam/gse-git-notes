/**
 * 一个够用的 DOM 桩：web/app.js 只用到按 id 取元素、建元素、挂事件这几件事，
 * 所以不必引入 jsdom 也能在 Node 里跑通交互路径。
 */

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.textContent = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.selected = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.classList = {
      add: (name) => this._classes.add(name),
      remove: (name) => this._classes.delete(name),
      toggle: (name, force) => {
        const on = force ?? !this._classes.has(name);
        if (on) this._classes.add(name);
        else this._classes.delete(name);
      },
      contains: (name) => this._classes.has(name),
    };
    this._classes = new Set();
    this.dataset = {};
    this.listeners = new Map();
    this._html = '';
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(value) {
    this._html = String(value);
    // app.js 用 innerHTML 给终端行上色；桩里留一份去标签、还原实体的文本便于断言
    this.textContent = this._html
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  get options() {
    return this.children.filter((child) => child.tagName === 'OPTION');
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined || node === '') continue;
      if (typeof node === 'string') this.textContent += node;
      else this.children.push(node);
    }
  }

  before(node) {
    this.children.unshift(node);
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._html = '';
    this.textContent = '';
    this.append(...nodes);
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  focus() {}

  /** Depth-first search for the first descendant matching a simple selector. */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const wantClasses = selector.startsWith('.') ? selector.slice(1).split('.') : null;
    const wantTag = wantClasses ? null : selector.toUpperCase();
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        const matches = wantClasses ? wantClasses.every((name) => child._classes.has(name)) : child.tagName === wantTag;
        if (matches) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  /** Everything under this element, as text — enough for assertions. */
  get text() {
    let text = this.textContent;
    for (const child of this.children) text += `${child.text}\n`;
    return text;
  }
}

export function createDom() {
  const byId = new Map();
  const tabs = ['objects', 'refs', 'reflog'].map((name) => {
    const tab = new Element('button');
    tab.className = `tab${name === 'objects' ? ' active' : ''}`;
    tab.dataset.tab = name;
    return tab;
  });

  const document = {
    createElement: (tag) => new Element(tag),
    createElementNS: (_ns, tag) => new Element(tag),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, new Element('div'));
      return byId.get(id);
    },
    querySelectorAll: (selector) => (selector === '.tab' ? tabs : []),
  };

  const window = {
    addEventListener: () => {},
    document,
  };

  const location = { search: '' };

  return { document, window, location, element: (id) => document.getElementById(id), tabs };
}
