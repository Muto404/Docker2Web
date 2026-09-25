import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import type { CheckResult, Host, Settings } from '../shared/types.js';
export async function checkHost(h: Host, s: Settings): Promise<CheckResult> {
  const r: CheckResult = {
    at: new Date().toISOString(),
    dns: { ok: false, message: '尚未检查' },
    tls: { ok: false, message: '尚未检查' },
    http: { ok: false, message: '尚未检查' },
    phone: '本机检查不能代替手机 Tailscale 链路，请在手机打开访问地址确认。',
  };
  const domain = h.domain_names[0];
  const dns = new Resolver({ timeout: 2500, tries: 1 });
  try {
    const ips = await dns.resolve4(domain);
    r.dns = {
      ok: !!ips.length && (!s.expectedIp || ips.includes(s.expectedIp)),
      message:
        ips.join('、') + (s.expectedIp && !ips.includes(s.expectedIp) ? '（与预期 IP 不符）' : ''),
    };
  } catch {
    r.dns = { ok: false, message: '未解析到 IPv4 地址，请检查 DNS' };
  }
  await new Promise<void>((resolve) => {
    const req = https.request(
      {
        hostname: s.proxyHost,
        port: s.proxyPort,
        servername: domain,
        path: '/',
        method: 'GET',
        headers: { Host: domain },
        rejectUnauthorized: true,
      },
      (res) => {
        r.tls = { ok: true, message: '证书链与域名验证通过' };
        const status = res.statusCode || 0;
        r.http = {
          ok: status > 0 && status < 500,
          message: `HTTP ${status}${status === 401 || status === 403 ? ' · 服务已响应，需要应用授权' : status >= 500 ? ' · 代理或后端异常' : ''}`,
        };
        res.destroy();
        resolve();
      },
    );
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
    req.on('error', (e: NodeJS.ErrnoException) => {
      r.tls = { ok: false, message: `HTTPS 检查失败（${e.code || '连接超时'}）` };
      r.http = { ok: false, message: '未取得 HTTP 响应' };
      resolve();
    });
    req.end();
  });
  return r;
}
