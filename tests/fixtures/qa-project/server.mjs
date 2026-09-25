import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
const handler = (req, res) => {
  if (req.url === '/status/401') {
    res.writeHead(401).end('Authentication required');
    return;
  }
  if (req.url === '/status/503') {
    res.writeHead(503).end('Intentional QA failure');
    return;
  }
  res
    .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width"><title>Docker2Web 测试项目</title><body style="font-family:system-ui;padding:40px;background:#edf5ef;color:#174d3c"><h1>Docker2Web 测试项目 ✓</h1><p>服务：${process.env.QA_SERVICE || 'web'}</p><p>这是独立测试容器，不包含业务数据。</p><p>请求域名：${String(req.headers.host).replace(/[<>&"']/g, '')}</p><a href="/status/401">测试 401</a> · <a href="/status/503">测试 503</a></body></html>`,
    );
};
function websocket(req, socket) {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const text = Buffer.from('pdm-websocket-ok');
  socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
  socket.on('data', () => socket.end());
}
for (const port of [8080, 8081]) {
  const server = http.createServer(handler);
  server.on('upgrade', websocket);
  server.listen(port, '0.0.0.0');
}
if (fs.existsSync('/certs/test.key')) {
  const server = https.createServer(
    { key: fs.readFileSync('/certs/test.key'), cert: fs.readFileSync('/certs/test.crt') },
    handler,
  );
  server.on('upgrade', websocket);
  server.listen(8443, '0.0.0.0');
}
