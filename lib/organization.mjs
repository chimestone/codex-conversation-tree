import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const emptyOrganization = () => ({ version: 1, revision: 0, folders: [], assignments: {} });
export function validateOrganization(org) {
  if (!org || org.version !== 1 || !Number.isSafeInteger(org.revision) || org.revision < 0 ||
    !Array.isArray(org.folders) || org.folders.length > 2000 ||
    !org.assignments || typeof org.assignments !== 'object' || Array.isArray(org.assignments))
    throw new Error('分组数据格式不兼容');
  const map = new Map();
  for (const f of org.folders) {
    if (!f || typeof f.id !== 'string' || !/^[\w-]{1,100}$/.test(f.id) || map.has(f.id) ||
      typeof f.name !== 'string' || !f.name.trim() || f.name.length > 100 ||
      typeof f.projectId !== 'string' || !f.projectId ||
      !(f.parentId === null || typeof f.parentId === 'string')) throw new Error('文件夹字段无效或 ID 重复');
    map.set(f.id, f);
  }
  for (const f of org.folders) {
    const seen = new Set([f.id]);
    let current = f;
    while (current.parentId) {
      const parent = map.get(current.parentId);
      if (!parent || parent.projectId !== f.projectId || seen.has(parent.id)) throw new Error('文件夹父级缺失、跨项目或形成循环');
      seen.add(parent.id);
      current = parent;
    }
  }
  for (const [id, folder] of Object.entries(org.assignments)) {
    if (!/^[\w-]{1,100}$/.test(id) || typeof folder !== 'string' || !map.has(folder)) throw new Error('对话分组引用无效');
  }
  return org;
}
export function readOrganization(file) {
  if (!fs.existsSync(file)) return emptyOrganization();
  try { return validateOrganization(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { throw new Error(`人工分组文件读取失败，原文件已保留：${error.message}`); }
}
export function saveOrganization(file, incoming, snapshot) {
  validateOrganization(incoming);
  const previous = readOrganization(file);
  if (previous.revision !== incoming.revision) {
    const error = new Error('另一个面板已修改分组，请刷新后重试。');
    error.status = 409;
    throw error;
  }
  const folders = new Map(incoming.folders.map(f => [f.id, f]));
  const projects = new Set(snapshot.projects.map(p => p.id));
  if (incoming.folders.some(f => !projects.has(f.projectId))) throw new Error('目标项目不存在，请刷新。');
  for (const t of snapshot.threads) {
    const folder = folders.get(incoming.assignments[t.id]);
    if (folder && folder.projectId !== t.projectId) throw new Error('不能将对话移到其他项目的文件夹。');
  }
  const saved = { version: 1, revision: previous.revision + 1,
    folders: incoming.folders.map(({ id, name, projectId, parentId }) => ({ id, name: name.trim(), projectId, parentId })),
    assignments: { ...incoming.assignments } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return saved;
}
