/** Read-only smoke checks for the explicit pdm-button-qa fixtures. */
import assert from 'node:assert/strict';
import https from 'node:https';
const base = process.env.QA_BASE_DOMAIN;
if (!base || !/^[a-z0-9.-]+$/.test(base))
  throw Error('Set QA_BASE_DOMAIN to your test base domain');
const domain = `pdm-qa-web.${base}`;
function request(host, name, path, expected) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: host, servername: name, headers: { Host: name }, path },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (v) => (body += v));
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, expected);
            resolve(body);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(Error('timeout')));
  });
}
assert.match(await request(domain, domain, '/', 200), /服务：web/);
console.log('PASS real DNS → Tailscale IP → trusted TLS → web');
assert.match(await request('127.0.0.1', domain, '/', 200), /服务：web/);
await request('127.0.0.1', domain, '/status/401', 401);
await request('127.0.0.1', domain, '/status/503', 503);
assert.match(await request('127.0.0.1', `pdm-qa-multi.${base}`, '/', 200), /服务：multi/);
console.log('PASS HTTP 200/401/503 and multi-port upstream');
await new Promise((resolve, reject) => {
  const req = https.request({
    hostname: '127.0.0.1',
    servername: domain,
    path: '/ws',
    headers: {
      Host: domain,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'cGRtLXFhLXRlc3Qta2V5IQ==',
    },
  });
  const timer = setTimeout(() => {
    req.destroy();
    reject(Error('WebSocket timeout'));
  }, 6000);
  req.on('error', reject);
  req.on('response', (r) => {
    clearTimeout(timer);
    r.resume();
    reject(Error(`Expected upgrade, got ${r.statusCode}`));
  });
  req.on('upgrade', (res, socket, head) => {
    try {
      assert.equal(res.statusCode, 101);
    } catch (e) {
      clearTimeout(timer);
      socket.destroy();
      reject(e);
      return;
    }
    let data = head;
    const check = () => {
      if (data.includes(Buffer.from('pdm-websocket-ok'))) {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      }
    };
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      check();
    });
    check();
  });
  req.end();
});
console.log('PASS trusted WSS upgrade and application frame');
