import { buildForest, filterForest, groupedForest, layoutRightwardForest } from './tree.mjs';
const $ = id => document.getElementById(id);
let snapshot, organization, projectId, view = 'real', selected = null, collapsed = new Set(), lastForest = [];
let folderEditing = null, deleteId = null, saving = false;
let graphLayout, zoom = 1, fitPending = true;
const date = (value, short = false) => new Intl.DateTimeFormat('zh-CN', short
  ? { month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }
  : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date(value));
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
// Use one themed picker for project selection and folder selection.
// The native select remains the data source, never the system popup.
const pickers = new WeakMap();
function enhanceSelect(select) {
  if (pickers.has(select)) { pickers.get(select)(); return; }
  const host = element('div', null, 'picker');
  const trigger = element('button', null, 'picker-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', select.getAttribute('aria-label') || select.closest('label')?.childNodes[0]?.textContent || '选择文件夹');
  const menu = element('div', null, 'picker-menu');
  menu.hidden = true;
  const search = element('input', null, 'picker-search');
  search.type = 'search';
  search.placeholder = '输入名称筛选…';
  search.setAttribute('aria-label', '筛选选项');
  const list = element('div', null, 'picker-list');
  list.setAttribute('role', 'listbox');
  list.id = 'picker-' + (select.id || crypto.randomUUID());
  trigger.setAttribute('aria-controls', list.id);
  menu.append(search, list);
  select.before(host);
  host.append(select, trigger, menu);
  select.classList.add('native-picker');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
  const draw = () => {
    list.replaceChildren();
    for (const option of [...select.options].filter(o => o.textContent.toLowerCase().includes(search.value.toLowerCase()))) {
      const item = element('button', null, 'picker-option');
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', option.selected);
      item.append(element('span', option.textContent), element('span', option.selected ? '✓' : '', 'picker-check'));
      item.onclick = () => {
        select.value = option.value;
        close(); select.dispatchEvent(new Event('change', { bubbles: true }));
        sync(); trigger.focus();
      };
      item.onkeydown = event => {
        const items = [...list.children];
        const index = items.indexOf(item);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
        }
      };
      list.append(item);
    }
    if (!list.children.length) list.append(element('p', '没有匹配的项目或文件夹', 'picker-empty'));
  };
  const sync = () => {
    trigger.replaceChildren(element('span', select.selectedOptions[0]?.textContent || '请选择'), element('span', '⌄', 'picker-chevron'));
    trigger.disabled = select.disabled;
    if (!menu.hidden) draw();
  };
  trigger.onclick = () => {
    if (!menu.hidden) { close(); return; }
    menu.hidden = false; search.value = ''; draw();
    trigger.setAttribute('aria-expanded', 'true'); search.focus();
  };
  trigger.onkeydown = event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); trigger.click(); }
  };
  search.oninput = draw;
  search.onkeydown = event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('button')?.focus(); }
  };
  host.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); }
  };
  host.addEventListener('focusout', event => { if (!host.contains(event.relatedTarget)) close(); });
  // One listener per picker, automatically removed when dynamically rebuilt.
  const controller = new AbortController();
  document.addEventListener('pointerdown', event => {
    if (!host.isConnected) { controller.abort(); return; }
    if (!host.contains(event.target)) close();
  }, { signal: controller.signal });
  pickers.set(select, sync); sync();
}
async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function showError(text) { $('error').textContent = text; $('error').hidden = !text; }
let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').hidden = true, 3500);
}
async function load() {
  $('refresh').disabled = true;
  showError('');
  try {
    const next = await api('/api/snapshot?refresh=1');
    snapshot = next;
    if (!projectId || !snapshot.projects.some(p => p.id === projectId)) projectId = snapshot.defaultProjectId;
    $('project').replaceChildren(...snapshot.projects.map(p => {
      const option = element('option', `${p.name} · ${p.count}`);
      option.value = p.id;
      return option;
    }));
    $('project').value = projectId;
    $('project').disabled = false;
    enhanceSelect($('project'));
    $('warnings').textContent = snapshot.warnings.join(' ');
    $('warnings').hidden = !snapshot.warnings.length;
    $('read-time').textContent = '读取于 ' + date(snapshot.readAt) + '（北京时间）';
    try { organization = await api('/api/organization'); }
    catch (error) { organization = null; showError(error.message + '。真实分支仍可查看，分组编辑已禁用。'); }
    render();
  } catch (error) {
    showError(error.message + (snapshot ? '。下方保留上次读取的数据。' : '。请检查服务和数据目录，然后刷新重试。'));
    if (!snapshot) {
      $('root-title').textContent = '数据暂不可用';
      $('root-path').textContent = '请查看上方错误提示';
    }
  } finally { $('refresh').disabled = false; }
}
function render() {
  if (!snapshot) return;
  const project = snapshot.projects.find(p => p.id === projectId);
  const showArchived = $('archive').checked;
  const threads = snapshot.threads.filter(t => t.projectId === projectId && (showArchived || !t.archived));
  $('thread-count').textContent = threads.length;
  $('branch-count').textContent = threads.filter(t => t.parentId).length;
  $('root-title').textContent = project.name;
  $('root-path').textContent = project.roots.join(' · ') || '没有可确认的项目归属';
  $('real-tab').setAttribute('aria-selected', view === 'real');
  $('group-tab').setAttribute('aria-selected', view === 'groups');
  $('new-folder').hidden = view !== 'groups';
  $('new-folder').disabled = !organization || saving;
  $('view-caption').textContent = view === 'real' ? '根在左侧，分支向右延伸' : '自由整理，不改变真实分叉来源';
  const forest = view === 'real' ? buildForest(snapshot.threads, projectId, showArchived)
    : organization ? groupedForest(snapshot.threads, projectId, organization, showArchived) : [];
  lastForest = forest;
  const search = $('search').value;
  const filtered = filterForest(forest, search);
  drawGraph(filtered, Boolean(search.trim()), project.name);
  $('graph-viewport').hidden = !filtered.length;
  $('empty').hidden = Boolean(filtered.length);
  $('empty').querySelector('h2').textContent = view === 'groups' && !organization ? '分组数据无法读取'
    : search ? '没有找到匹配的标题' : '这里还没有对话';
  $('empty').querySelector('p').textContent = view === 'groups' && !organization ? '请查看错误提示，修复后刷新。'
    : search ? '试试更短的关键词，或切换项目。' : view === 'groups' ? '可以先新建文件夹，或在 Codex 中开始一个对话。'
    : '在 Codex 中开始一个对话，再回来刷新。';
  renderDetails();
}
function drawGraph(roots, searching, projectName) {
  graphLayout = layoutRightwardForest(roots, { collapsed, searching });
  const { width, height, cardWidth, cardHeight, nodes, edges, project } = graphLayout;
  const stage = $('tree');
  stage.replaceChildren();
  stage.style.width = width + 'px'; stage.style.height = height + 'px';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width); svg.setAttribute('height', height);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('graph-lines');
  for (const edge of edges) {
    const line = document.createElementNS(svg.namespaceURI, 'path');
    const start = edge.parent, end = edge.child;
    const middle = (start.x + cardWidth + end.x) / 2;
    line.setAttribute('d', `M ${start.x + cardWidth} ${start.y + cardHeight / 2} C ${middle} ${start.y + cardHeight / 2}, ${middle} ${end.y + cardHeight / 2}, ${end.x} ${end.y + cardHeight / 2}`);
    line.setAttribute('class', edge.project ? 'project-link' : 'branch-link');
    svg.append(line);
  }
  stage.append(svg);
  const place = (el, point) => {
    el.style.left = point.x + 'px';
    el.style.top = point.y + 'px';
    el.style.width = cardWidth + 'px';
    el.style.height = cardHeight + 'px';
    stage.append(el);
  };
  const rootCard = element('div', null, 'graph-project');
  rootCard.append(element('span', '▧  项目', 'graph-kicker'), element('strong', projectName), element('small', '项目归属 · 非分叉节点'));
  place(rootCard, project);
  for (const positioned of nodes) {
    const node = positioned.node;
    const row = element('div', null, 'graph-card' + (selected?.id === node.id ? ' selected' : '') + (node.kind === 'folder' ? ' folder-card' : ''));
    const toggle = element('button', collapsed.has(node.id) && !searching ? '+' : '−', 'graph-toggle');
    toggle.type = 'button';
    if (node.children.length) {
      toggle.setAttribute('aria-label', `展开或折叠 ${node.title}`);
      toggle.setAttribute('aria-expanded', searching || !collapsed.has(node.id));
      toggle.disabled = searching;
      toggle.onclick = () => { collapsed.has(node.id) ? collapsed.delete(node.id) : collapsed.add(node.id); render(); };
    } else { toggle.hidden = true; }
    const button = element('button', null, 'graph-select');
    button.type = 'button';
    button.setAttribute('aria-pressed', selected?.id === node.id ? 'true' : 'false');
    button.title = node.title + (node.notice ? '\n' + node.notice : '');
    button.append(element('span', node.kind === 'folder' ? '▧  文件夹' : node.parentId ? '⑂  分支对话' : '◉  独立对话', 'graph-kicker'));
    button.append(element('span', node.title, 'graph-title' + (node.match ? ' matched' : '')));
    const meta = node.notice ? '⚠ ' + node.notice : node.kind === 'folder'
      ? `${node.children.length} 个直接子节点` : `${date(node.updatedAt, true)} 更新${node.archived ? ' · 已归档' : ''}`;
    button.append(element('span', meta, 'graph-meta' + (node.notice ? ' has-notice' : '')));
    button.onclick = () => { selected = { id: node.id, kind: node.kind || 'thread' }; render(); };
    row.append(button, toggle);
    place(row, positioned);
  }
  applyZoom();
  if (fitPending) requestAnimationFrame(() => { if (fitPending) fitGraph(); });
}
function applyZoom() {
  if (!graphLayout) return;
  $('tree').style.transform = `scale(${zoom})`;
  $('graph-space').style.width = graphLayout.width * zoom + 'px';
  $('graph-space').style.height = graphLayout.height * zoom + 'px';
  $('zoom-label').textContent = Math.round(zoom * 100) + '%';
}
function fitGraph() {
  if (!graphLayout || $('graph-viewport').hidden) return;
  const viewport = $('graph-viewport');
  zoom = Math.max(.25, Math.min(1, (viewport.clientWidth - 20) / graphLayout.width, (viewport.clientHeight - 20) / graphLayout.height));
  applyZoom(); viewport.scrollLeft = 0; viewport.scrollTop = 0;
  fitPending = false;
}
function addDetail(dl, title, value, code = false) {
  dl.append(element('dt', title));
  const dd = element('dd');
  dd.append(element(code ? 'code' : 'span', value));
  dl.append(dd);
}
function folderOptions(select, selectedValue = '', excluding = null) {
  select.replaceChildren();
  const option = element('option', '项目根目录（不分组）');
  option.value = '';
  select.append(option);
  const folders = organization?.folders.filter(f => f.projectId === projectId) || [];
  const isDescendant = f => {
    let current = f;
    while (current) {
      if (current.id === excluding) return true;
      current = folders.find(p => p.id === current.parentId);
    }
    return false;
  };
  const folderPath = f => {
    const parts = [f.name];
    let parent = folders.find(p => p.id === f.parentId);
    while (parent) { parts.unshift(parent.name); parent = folders.find(p => p.id === parent.parentId); }
    return parts.join(' / ');
  };
  for (const f of folders.filter(f => !isDescendant(f)).sort((a, b) => folderPath(a).localeCompare(folderPath(b), 'zh-CN'))) {
    const o = element('option', folderPath(f));
    o.value = f.id;
    select.append(o);
  }
  select.value = selectedValue || '';
  if (select.isConnected) enhanceSelect(select);
}
function renderDetails() {
  const panel = $('details');
  panel.replaceChildren();
  const folder = selected?.kind === 'folder' ? organization?.folders.find(f => f.id === selected.id) : null;
  const thread = selected?.kind === 'thread' ? snapshot.threads.find(t => t.id === selected.id) : null;
  if (!folder && !thread) {
    const blank = element('div', null, 'detail-placeholder');
    blank.append(element('span', '↖'), element('h2', '沿着思路，继续探索'), element('p', '选择一个对话，查看来源、更新时间与所在目录。'));
    panel.append(blank); return;
  }
  panel.append(element('span', folder ? 'MY COLLECTION' : 'CONVERSATION DETAILS', 'detail-kicker'));
  panel.append(element('h2', folder?.name || thread.title));
  if (folder) {
    panel.append(element('p', '个人整理文件夹。此处的移动不会影响对话的真实分叉来源。'));
    const edit = element('button', '编辑名称与上级', 'button');
    edit.disabled = saving;
    edit.onclick = () => openFolder(folder);
    const remove = element('button', '删除文件夹', 'button danger');
    remove.disabled = saving;
    remove.onclick = () => { deleteId = folder.id; $('delete-dialog').showModal(); };
    panel.append(edit, remove);
    return;
  }
  const dl = element('dl');
  addDetail(dl, '更新时间', date(thread.updatedAt) + '（北京时间）');
  addDetail(dl, '所在目录', thread.cwd);
  const parent = snapshot.threads.find(t => t.id === thread.parentId);
  addDetail(dl, '分叉来源', thread.metadataError || (thread.parentId
    ? (parent?.title || '来源对话未找到') + ' · ' + thread.parentId : '没有记录分叉来源'));
  addDetail(dl, '归档状态', thread.archived ? '已归档' : '未归档');
  addDetail(dl, '对话 ID', thread.id, true);
  panel.append(dl);
  const copy = element('button', '复制对话 ID', 'button');
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(thread.id); toast('已复制对话 ID'); }
    catch { toast('无法访问剪贴板，请选中上方 ID 手动复制'); }
  };
  panel.append(copy);
  if (view === 'groups' && organization) {
    const label = element('label', '移入文件夹');
    const select = element('select');
    select.setAttribute('aria-label', '移入文件夹');
    select.disabled = saving;
    folderOptions(select, organization.assignments[thread.id]);
    select.onchange = () => mutate(next => {
      if (select.value) next.assignments[thread.id] = select.value;
      else delete next.assignments[thread.id];
    }, '已更新分组');
    label.append(select);
    panel.append(label);
    enhanceSelect(select);
  }
}
async function mutate(change, message) {
  if (!organization || saving) return false;
  const next = structuredClone(organization);
  change(next);
  saving = true;
  render();
  try {
    organization = await api('/api/organization', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    showError(''); toast(message);
    return true;
  } catch (error) { showError(error.message); return false; }
  finally { saving = false; render(); }
}
function openFolder(folder = null) {
  if (!organization) return;
  folderEditing = folder?.id || null;
  $('folder-dialog-title').textContent = folder ? '编辑文件夹' : '新建文件夹';
  $('folder-name').value = folder?.name || '';
  folderOptions($('folder-parent'), folder?.parentId || (selected?.kind === 'folder' ? selected.id : ''), folder?.id);
  $('folder-error').textContent = '';
  $('folder-dialog').showModal();
  $('folder-name').focus();
}
$('folder-form').onsubmit = async event => {
  event.preventDefault();
  const name = $('folder-name').value.trim();
  if (!name) { $('folder-error').textContent = '请输入文件夹名称。'; return; }
  const parentId = $('folder-parent').value || null;
  const id = folderEditing || crypto.randomUUID();
  const success = await mutate(next => {
    if (folderEditing) Object.assign(next.folders.find(f => f.id === folderEditing), { name, parentId });
    else next.folders.push({ id, name, parentId, projectId });
  }, folderEditing ? '文件夹已更新' : '文件夹已创建');
  if (success) { $('folder-dialog').close(); selected = { id, kind: 'folder' }; render(); }
  else $('folder-error').textContent = $('error').textContent;
};
$('folder-cancel').onclick = () => $('folder-dialog').close();
$('delete-cancel').onclick = () => $('delete-dialog').close();
$('delete-confirm').onclick = async () => {
  const folder = organization.folders.find(f => f.id === deleteId);
  if (!folder) return;
  const success = await mutate(next => {
    next.folders = next.folders.filter(f => f.id !== folder.id);
    next.folders.forEach(f => { if (f.parentId === folder.id) f.parentId = folder.parentId; });
    for (const [thread, target] of Object.entries(next.assignments)) {
      if (target !== folder.id) continue;
      if (folder.parentId) next.assignments[thread] = folder.parentId;
      else delete next.assignments[thread];
    }
  }, '文件夹已删除，对话已保留');
  if (success) { $('delete-dialog').close(); selected = null; render(); }
};
$('refresh').onclick = load;
$('project').onchange = () => { projectId = $('project').value; selected = null; collapsed.clear(); fitPending = true; render(); };
$('real-tab').onclick = () => { view = 'real'; selected = null; collapsed.clear(); fitPending = true; render(); };
$('group-tab').onclick = () => { view = 'groups'; selected = null; collapsed.clear(); fitPending = true; render(); };
$('search').oninput = () => { fitPending = true; render(); };
$('archive').onchange = () => { selected = null; render(); };
$('new-folder').onclick = () => openFolder();
$('expand').onclick = () => { collapsed.clear(); render(); };
$('collapse').onclick = () => {
  const walk = nodes => nodes.forEach(n => { if (n.children.length) collapsed.add(n.id); walk(n.children); });
  walk(lastForest); render();
};
$('zoom-fit').onclick = fitGraph;
for (const [id, delta] of [['zoom-in', .15], ['zoom-out', -.15]]) {
  $(id).onclick = () => {
    fitPending = false;
    zoom = Math.max(.1, Math.min(5, zoom + delta));
    applyZoom();
  };
}
// Scrollbars change the viewport dimensions too. Refitting on every resize
// used to cancel manual zoom as soon as the graph overflowed.
new ResizeObserver(() => { if (graphLayout && fitPending) fitGraph(); }).observe($('graph-viewport'));
load();
