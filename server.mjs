import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSnapshot } from './lib/codex-reader.mjs';
import { readOrganization, saveOrganization } from './lib/organization.mjs';

export const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ codexHome, currentPath = root, organizationFile = path.join(root, 'data/organization.json') } = {}) {
  let snapshot;
  const refresh = async () => (snapshot = await readSnapshot({ codexHome, currentPath }));
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const assets = new Map([
    ['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']],
    ['/tree.mjs', ['tree.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ]);
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    if (req.headers.host !== expectedHost ||
      (req.headers.origin && req.headers.origin !== `http://${expectedHost}`) ||
      req.headers['sec-fetch-site'] === 'cross-site')
      return json(res, 403, { error: '仅允许本机面板访问。' });
    try {
      const url = new URL(req.url, `http://${expectedHost}`);
      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        if (!snapshot || url.searchParams.get('refresh') === '1') await refresh();
        return json(res, 200, snapshot);
      }
      if (url.pathname === '/api/organization' && req.method === 'GET')
        return json(res, 200, readOrganization(organizationFile));
      if (url.pathname === '/api/organization' && req.method === 'PUT') {
        if (!req.headers['content-type']?.startsWith('application/json'))
          return json(res, 415, { error: '需要 JSON 格式。' });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          chunks.push(chunk);
          size += chunk.length;
          if (size > 1024 * 1024) return json(res, 413, { error: '分组数据过大。' });
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: '无效 JSON。' }); }
        try {
          return json(res, 200, saveOrganization(organizationFile, input, snapshot || await refresh()));
        } catch (error) { return json(res, error.status || 400, { error: error.message }); }
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(fs.readFileSync(path.join(root, 'dist', file)));
      }
      json(res, 404, { error: '未找到该页面或接口。' });
    } catch (error) {
      json(res, 500, { error: `读取失败：${error.message}` });
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 43127);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须在 1024–65535 之间。');
  const server = createApp();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用。可打开已有面板，或设置 PORT 使用其他端口。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`对话枝图已启动：http://127.0.0.1:${port}\n只读 Codex 元数据 · 按 Ctrl+C 停止`));
}
