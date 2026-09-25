import type { Certificate, Host } from '../shared/types.js';
import { AppError } from './domain.js';
export interface NpmPort {
  version(): Promise<string>;
  hosts(): Promise<Host[]>;
  certificates(): Promise<Certificate[]>;
  get(id: number): Promise<Host>;
  create(body: Record<string, unknown>): Promise<Host>;
  update(id: number, body: Record<string, unknown>): Promise<Host>;
  toggle(id: number, on: boolean): Promise<void>;
}
export class Npm implements NpmPort {
  private token = '';
  private expires = 0;
  constructor(
    private url: string,
    private identity: string,
    private secret: string,
  ) {}
  private async raw(path: string, method = 'GET', body?: unknown, token = ''): Promise<unknown> {
    let r: Response;
    try {
      r = await fetch(`${this.url.replace(/\/$/, '')}/api${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(12000),
        redirect: 'error',
      });
    } catch {
      throw new AppError(502, 'NPM 连接失败或超时，请检查地址及运行状态');
    }
    if (!r.ok)
      throw new AppError(
        r.status === 401 ? 401 : 502,
        `NPM 请求失败（HTTP ${r.status}），请检查账号权限与配置`,
      );
    try {
      return await r.json();
    } catch {
      throw new AppError(502, 'NPM 返回了无法识别的数据');
    }
  }
  async login() {
    const d = (await this.raw('/tokens', 'POST', {
      identity: this.identity,
      secret: this.secret,
    })) as { token?: string; expires?: string };
    if (!d.token) throw new AppError(400, 'NPM 登录未获得令牌；当前版本不支持需要二次验证的账号');
    this.token = d.token;
    this.expires = Date.parse(d.expires || '') || Date.now() + 300000;
  }
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    if (!this.token || Date.now() > this.expires - 60000) await this.login();
    try {
      return await this.raw(path, method, body, this.token);
    } catch (e) {
      if (e instanceof AppError && e.status === 401) {
        await this.login();
        return this.raw(path, method, body, this.token);
      }
      throw e;
    }
  }
  async version() {
    const d = (await this.raw('/')) as {
      version?: { major: number; minor: number; revision: number } | string;
    };
    if (typeof d.version === 'string') return d.version;
    return d.version ? `${d.version.major}.${d.version.minor}.${d.version.revision}` : 'unknown';
  }
  async hosts() {
    const d = await this.request('/nginx/proxy-hosts');
    if (!Array.isArray(d)) throw new AppError(502, 'NPM 规则列表格式不兼容');
    return d as Host[];
  }
  async certificates() {
    const d = await this.request('/nginx/certificates');
    if (!Array.isArray(d)) throw new AppError(502, 'NPM 证书列表格式不兼容');
    return d.map((c) => ({
      id: c.id,
      nice_name: c.nice_name,
      domain_names: c.domain_names,
      expires_on: c.expires_on,
      provider: c.provider,
    })) as Certificate[];
  }
  async get(id: number) {
    return (await this.request(`/nginx/proxy-hosts/${id}`)) as Host;
  }
  async create(body: Record<string, unknown>) {
    return (await this.request('/nginx/proxy-hosts', 'POST', body)) as Host;
  }
  async update(id: number, body: Record<string, unknown>) {
    return (await this.request(`/nginx/proxy-hosts/${id}`, 'PUT', body)) as Host;
  }
  async toggle(id: number, on: boolean) {
    await this.request(`/nginx/proxy-hosts/${id}/${on ? 'enable' : 'disable'}`, 'POST');
  }
}
