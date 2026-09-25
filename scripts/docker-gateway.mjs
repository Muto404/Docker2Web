import http from 'node:http';
// Only a fixed metadata view is exposed; never forward raw inspect responses or Docker writes.
const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
http
  .createServer((req, res) => {
    const url = req.url || '';
    if (
      req.method !== 'GET' ||
      !(/^\/containers\/json\?all=1$/.test(url) || /^\/containers\/[a-f0-9]{64}\/json$/.test(url))
    ) {
      res.writeHead(403).end();
      return;
    }
    const upstream = http.get({ socketPath, path: url }, (r) => {
      let body = '';
      r.on('data', (c) => {
        body += c;
        if (body.length > 8_000_000) upstream.destroy();
      });
      r.on('end', () => {
        try {
          if (r.statusCode !== 200) {
            res.writeHead(502).end();
            return;
          }
          const d = JSON.parse(body);
          const labels = (o) =>
            Object.fromEntries(
              Object.entries(o || {}).filter(([k]) =>
                [
                  'com.docker.compose.project',
                  'com.docker.compose.service',
                  'pdm.internal',
                ].includes(k),
              ),
            );
          const clean = Array.isArray(d)
            ? d.map((x) => ({
                Id: x.Id,
                Names: x.Names,
                Labels: labels(x.Labels),
                State: x.State,
                Ports: x.Ports,
              }))
            : {
                Id: d.Id,
                Name: d.Name,
                Config: { Labels: labels(d.Config?.Labels) },
                State: { Status: d.State?.Status },
                HostConfig: { PortBindings: d.HostConfig?.PortBindings },
              };
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(clean));
        } catch {
          res.writeHead(502).end();
        }
      });
    });
    upstream.setTimeout(5000, () => upstream.destroy());
    upstream.on('error', () => res.writeHead(502).end());
  })
  .listen(2375, '0.0.0.0');
