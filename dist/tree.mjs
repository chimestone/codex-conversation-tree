// Shared, deterministic model for the browser and fixture tests.
export function buildForest(threads, projectId, showArchived = false) {
  const all = new Map(threads.map(t => [t.id, t]));
  const nodes = new Map(threads.filter(t => t.projectId === projectId && (showArchived || !t.archived))
    .map(t => [t.id, { ...t, children: [], displayParentId: null, notice: t.metadataError || '' }]));
  for (const node of nodes.values()) {
    if (!node.parentId) continue;
    const parent = all.get(node.parentId);
    if (!parent) node.notice = '来源对话缺失 · ' + node.parentId;
    else if (parent.projectId !== projectId) node.notice = '来源位于其他项目 · ' + parent.title;
    else if (!nodes.has(parent.id)) node.notice = '来源已归档，当前隐藏 · ' + parent.title;
    else node.displayParentId = parent.id;
  }
  // Break one link per cycle, without altering the recorded relationship.
  const done = new Set();
  for (const node of nodes.values()) {
    const trail = new Set();
    let cursor = node;
    while (cursor && !done.has(cursor.id)) {
      if (trail.has(cursor.id)) {
        cursor.displayParentId = null;
        cursor.notice = '检测到循环关系，已断开显示连线';
        break;
      }
      trail.add(cursor.id);
      cursor = nodes.get(cursor.displayParentId);
    }
    for (const id of trail) done.add(id);
  }
  const roots = [];
  for (const node of nodes.values()) {
    if (node.displayParentId) nodes.get(node.displayParentId).children.push(node);
    else roots.push(node);
  }
  const sort = list => {
    list.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    list.forEach(n => sort(n.children));
  };
  sort(roots);
  return roots;
}

export function filterForest(roots, query) {
  const key = query.trim().toLocaleLowerCase();
  if (!key) return roots;
  return roots.flatMap(node => {
    const children = filterForest(node.children, key);
    const match = node.title.toLocaleLowerCase().includes(key);
    return match || children.length ? [{ ...node, children, match }] : [];
  });
}

export function groupedForest(threads, projectId, organization, showArchived = false) {
  const folders = organization.folders.filter(f => f.projectId === projectId);
  const map = new Map(folders.map(f => [f.id, { ...f, title: f.name, kind: 'folder', children: [] }]));
  const roots = [];
  for (const f of folders) {
    const n = map.get(f.id);
    if (f.parentId && map.has(f.parentId)) map.get(f.parentId).children.push(n);
    else roots.push(n);
  }
  const loose = [];
  for (const t of threads.filter(t => t.projectId === projectId && (showArchived || !t.archived))) {
    const folder = map.get(organization.assignments[t.id]);
    const node = { ...t, children: [], notice: t.metadataError || '' };
    if (folder) folder.children.push(node); else loose.push(node);
  }
  const sort = nodes => {
    nodes.sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) ||
      (a.kind === 'folder' ? a.title.localeCompare(b.title, 'zh-CN') : b.updatedAt - a.updatedAt));
    nodes.forEach(n => sort(n.children));
  };
  sort(roots);
  return [...roots, ...loose];
}

// Fixed-size cards laid out from the project root to the right. Siblings occupy
// disjoint leaf spans, so a wide subtree cannot overlap its neighbours.
export function layoutRightwardForest(roots, { collapsed = new Set(), searching = false } = {}) {
  const cardWidth = 172, cardHeight = 84, gap = 26, step = 238, padding = 30;
  let leaf = 0, maxDepth = 0;
  const nodes = [], edges = [];
  function place(node, depth) {
    maxDepth = Math.max(maxDepth, depth);
    const children = searching || !collapsed.has(node.id) ? node.children : [];
    const childNodes = children.map(child => place(child, depth + 1));
    const y = childNodes.length ? (childNodes[0].y + childNodes.at(-1).y) / 2
      : padding + leaf++ * (cardHeight + gap);
    const positioned = { node, x: padding + depth * step, y, depth, hasChildren: node.children.length > 0 };
    nodes.push(positioned);
    childNodes.forEach(child => edges.push({ parent: positioned, child, project: false }));
    return positioned;
  }
  const rootNodes = roots.map(node => place(node, 1));
  const width = maxDepth * step + cardWidth + padding * 2;
  const height = Math.max(cardHeight + padding * 2, leaf * (cardHeight + gap) - gap + padding * 2);
  const project = { x: padding, y: rootNodes.length ? (rootNodes[0].y + rootNodes.at(-1).y) / 2 : padding, depth: 0 };
  rootNodes.forEach(child => edges.push({ parent: project, child, project: true }));
  return { width, height, nodes, edges, project, cardWidth, cardHeight };
}
