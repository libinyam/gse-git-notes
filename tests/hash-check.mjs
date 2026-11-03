import { ObjectStore, buildTree, buildCommit } from '../src/engine/objects.js';

const store = new ObjectStore();
console.log('blob  hello  ->', store.write('blob', 'hello\n'));
const blob = store.write('blob', 'hello\n');
const tree = buildTree(store, [{ mode: '100644', name: 'a.txt', hash: blob }]);
console.log('tree          ->', tree.hash);
const ident = (ts) => ({ name: 'Git Learner', email: 'learner@example.com', timestamp: ts, tz: '+0800' });
const commit = buildCommit(store, {
  tree: tree.hash,
  parents: [],
  author: ident(1700004800),
  committer: ident(1700004801),
  message: 'first\n',
});
console.log('commit        ->', commit);
