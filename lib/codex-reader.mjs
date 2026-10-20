import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createZstdDecompress } from 'node:zlib';

export const plainPath = value => (value || '').replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '');
export const normalizePath = value => path.win32.normalize(plainPath(value)).replace(/\\+$/, '').toLowerCase();
const contains = (root, cwd) => cwd === root || cwd.startsWith(root + '\\');

// Read only the bounded first record. No conversation turns are parsed or returned.
export async function readSessionMeta(file, expectedId) {
  if (file.endsWith('.zst')) {
    const input = fs.createReadStream(file, { highWaterMark: 8192 });
    const decoder = createZstdDecompress();
    input.on('error', error => decoder.destroy(error));
    input.pipe(decoder);
    const parts = [];
    let length = 0;
    try {
      for await (const chunk of decoder) {
        const newline = chunk.indexOf(10);
        parts.push(newline < 0 ? chunk : chunk.subarray(0, newline));
        length += newline < 0 ? chunk.length : newline;
        if (length > 1024 * 1024) throw new Error('会话首行超过兼容范围');
        if (newline >= 0) break;
      }
      return parseMeta(Buffer.concat(parts), expectedId);
    } finally { input.destroy(); decoder.destroy(); }
  }
  const fd = fs.openSync(file, 'r');
  try {
    const chunks = [];
    let total = 0;
    let ended = false;
    while (total < 1024 * 1024) {
      const chunk = Buffer.alloc(4096);
      const size = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!size) { ended = true; break; }
      const newline = chunk.subarray(0, size).indexOf(10);
      chunks.push(chunk.subarray(0, newline < 0 ? size : newline));
      total += size;
      if (newline >= 0) { ended = true; break; }
    }
    if (!ended) throw new Error('会话首行超过兼容范围');
    return parseMeta(Buffer.concat(chunks), expectedId);
  } finally { fs.closeSync(fd); }
}
function parseMeta(buffer, expectedId) {
  const row = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  if (row.type !== 'session_meta' || row.payload?.id !== expectedId)
    throw new Error('会话元数据格式或 ID 不匹配');
  const parent = row.payload.forked_from_id;
  if (parent != null && typeof parent !== 'string') throw new Error('分叉来源字段格式不兼容');
  return { parentId: parent || null };
}

export function assignProject(thread, projects, aliases, assignments) {
  const findId = id => projects.find(p => p.id === (aliases.get(id) || id))?.id;
  if (thread.project_id) return findId(thread.project_id) || 'unassigned';
  const explicit = assignments[thread.id];
  if (explicit) return explicit.projectKind === 'local' ? findId(explicit.projectId) || 'unassigned' : 'unassigned';
  const cwd = normalizePath(thread.cwd);
  return projects.flatMap(p => p.roots.map(root => ({ id: p.id, root: normalizePath(root) })))
    .filter(p => p.root && contains(p.root, cwd))
    .sort((a, b) => b.root.length - a.root.length)[0]?.id || 'unassigned';
}

export async function readSnapshot({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), currentPath = process.cwd() } = {}) {
  const warnings = [];
  const stateFile = path.join(codexHome, '.codex-global-state.json');
  let state = {};
  if (fs.existsSync(stateFile)) {
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch { throw new Error('Codex 项目配置无法解析。请稍后刷新；应用不会覆盖该文件。'); }
  } else warnings.push('未发现旧版项目配置，正在使用数据库项目归属。');
  const dbNames = fs.readdirSync(codexHome).filter(x => /^state_\d+\.sqlite$/.test(x))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!dbNames.length) throw new Error('未找到 Codex 本地会话数据库，请确认 CODEX_HOME。');
  const db = new DatabaseSync(path.join(codexHome, dbNames[0]), { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 3000;');
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(x => x.name));
    const required = ['id', 'title', 'cwd', 'updated_at', 'archived', 'rollout_path', 'source'];
    if (required.some(x => !columns.has(x))) throw new Error('Codex 会话数据库格式不兼容：缺少必要元数据列。');
    const optional = name => columns.has(name) ? name : `NULL AS ${name}`;
    const rows = db.prepare(`SELECT id,title,cwd,updated_at,archived,rollout_path,source,
      ${optional('name')},${optional('project_id')},${optional('thread_source')}
      FROM threads ORDER BY updated_at DESC`).all()
      .filter(r => !r.source.startsWith('{') && !['subagent', 'guardian_review'].includes(r.thread_source));
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
    let projects = [];
    if (tables.has('projects') && tables.has('project_roots')) {
      const roots = db.prepare('SELECT project_id,path FROM project_roots ORDER BY position').all();
      projects = db.prepare('SELECT id,name FROM projects ORDER BY position').all().map(p => ({
        ...p, roots: roots.filter(r => r.project_id === p.id).map(r => r.path),
      }));
    }
    const aliases = new Map();
    const migration = state['app-server-project-id-by-legacy-project-id-by-host'] || {};
    const localMap = migration[`local:${codexHome}`] || {};
    for (const [oldId, newId] of Object.entries(localMap)) aliases.set(oldId, newId);
    for (const legacy of Object.values(state['local-projects'] || {})) {
      if (!legacy.id || !Array.isArray(legacy.rootPaths)) continue;
      const found = projects.find(p => p.id === aliases.get(legacy.id)) ||
        projects.find(p => p.roots.some(root => legacy.rootPaths.some(r => normalizePath(r) === normalizePath(root))));
      if (found) aliases.set(legacy.id, found.id);
      else projects.push({ id: legacy.id, name: legacy.name || legacy.rootPaths[0], roots: legacy.rootPaths });
    }
    projects.push({ id: 'unassigned', name: '未归属', roots: [] });
    let unread = 0;
    const threads = [];
    for (const row of rows) {
      let parentId = null;
      let metadataError = null;
      try {
        // The database is trusted only to point inside Codex session directories.
        const original = plainPath(row.rollout_path);
        const real = fs.realpathSync(fs.existsSync(original) ? original : `${original}.zst`);
        const allowed = ['sessions', 'archived_sessions'].some(dir => {
          const root = path.resolve(codexHome, dir);
          const rel = path.relative(root, real);
          return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
        });
        if (!allowed) throw new Error('元数据文件不在本机 Codex 会话目录中');
        ({ parentId } = await readSessionMeta(real, row.id));
      } catch (error) {
        unread++;
        metadataError = `分叉来源无法读取：${error.code === 'ENOENT' ? '会话元数据文件缺失' : error.message}`;
      }
      threads.push({
        id: row.id, title: row.name?.trim() || row.title?.trim() || '未命名对话',
        cwd: plainPath(row.cwd), updatedAt: row.updated_at * 1000, archived: Boolean(row.archived),
        projectId: assignProject(row, projects, aliases, state['thread-project-assignments'] || {}),
        parentId, metadataError,
      });
    }
    if (unread) warnings.push(`${unread} 个对话的分叉来源无法读取，已在节点上标记；未推测父子关系。`);
    for (const p of projects) {
      p.count = threads.filter(t => t.projectId === p.id && !t.archived).length;
      p.total = threads.filter(t => t.projectId === p.id).length;
    }
    const defaultProjectId = assignProject({ cwd: currentPath }, projects, aliases, {});
    return { projects, threads, defaultProjectId, readAt: new Date().toISOString(), warnings };
  } finally { db.close(); }
}
