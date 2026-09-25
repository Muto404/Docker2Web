import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Host, Certificate } from '../shared/types.js';
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, '请输入有效域名');
export const inputSchema = z.object({
  subdomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, '子域名只能包含字母、数字和中划线'),
  port: z.number().int().min(1).max(65535),
  scheme: z.enum(['http', 'https']),
  certificateId: z.number().int().positive(),
  websocket: z.boolean(),
  project: z.string().max(200).default(''),
  service: z.string().max(200).default(''),
  containerPort: z.number().int().positive().max(65535).nullable().default(null),
});
export const settingsSchema = z.object({
  npmUrl: z.url().refine((s) => {
    const u = new URL(s);
    return (
      ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      ['', '/'].includes(u.pathname)
    );
  }, '请输入 NPM 基础地址（不含 /api）'),
  identity: z.email(),
  baseDomain: domainSchema,
  forwardHost: z
    .string()
    .regex(/^[a-zA-Z0-9.-]+$/)
    .max(253),
  certificateId: z.number().int().min(0),
  proxyHost: z
    .string()
    .regex(/^[a-zA-Z0-9.-]+$/)
    .max(253),
  proxyPort: z.number().int().min(1).max(65535),
  expectedIp: z.string().max(64).default(''),
  protectedDomains: z.array(domainSchema).max(20).default([]),
  secret: z.string().max(1000).optional(),
});
export const mutableFields = [
  'domain_names',
  'forward_host',
  'forward_port',
  'forward_scheme',
  'certificate_id',
  'ssl_forced',
  'caching_enabled',
  'block_exploits',
  'advanced_config',
  'allow_websocket_upgrade',
  'http2_support',
  'access_list_id',
  'locations',
  'hsts_enabled',
  'hsts_subdomains',
  'trust_forwarded_proto',
  'enabled',
] as const;
export function payload(h: Host) {
  return Object.fromEntries(mutableFields.filter((k) => h[k] !== undefined).map((k) => [k, h[k]]));
}
function ordered(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(ordered);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, ordered(x)]),
    );
  return v;
}
export function fingerprint(h: Host) {
  return createHash('sha256')
    .update(JSON.stringify(ordered(payload(h))))
    .digest('hex');
}
export function covers(pattern: string, domain: string) {
  pattern = pattern.toLowerCase();
  domain = domain.toLowerCase();
  return (
    pattern === domain ||
    (pattern.startsWith('*.') &&
      domain.endsWith(pattern.slice(1)) &&
      domain.split('.').length === pattern.split('.').length)
  );
}
export function overlaps(pattern: string, domain: string) {
  return covers(pattern, domain) || (pattern.startsWith('*.') && domain.endsWith(pattern.slice(1)));
}
export function checkCertificate(cert: Certificate | undefined, domain: string) {
  if (!cert || !cert.domain_names.some((x) => covers(x, domain)))
    throw new AppError(400, '所选证书不覆盖该域名');
  const exp = Date.parse(
    cert.expires_on.replace(' ', 'T') + (/Z|[+-]\d\d:\d\d$/.test(cert.expires_on) ? '' : 'Z'),
  );
  if (!Number.isFinite(exp) || exp <= Date.now())
    throw new AppError(400, '证书已过期或有效期无法识别');
}
export function assertSimple(h: Host) {
  if (
    h.domain_names.length !== 1 ||
    h.advanced_config?.trim() ||
    h.locations?.length ||
    h.domain_names[0].includes('*')
  )
    throw new AppError(400, '多域名、通配符、路径路由或自定义配置规则请继续在 NPM 管理');
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => {});
    return p;
  }
}
