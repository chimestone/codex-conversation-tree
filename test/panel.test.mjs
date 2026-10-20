import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { buildForest, filterForest, groupedForest, layoutRightwardForest } from '../dist/tree.mjs';
import { readSnapshot, readSessionMeta, assignProject, normalizePath } from '../lib/codex-reader.mjs';
import { readOrganization, saveOrganization, emptyOrganization } from '../lib/organization.mjs';
import { createApp } from '../server.mjs';

const thread = (id, parentId = null, extra = {}) => ({
  id, parentId, projectId: 'p', title: id, updatedAt: 1, archived: false, ...extra,
});
const flatten = roots => roots.flatMap(n => [n, ...flatten(n.children)]);

test('rightward layout places children after parents, prevents sibling overlaps and handles collapse', () => {
  const forest = buildForest([thread('r'), thread('a', 'r'), thread('b', 'r'), thread('leaf', 'a'), thread('other')], 'p');
  const layout = layoutRightwardForest(forest);
  assert.equal(layout.nodes.length, 5);
  for (const edge of layout.edges) assert.ok(edge.parent.x + layout.cardWidth < edge.child.x);
  for (const a of layout.nodes) for (const b of layout.nodes) {
    if (a !== b && a.depth === b.depth) assert.ok(Math.abs(a.y - b.y) >= layout.cardHeight);
  }
  assert.equal(layoutRightwardForest(forest, { collapsed: new Set(['r']) }).nodes.length, 2);
  assert.equal(layoutRightwardForest(forest, { collapsed: new Set(['r']), searching: true }).nodes.length, 5);
});

