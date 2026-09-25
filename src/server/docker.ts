import http from 'node:http';
import type { Service, Port } from '../shared/types.js';
import { AppError } from './domain.js';
interface RawContainer {
  Id: string;
  Names: string[];
  Labels: Record<string, string>;
  State: string;
  Ports: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[];
}
interface Inspect {
  HostConfig: { PortBindings: Record<string, { HostIp: string; HostPort: string }[]> };
  Config: { Labels: Record<string, string> };
  State: { Status: string };
  Name: string;
  Id: string;
}
export function mapPorts(bindings: Inspect['HostConfig']['PortBindings']): Port[] {
  const result: Port[] = [];
  for (const [key, values] of Object.entries(bindings || {})) {
    const [port, protocol] = key.split('/');
    for (const v of values || []) {
      const p = {
        hostPort: Number(v.HostPort),
        containerPort: Number(port),
        protocol,
        hostIp: v.HostIp || '0.0.0.0',
        eligible: protocol === 'tcp' && ['', '0.0.0.0', '::'].includes(v.HostIp),
      };
      if (
        !result.some(
          (x) =>
            x.hostPort === p.hostPort &&
            x.containerPort === p.containerPort &&
            x.protocol === p.protocol &&
            x.eligible === p.eligible,
        )
      )
        result.push(p);
    }
  }
  return result;
}
export class Docker {
  constructor(private endpoint: string) {}
  private get<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const opts = this.endpoint.startsWith('unix:')
        ? { socketPath: this.endpoint.slice(7), path }
        : new URL(path, this.endpoint);
      const req = http.get(opts, (r) => {
        let b = '';
        r.setEncoding('utf8');
        r.on('data', (c) => {
          b += c;
          if (b.length > 8_000_000) req.destroy();
        });
        r.on('end', () => {
          if (r.statusCode !== 200) return reject(new AppError(502, 'Docker 读取失败'));
          try {
            resolve(JSON.parse(b));
          } catch {
            reject(new AppError(502, 'Docker 响应无效'));
          }
        });
      });
      req.setTimeout(5000, () => req.destroy());
      req.on('error', () =>
        reject(new AppError(502, '无法连接 Docker，请检查 Desktop 与只读网关')),
      );
    });
  }
  async services(): Promise<Service[]> {
    const list = await this.get<RawContainer[]>('/containers/json?all=1');
    const result: Service[] = [];
    for (const c of list) {
      if (c.Labels?.['pdm.internal'] === 'true') continue;
      const d = await this.get<Inspect>(`/containers/${c.Id}/json`);
      result.push({
        id: c.Id,
        name: d.Name.replace(/^\//, ''),
        project: d.Config.Labels?.['com.docker.compose.project'] || '独立容器',
        service: d.Config.Labels?.['com.docker.compose.service'] || d.Name.replace(/^\//, ''),
        state: d.State.Status,
        ports: mapPorts(d.HostConfig.PortBindings),
      });
    }
    return result.sort((a, b) =>
      `${a.project}/${a.service}`.localeCompare(`${b.project}/${b.service}`),
    );
  }
}
