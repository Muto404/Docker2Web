import { readFileSync } from 'node:fs';
import { buildApp } from './app.js';
const port = Number(process.env.PORT || 3100),
  host = process.env.HOST || '127.0.0.1';
const { app } = await buildApp({
  dataFile: process.env.DATA_FILE || 'data/pdm.sqlite',
  keyFile: process.env.KEY_FILE || 'secrets/encryption-key',
  bootstrapToken: readFileSync(
    process.env.BOOTSTRAP_FILE || 'secrets/bootstrap-token',
    'utf8',
  ).trim(),
  origin: process.env.APP_ORIGIN || `http://127.0.0.1:${port}`,
  dockerEndpoint:
    process.env.DOCKER_ENDPOINT || `unix://${process.env.HOME}/.docker/run/docker.sock`,
});
await app.listen({ port, host });
console.log(`Docker2Web listening on ${host}:${port}`);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