test('multiple roots, repeated titles, three levels and ancestor-preserving search', () => {
  const forest = buildForest([thread('root'), thread('child', 'root'), thread('leaf', 'child', { title: '中文目标' }),
    thread('other', null, { title: '中文目标' })], 'p');
  assert.equal(forest.length, 2);
  const result = filterForest(forest, '中文');
  assert.equal(flatten(result).length, 4);
  assert.equal(result.find(n => n.id === 'root').children[0].children[0].id, 'leaf');
  assert.deepEqual(filterForest(forest, '不存在'), []);
});
test('missing, external and hidden archived parents have explicit notices', () => {
  const threads = [thread('missing', 'unknown'), thread('outside', null, { projectId: 'q' }),
    thread('cross', 'outside'), thread('archived', null, { archived: true }), thread('child', 'archived')];
  const roots = buildForest(threads, 'p');
  assert.match(roots.find(n => n.id === 'missing').notice, /缺失/);
  assert.match(roots.find(n => n.id === 'cross').notice, /其他项目/);
  assert.match(roots.find(n => n.id === 'child').notice, /归档/);
  assert.equal(buildForest(threads, 'p', true).find(n => n.id === 'archived').children[0].id, 'child');
});
test('cycles and self loops retain all nodes without recursive failure', () => {
  const forest = buildForest([thread('a', 'b'), thread('b', 'a'), thread('self', 'self'), thread('c', 'b')], 'p');
  assert.equal(flatten(forest).length, 4);
  assert.equal(flatten(forest).filter(n => n.notice.includes('循环')).length, 2);
});
test('explicit project membership wins over longest directory match; path prefixes are normalized', () => {
  const projects = [{ id: 'p', roots: ['D:\\中文'] }, { id: 'q', roots: ['D:\\中文\\子项目'] }];
  assert.equal(assignProject({ id: 'a', cwd: 'D:\\中文\\子项目\\src' }, projects, new Map(), {}), 'q');
  assert.equal(assignProject({ id: 'a', project_id: 'p', cwd: 'D:\\中文\\子项目' }, projects, new Map(), {}), 'p');
  assert.equal(assignProject({ id: 'a', cwd: 'D:\\中文2' }, projects, new Map(), {}), 'unassigned');
  assert.equal(assignProject({ id: 'a', cwd: 'D:\\中文' }, projects, new Map([['legacy', 'q']]),
    { a: { projectKind: 'local', projectId: 'legacy' } }), 'q');
  assert.equal(normalizePath('\\\\?\\D:\\中文\\'), normalizePath('d:\\中文'));
});
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tree-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), '{}');
  const dbfile = path.join(home, 'state_5.sqlite');
  const db = new DatabaseSync(dbfile);
  db.exec(`CREATE TABLE threads(id TEXT,title TEXT,name TEXT,cwd TEXT,updated_at INTEGER,archived INTEGER,
    rollout_path TEXT,source TEXT,thread_source TEXT,project_id TEXT);
    CREATE TABLE projects(id TEXT,name TEXT,position INTEGER);
    CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER);`);
  db.prepare('INSERT INTO projects VALUES (?,?,?)').run('p', '测试项目', 0);
  db.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('p', 'D:\\测试项目', 0);
  const insert = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const [id, parent, source] of [['root', null, 'vscode'], ['child', 'root', 'vscode'], ['internal', null, '{"subagent":{}}']]) {
    const file = path.join(sessions, `${id}.jsonl`);
    const meta = JSON.stringify({ type: 'session_meta', payload: { id, forked_from_id: parent } });
    // The invalid second line ensures the adapter never parses chat content.
    const data = meta + '\nTHIS IS NOT VALID JSON CONVERSATION CONTENT\n';
    if (id === 'child') fs.writeFileSync(file + '.zst', zstdCompressSync(data));
    else fs.writeFileSync(file, data);
    insert.run(id, '旧标题', id === 'child' ? '中文分支' : '根对话', 'D:\\测试项目', 100, 0, file, source, 'user', null);
  }
  db.close();
  return { home, dbfile };
}
test('plain/compressed metadata, source titles, internal exclusion and no source writes', async t => {
  const { home, dbfile } = fixture(t);
  const hash = () => createHash('sha256').update(fs.readFileSync(dbfile)).digest('hex');
  const before = hash();
  const snapshot = await readSnapshot({ codexHome: home, currentPath: 'D:\\测试项目' });
  assert.equal(snapshot.threads.length, 2);
  assert.equal(snapshot.defaultProjectId, 'p');
  assert.equal(snapshot.threads.find(t => t.id === 'child').parentId, 'root');
  assert.equal(snapshot.threads.find(t => t.id === 'child').title, '中文分支');
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(hash(), before);
  await assert.rejects(readSessionMeta(path.join(home, 'sessions/root.jsonl'), 'wrong'), /不匹配/);
});
test('missing metadata reports uncertainty, incompatible database fails clearly', async t => {
  const { home } = fixture(t);
  fs.unlinkSync(path.join(home, 'sessions/root.jsonl'));
  const snapshot = await readSnapshot({ codexHome: home });
  assert.match(snapshot.threads.find(t => t.id === 'root').metadataError, /缺失/);
  const db = new DatabaseSync(path.join(home, 'state_6.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT)'); db.close();
  await assert.rejects(readSnapshot({ codexHome: home }), /不兼容/);
});
test('organization persists, rejects cycles and stale updates, does not change real branches', t => {
  const { home } = fixture(t);
  const file = path.join(home, 'organization.json');
  const threads = [thread('root'), thread('child', 'root')];
  const snapshot = { threads, projects: [{ id: 'p' }] };
  const originalTree = JSON.stringify(buildForest(threads, 'p'));
  const input = emptyOrganization();
  input.folders = [{ id: 'f', name: '计划', projectId: 'p', parentId: null },
    { id: 'g', name: '子组', projectId: 'p', parentId: 'f' }];
  input.assignments.child = 'g';
  const saved = saveOrganization(file, input, snapshot);
  assert.equal(readOrganization(file).assignments.child, 'g');
  assert.equal(groupedForest(threads, 'p', saved)[0].children[0].children[0].id, 'child');
  assert.equal(JSON.stringify(buildForest(threads, 'p')), originalTree);
  assert.throws(() => saveOrganization(file, input, snapshot), /另一个面板/);
  const bad = structuredClone(saved);
  bad.folders[0].parentId = 'g';
  assert.throws(() => saveOrganization(file, bad, snapshot), /循环/);
  // Delete parent: keep child folder and dialogue in it.
  saved.folders = saved.folders.filter(f => f.id !== 'f');
  saved.folders[0].parentId = null;
  saveOrganization(file, saved, snapshot);
  assert.equal(readOrganization(file).assignments.child, 'g');
  fs.writeFileSync(file, 'broken');
  assert.throws(() => readOrganization(file), /原文件已保留/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
});
test('HTTP API serves panel, rejects foreign origins and limits mutations to organization', async t => {
  const { home } = fixture(t);
  const server = createApp({ codexHome: home, currentPath: 'D:\\测试项目', organizationFile: path.join(home, 'organization.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url)).status, 200);
  const snapshot = await (await fetch(url + '/api/snapshot')).json();
  assert.equal(snapshot.threads.length, 2);
  assert.equal((await fetch(url + '/api/snapshot', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(url + '/api/snapshot', { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(url + '/api/organization', { method: 'PUT', body: '{}' })).status, 415);
  const org = await (await fetch(url + '/api/organization')).json();
  org.folders.push({ id: 'f', name: '中文文件夹', parentId: null, projectId: 'p' });
  const response = await fetch(url + '/api/organization', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(org),
  });
  assert.equal(response.status, 200);
  assert.equal((await (await fetch(url + '/api/organization')).json()).folders[0].name, '中文文件夹');
});
