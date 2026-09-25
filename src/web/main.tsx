import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Certificate, CheckResult, Entry, Input, Service, Settings } from '../shared/types.js';
import './style.css';
let csrf = '';
async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch('/api' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '请求失败');
  return d;
}
type Page = 'entries' | 'projects' | 'history' | 'settings';
type Auth = { initialized: boolean; authenticated: boolean; csrf: string; configured: boolean };
type Log = {
  id: string;
  action: string;
  status: string;
  createdAt: string;
  error: string | null;
  npmId: number | null;
  domains: string[];
  canRollback: boolean;
  before: { domain: string; target: string } | null;
  after: { domain: string; target: string } | null;
};
const defaults: Settings = {
  npmUrl: 'http://host.docker.internal:81',
  identity: '',
  baseDomain: '',
  forwardHost: 'host.docker.internal',
  certificateId: 0,
  proxyHost: 'host.docker.internal',
  proxyPort: 443,
  expectedIp: '',
  protectedDomains: [],
};
const labels: Record<string, string> = {
  create: '创建入口',
  update: '编辑入口',
  adopt: '接管规则',
  enable: '启用',
  disable: '停用',
  archive: '归档',
  restore: '恢复',
  rollback: '回退修改',
  applied: '已应用',
  pending: '执行中',
  needs_attention: '需要核对',
  running: '运行中',
  exited: '已停止',
  created: '未启动',
  restarting: '重启中',
};
function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: string }) {
  return (
    <span className={'badge ' + tone}>
      <i />
      {children}
    </span>
  );
}
function App() {
  const [auth, setAuth] = useState<Auth | null>(null),
    [page, setPage] = useState<Page>('entries'),
    [settings, setSettings] = useState<Settings>(defaults),
    [hasSecret, setHasSecret] = useState(false),
    [entries, setEntries] = useState<Entry[]>([]),
    [services, setServices] = useState<Service[]>([]),
    [certs, setCerts] = useState<Certificate[]>([]),
    [logs, setLogs] = useState<Log[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [search, setSearch] = useState(''),
    [showArchive, setShowArchive] = useState(false),
    [connection, setConnection] = useState<{
      npm?: { ok: boolean; version?: string; compatible?: boolean };
      docker?: { ok: boolean; count?: number };
    }>({});
  const [editing, setEditing] = useState<{ entry?: Entry; service?: Service } | null>(null),
    [check, setCheck] = useState<{ domain: string; result: CheckResult } | null>(null),
    [confirm, setConfirm] = useState<{
      title: string;
      detail: string;
      run: () => Promise<void>;
    } | null>(null);
  async function status() {
    const a = await api<Auth>('/auth/status');
    csrf = a.csrf;
    setAuth(a);
    return a;
  }
  async function refresh() {
    setLoading(true);
    try {
      const conf = await api<{ settings: Settings | null; hasSecret: boolean }>('/settings');
      setSettings(conf.settings || defaults);
      setHasSecret(conf.hasSecret);
      if (!conf.settings) {
        setPage('settings');
        setServices(await api<Service[]>('/services').catch(() => []));
        return;
      }
      const results = await Promise.allSettled([
        api<Entry[]>('/entries'),
        api<Service[]>('/services'),
        api<Certificate[]>('/certificates'),
        api<Log[]>('/operations'),
        api<typeof connection>('/connection'),
      ]);
      const setters = [setEntries, setServices, setCerts, setLogs, setConnection];
      let warnings: string[] = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') (setters[i] as (x: unknown) => void)(r.value);
        else warnings.push(r.reason.message);
      });
      if (warnings.length) setError([...new Set(warnings)].join('；'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    status()
      .then((a) => {
        if (a.authenticated) void refresh();
      })
      .catch((e) => setError(e.message));
  }, []);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mutation(path: string, body: unknown, method?: string) {
    const o = await api<{ status?: string; error?: string }>(path, body, method);
    if (o.status && o.status !== 'applied') {
      setError(o.error || '需要核对操作结果');
    } else setNotice('操作已保存');
    await refresh();
  }
  function ask(title: string, detail: string, fn: () => Promise<void>) {
    setConfirm({ title, detail, run: fn });
  }
  if (!auth) return <div className="loading">正在连接 Docker2Web…{error && <p>{error}</p>}</div>;
  if (!auth.authenticated)
    return (
      <div className="auth-wrap">
        <div className="auth-story">
          <div className="brand">
            ◈ <span>Docker2Web</span>
          </div>
          <div>
            <span className="eyebrow">YOUR PROJECTS, CONNECTED</span>
            <h1>
              给每个项目，
              <br />
              一个好记的地址。
            </h1>
            <p>
              连接 Docker 与 Nginx Proxy Manager，
              <br />
              在一个地方管理你的项目入口。
            </p>
            <div className="domain-example">
              <span>https://</span>photos<span>.example.com</span>
              <b>↗</b>
            </div>
          </div>
          <small>Docker2Web · v0.1.0</small>
        </div>
        <div className="auth-panel">
          <span className="eyebrow">PRIVATE WORKSPACE</span>
          <h2>{auth.initialized ? '欢迎回来' : '创建你的管理空间'}</h2>
          <p className="muted">
            {auth.initialized
              ? '输入管理员密码，继续管理项目入口。'
              : '设置独立的管理员密码。初始化密钥保存在本机。'}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(async () => {
                await api(auth.initialized ? '/auth/login' : '/auth/setup', {
                  password: f.get('password'),
                  bootstrapToken: f.get('token') || undefined,
                });
                await status();
                await refresh();
              });
            }}
          >
            {!auth.initialized && (
              <label>
                初始化密钥
                <input name="token" type="password" required autoComplete="off" />
                <small>读取项目目录下的 secrets/bootstrap-token</small>
              </label>
            )}
            <label>
              管理员密码
              <input
                name="password"
                type="password"
                minLength={12}
                required
                autoComplete={auth.initialized ? 'current-password' : 'new-password'}
              />
              <small>至少 12 位字符</small>
            </label>
            {error && (
              <div role="alert" className="alert error">
                {error}
              </div>
            )}
            <button className="primary wide" disabled={busy}>
              {busy ? '正在验证…' : auth.initialized ? '进入管理空间 →' : '创建并继续 →'}
            </button>
          </form>
        </div>
      </div>
    );
  const visible = entries.filter(
    (e) =>
      (showArchive || !e.binding?.archived) &&
      `${e.domain_names.join()} ${e.forward_host} ${e.binding?.project}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const stats = {
    managed: entries.filter((e) => e.binding && !e.binding.archived).length,
    active: entries.filter((e) => e.enabled && !e.binding?.archived).length,
    projects: new Set(services.map((s) => s.project)).size,
  };
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          ◈{' '}
          <span>
            Docker2Web<small>DOCKER PROJECTS, CONNECTED</small>
          </span>
        </div>
        <div className="workspace">
          <span className="workspace-icon">M</span>
          <div>
            我的工作空间<small>Docker Desktop</small>
          </div>
        </div>
        <div className="nav-caption">工作空间</div>
        <nav>
          {(
            [
              ['entries', '⌘', '域名入口'],
              ['projects', '▦', 'Docker 项目'],
              ['history', '◷', '操作记录'],
              ['settings', '⚙', '连接设置'],
            ] as const
          ).map(([p, icon, title]) => (
            <button
              key={p}
              className={page === p ? 'selected' : ''}
              onClick={() => {
                setPage(p);
                setError('');
              }}
            >
              <span>{icon}</span>
              {title}
              {p === 'entries' && <b>{stats.managed}</b>}
            </button>
          ))}
        </nav>
        <div className="aside-bottom">
          <Badge tone={connection.npm?.ok ? 'green' : 'gray'}>
            {connection.npm?.ok ? 'NPM 已连接' : '等待连接 NPM'}
          </Badge>
          <small>v0.1.0 · 私有工作空间</small>
          <button
            className="link-button"
            onClick={() =>
              void run(async () => {
                await api('/auth/logout', {});
                await status();
              })
            }
          >
            退出登录 ↗
          </button>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            工作空间 <span>/</span>{' '}
            {
              {
                entries: '域名入口',
                projects: 'Docker 项目',
                history: '操作记录',
                settings: '连接设置',
              }[page]
            }
          </div>
          <div className="header-right">
            <span className="local-dot" /> 私有访问 <span className="avatar">M</span>
            <button
              className="mobile-logout"
              onClick={() =>
                void run(async () => {
                  await api('/auth/logout', {});
                  await status();
                })
              }
            >
              退出
            </button>
          </div>
        </header>
        <div className="content">
          {error && (
            <div className="alert error" role="alert">
              {error}
              <button onClick={() => setError('')}>×</button>
            </div>
          )}
          {notice && (
            <div className="alert success" role="status">
              {notice}
              <button onClick={() => setNotice('')}>×</button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {page === 'entries'
                  ? 'CONNECTED SERVICES'
                  : page === 'projects'
                    ? 'DOCKER WORKSPACE'
                    : page === 'history'
                      ? 'ACTIVITY LOG'
                      : 'CONNECTIONS'}
              </span>
              <h1>
                {
                  {
                    entries: '项目的每一个入口',
                    projects: '正在构建的项目',
                    history: '每次变更，有迹可循',
                    settings: '连接你的工作环境',
                  }[page]
                }
              </h1>
              <p className="muted">
                {
                  {
                    entries: '为项目绑定域名，访问、调整和管理都在这里。',
                    projects: '继续使用 Compose 部署，在这里选择需要绑定域名的服务。',
                    history: '查看配置变更、核对未完成操作，或回退最近一次编辑。',
                    settings: '一次连接，复用已有 DNS 与证书。',
                  }[page]
                }
              </p>
            </div>
            {page !== 'settings' && (
              <div className="actions">
                <button disabled={loading || busy} onClick={() => void refresh()}>
                  {loading ? '刷新中…' : '↻ 刷新'}
                </button>
                {page === 'entries' && (
                  <button
                    className="primary"
                    disabled={(!auth.configured && !hasSecret) || busy}
                    onClick={() => setEditing({})}
                  >
                    ＋ 添加入口
                  </button>
                )}
              </div>
            )}
          </div>
          {page === 'entries' && (
            <>
              <div className="stats">
                <div>
                  <small>托管入口</small>
                  <strong>{stats.managed.toString().padStart(2, '0')}</strong>
                  <span>在这里统一管理</span>
                </div>
                <div>
                  <small>已启用规则</small>
                  <strong>
                    {stats.active.toString().padStart(2, '0')}
                    <i className="green-dot" />
                  </strong>
                  <span>后端状态可单独检查</span>
                </div>
                <div>
                  <small>已发现项目</small>
                  <strong>{stats.projects.toString().padStart(2, '0')}</strong>
                  <span>{services.length} 个服务容器</span>
                </div>
              </div>
              <div className="list-toolbar">
                <h2>
                  所有入口 <span>{visible.length}</span>
                </h2>
                <div>
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={showArchive}
                      onChange={(e) => setShowArchive(e.target.checked)}
                    />
                    显示归档
                  </label>
                  <input
                    aria-label="搜索域名或项目"
                    className="search"
                    placeholder="搜索域名或项目…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
              <div className="entry-list">
                {visible.map((e) => (
                  <article key={e.id} className="entry-card">
                    <div className="entry-icon">↗</div>
                    <div className="entry-main">
                      <div className="entry-title">
                        <a href={`https://${e.domain_names[0]}`} target="_blank" rel="noreferrer">
                          {e.domain_names.join(', ')}
                        </a>
                        <Badge tone={e.binding?.archived ? 'gray' : e.enabled ? 'green' : 'amber'}>
                          {e.binding?.archived ? '已归档' : e.enabled ? '已启用' : '已停用'}
                        </Badge>
                      </div>
                      <div className="entry-meta">
                        <span>
                          {e.forward_scheme}://{e.forward_host}:{e.forward_port}
                        </span>
                        <span>·</span>
                        <span>{e.binding?.project || '手动目标'}</span>
                      </div>
                      <div className="entry-tags">
                        <span>
                          ◇{' '}
                          {certs.find((c) => c.id === e.certificate_id)?.nice_name || '未绑定证书'}
                        </span>
                        <span>
                          {e.protected
                            ? '管理入口 · 受保护'
                            : e.binding
                              ? '已托管'
                              : 'NPM 现有规则 · 只读'}
                        </span>
                      </div>
                    </div>
                    <div className="entry-actions">
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await api<CheckResult>(`/entries/${e.id}/check`, {});
                            setCheck({ domain: e.domain_names[0], result });
                          })
                        }
                      >
                        检查
                      </button>
                      {!e.protected &&
                        e.editable &&
                        (e.binding ? (
                          <>
                            <button
                              disabled={busy || e.binding.archived}
                              onClick={() => setEditing({ entry: e })}
                            >
                              编辑
                            </button>
                            <details>
                              <summary aria-label="更多操作">•••</summary>
                              <div className="menu">
                                {(e.binding.archived
                                  ? ['restore']
                                  : e.enabled
                                    ? ['disable', 'archive']
                                    : ['enable', 'archive']
                                ).map((a) => (
                                  <button
                                    key={a}
                                    disabled={busy}
                                    onClick={() =>
                                      ask(
                                        labels[a] + '入口',
                                        a === 'archive'
                                          ? '停用此代理规则并归档，可恢复。容器和数据不会删除。'
                                          : `将${labels[a]} ${e.domain_names[0]} 的访问入口。`,
                                        () =>
                                          mutation(`/entries/${e.id}/action`, {
                                            action: a,
                                            key: crypto.randomUUID(),
                                            fingerprint: e.fingerprint,
                                          }),
                                      )
                                    }
                                  >
                                    {labels[a]}
                                  </button>
                                ))}
                              </div>
                            </details>
                          </>
                        ) : (
                          <button
                            disabled={busy}
                            onClick={() =>
                              ask(
                                '接管这条规则',
                                `将允许 Docker2Web 编辑 ${e.domain_names[0]}。保存前会检查 NPM 中的外部修改。`,
                                () =>
                                  mutation(`/entries/${e.id}/adopt`, {
                                    fingerprint: e.fingerprint,
                                  }),
                              )
                            }
                          >
                            接管
                          </button>
                        ))}
                    </div>
                  </article>
                ))}
                {!visible.length && (
                  <Empty
                    title={search ? '没有匹配的入口' : '让项目拥有自己的地址'}
                    text={
                      search
                        ? '换一个关键词试试。'
                        : '部署好项目后，点击「添加入口」选择服务并填写子域名。'
                    }
                  />
                )}
              </div>
              <div className="footnote">
                ◇ 域名解析和证书由现有服务管理。手机访问需要连接 Tailscale。
              </div>
            </>
          )}
          {page === 'projects' && (
            <div className="projects">
              {Array.from(new Set(services.map((s) => s.project))).map((project) => (
                <section className="project-card" key={project}>
                  <div className="project-heading">
                    <span className="project-icon">▦</span>
                    <h2>{project}</h2>
                    <span>{services.filter((s) => s.project === project).length} 个服务</span>
                  </div>
                  {services
                    .filter((s) => s.project === project)
                    .map((s) => (
                      <div className="service-row" key={s.id}>
                        <div>
                          <strong>{s.service}</strong>
                          <small>{s.name}</small>
                        </div>
                        <Badge tone={s.state === 'running' ? 'green' : 'gray'}>
                          {labels[s.state] || s.state}
                        </Badge>
                        <div className="ports">
                          {s.ports.length ? (
                            s.ports.map((p, i) => (
                              <span key={i}>
                                {p.hostPort} → {p.containerPort}/{p.protocol}
                                {!p.eligible ? ' · 不可直接代理' : ''}
                              </span>
                            ))
                          ) : (
                            <span>未发布宿主机端口</span>
                          )}
                        </div>
                        <button
                          disabled={!s.ports.some((p) => p.eligible) || busy || !hasSecret}
                          onClick={() => setEditing({ service: s })}
                        >
                          绑定域名 ↗
                        </button>
                      </div>
                    ))}
                </section>
              ))}
              {!services.length && (
                <Empty title="尚未发现容器" text="请启动 Docker Desktop，再刷新项目列表。" />
              )}
            </div>
          )}
          {page === 'history' && (
            <>
              <div className="list-toolbar">
                <h2>最近操作</h2>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api('/operations/reconcile', {});
                      await refresh();
                      setNotice('已核对未完成操作');
                    })
                  }
                >
                  核对未完成操作
                </button>
              </div>
              <div className="history">
                {logs.map((o) => (
                  <div className="log" key={o.id}>
                    <div className="log-dot" />
                    <div>
                      <strong>{labels[o.action] || o.action}</strong>
                      <span className="log-domain">{o.domains.join(', ') || '待确认入口'}</span>
                      <small>{new Date(o.createdAt).toLocaleString('zh-CN')}</small>
                      {o.before && o.after && o.action === 'update' && (
                        <p>
                          {o.before.domain} · {o.before.target} → {o.after.domain} ·{' '}
                          {o.after.target}
                        </p>
                      )}
                      {o.error && <p className="warning-text">{o.error}</p>}
                    </div>
                    <Badge tone={o.status === 'applied' ? 'green' : 'amber'}>
                      {labels[o.status] || o.status}
                    </Badge>
                    {o.canRollback && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          ask(
                            '回退此次编辑',
                            '仅在规则未再次变化时恢复编辑前的域名与目标。',
                            async () => {
                              const e = entries.find((e) => e.id === o.npmId);
                              if (!e) throw new Error('请刷新入口列表后重试');
                              await mutation(`/operations/${o.id}/rollback`, {
                                key: crypto.randomUUID(),
                                fingerprint: e.fingerprint,
                              });
                            },
                          )
                        }
                      >
                        回退
                      </button>
                    )}
                  </div>
                ))}
                {!logs.length && (
                  <Empty title="还没有操作记录" text="创建或接管入口后，变更会显示在这里。" />
                )}
              </div>
            </>
          )}
          {page === 'settings' && (
            <SettingsForm
              settings={settings}
              certs={certs}
              hasSecret={hasSecret}
              busy={busy}
              connection={connection}
              save={(s) =>
                run(async () => {
                  const r = await api<{ version: string; compatible: boolean }>(
                    '/settings',
                    s,
                    'PUT',
                  );
                  await status();
                  await refresh();
                  setNotice(
                    `连接已保存 · NPM ${r.version}${r.compatible ? '' : ' · 仅支持读取，写入尚未验证'}`,
                  );
                })
              }
            />
          )}
        </div>
        <footer>
          项目留在本地，入口井井有条。<span>Docker2Web</span>
        </footer>
      </main>
      {editing && (
        <Editor
          entry={editing.entry}
          service={editing.service}
          services={services}
          settings={settings}
          certs={certs}
          busy={busy}
          error={error}
          close={() => setEditing(null)}
          save={(input, key) =>
            run(async () => {
              const o = await api<{ status: string; error?: string }>(
                editing.entry ? `/entries/${editing.entry.id}` : '/entries',
                {
                  input,
                  key,
                  ...(editing.entry ? { fingerprint: editing.entry.fingerprint } : {}),
                },
                editing.entry ? 'PUT' : 'POST',
              );
              if (o.status !== 'applied') throw new Error(o.error || '操作需要核对');
              setEditing(null);
              setNotice('入口已保存，可点击「检查」验证访问');
              await refresh();
            })
          }
        />
      )}
      {confirm && (
        <div className="overlay">
          <section
            className="modal small"
            role="dialog"
            aria-modal="true"
            aria-label={confirm.title}
          >
            <h2>{confirm.title}</h2>
            <p>{confirm.detail}</p>
            <div className="actions">
              <button disabled={busy} onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  const f = confirm.run;
                  setConfirm(null);
                  void run(f);
                }}
              >
                确认
              </button>
            </div>
          </section>
        </div>
      )}
      {check && (
        <div className="overlay">
          <section className="modal small" role="dialog" aria-modal="true" aria-label="访问检查">
            <div className="modal-heading">
              <h2>访问检查</h2>
              <button onClick={() => setCheck(null)}>×</button>
            </div>
            <p>{check.domain}</p>
            {(['dns', 'tls', 'http'] as const).map((k) => (
              <div className="check-row" key={k}>
                <Badge tone={check.result[k].ok ? 'green' : 'amber'}>{k.toUpperCase()}</Badge>
                <span>{check.result[k].message}</span>
              </div>
            ))}
            <p className="muted">{check.result.phone}</p>
            <a
              className="button primary"
              href={`https://${check.domain}`}
              target="_blank"
              rel="noreferrer"
            >
              打开项目 ↗
            </a>
          </section>
        </div>
      )}
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <div>◈</div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function SettingsForm({
  settings,
  certs,
  hasSecret,
  busy,
  connection,
  save,
}: {
  settings: Settings;
  certs: Certificate[];
  hasSecret: boolean;
  busy: boolean;
  connection: {
    npm?: { ok: boolean; version?: string; compatible?: boolean };
    docker?: { ok: boolean };
  };
  save: (s: Settings & { secret?: string }) => Promise<void>;
}) {
  const [v, setV] = useState(settings),
    [secret, setSecret] = useState('');
  useEffect(() => setV(settings), [settings]);
  const field = (key: keyof Settings, value: unknown) => setV({ ...v, [key]: value });
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save({ ...v, secret: secret || undefined }).then(() => setSecret(''));
      }}
    >
      <section className="settings-card">
        <div className="section-title">
          <div>
            <h2>连接 Nginx Proxy Manager</h2>
            <p>输入管理页面的地址及已有账号。凭据仅保存在后端。</p>
          </div>
          <Badge tone={connection.npm?.ok ? 'green' : 'gray'}>
            {connection.npm?.ok ? `v${connection.npm.version}` : '未连接'}
          </Badge>
        </div>
        <div className="form-grid">
          <label>
            管理地址
            <input
              type="url"
              value={v.npmUrl}
              onChange={(e) => field('npmUrl', e.target.value)}
              required
            />
            <small>容器部署通常使用 http://host.docker.internal:81</small>
          </label>
          <label>
            账号邮箱
            <input
              type="email"
              autoComplete="username"
              value={v.identity}
              onChange={(e) => field('identity', e.target.value)}
              required
            />
          </label>
          <label>
            NPM 密码
            <input
              type="password"
              autoComplete="current-password"
              placeholder={hasSecret ? '已保存，留空保持不变' : '请输入 NPM 密码'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required={!hasSecret}
            />
          </label>
        </div>
      </section>
      <section className="settings-card">
        <div className="section-title">
          <div>
            <h2>默认域名与证书</h2>
            <p>先保存连接，再选择已有证书。工具不申请或续期证书。</p>
          </div>
        </div>
        <div className="form-grid">
          <label>
            基础域名
            <input
              placeholder="example.com"
              value={v.baseDomain}
              onChange={(e) => field('baseDomain', e.target.value)}
              required
            />
          </label>
          <label>
            默认 HTTPS 证书
            <select
              value={v.certificateId}
              onChange={(e) => field('certificateId', Number(e.target.value))}
            >
              <option value="0">保存连接后选择证书</option>
              {certs.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.nice_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            预期 DNS IPv4 地址
            <input
              placeholder="100.x.x.x（可选）"
              value={v.expectedIp}
              onChange={(e) => field('expectedIp', e.target.value)}
            />
          </label>
          <label>
            受保护的管理域名
            <input
              placeholder="manager.example.com"
              value={v.protectedDomains.join(', ')}
              onChange={(e) =>
                field(
                  'protectedDomains',
                  e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
            <small>多个域名用英文逗号分隔</small>
          </label>
        </div>
        {certs.length > 0 && (
          <div className="certificate-list">
            {certs.map((c) => (
              <div key={c.id}>
                <span>◇ {c.domain_names.join(' · ')}</span>
                <small>到期：{c.expires_on.slice(0, 10)}</small>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="settings-card">
        <div className="section-title">
          <div>
            <h2>转发与访问检查</h2>
            <p>使用项目发布到 Mac 的端口。Docker 连接由部署配置管理。</p>
          </div>
          <Badge tone={connection.docker?.ok ? 'green' : 'gray'}>
            Docker {connection.docker?.ok ? '已连接' : '未连接'}
          </Badge>
        </div>
        <div className="form-grid">
          <label>
            默认转发主机
            <input
              value={v.forwardHost}
              onChange={(e) => field('forwardHost', e.target.value)}
              required
            />
          </label>
          <label>
            NPM 代理地址
            <input
              value={v.proxyHost}
              onChange={(e) => field('proxyHost', e.target.value)}
              required
            />
            <small>用于直接检查代理，不填写具体业务域名</small>
          </label>
          <label>
            NPM HTTPS 端口
            <input
              type="number"
              min="1"
              max="65535"
              value={v.proxyPort}
              onChange={(e) => field('proxyPort', Number(e.target.value))}
              required
            />
          </label>
        </div>
      </section>
      <div className="save-bar">
        <span>正常项目流量经过 NPM，不经过 Docker2Web。</span>
        <button className="primary" disabled={busy}>
          {busy ? '验证并保存中…' : '验证连接并保存'}
        </button>
      </div>
    </form>
  );
}
function Editor({
  entry,
  service,
  services,
  settings,
  certs,
  busy,
  error,
  close,
  save,
}: {
  entry?: Entry;
  service?: Service;
  services: Service[];
  settings: Settings;
  certs: Certificate[];
  busy: boolean;
  error: string;
  close: () => void;
  save: (i: Input, key: string) => Promise<void>;
}) {
  const matched =
    service ||
    services.find(
      (s) => s.project === entry?.binding?.project && s.service === entry?.binding?.service,
    );
  const eligible = matched?.ports.filter((p) => p.eligible) || [];
  const initialPort = eligible.length === 1 ? eligible[0] : undefined;
  const [selected, setSelected] = useState(matched?.id || ''),
    [key] = useState(() => crypto.randomUUID()),
    [v, setV] = useState<Input>({
      subdomain: entry ? entry.domain_names[0].slice(0, -settings.baseDomain.length - 1) : '',
      port: entry?.forward_port || initialPort?.hostPort || (matched ? 0 : 3000),
      scheme: entry?.forward_scheme === 'https' ? 'https' : 'http',
      certificateId: entry?.certificate_id || settings.certificateId,
      websocket: entry?.allow_websocket_upgrade || false,
      project: matched?.project || '',
      service: matched?.service || '',
      containerPort: entry?.binding?.containerPort || initialPort?.containerPort || null,
    });
  const s = services.find((s) => s.id === selected);
  function choose(id: string) {
    setSelected(id);
    const next = services.find((s) => s.id === id),
      ports = next?.ports.filter((p) => p.eligible) || [],
      p = ports.length === 1 ? ports[0] : undefined;
    setV({
      ...v,
      project: next?.project || '',
      service: next?.service || '',
      port: p?.hostPort || (next ? 0 : v.port || 3000),
      containerPort: p?.containerPort || null,
    });
  }
  return (
    <div className="overlay">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={entry ? '编辑入口' : '添加入口'}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">CONNECT YOUR PROJECT</span>
            <h2>{entry ? '编辑入口' : '为项目绑定域名'}</h2>
          </div>
          <button aria-label="关闭" disabled={busy} onClick={close}>
            ×
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(v, key);
          }}
        >
          <label>
            目标服务
            <select value={selected} onChange={(e) => choose(e.target.value)}>
              <option value="">手动填写宿主机端口</option>
              {services
                .filter((s) => s.ports.some((p) => p.eligible))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.project} / {s.service} · {labels[s.state] || s.state}
                  </option>
                ))}
            </select>
          </label>
          <label>
            子域名
            <div className="domain-input">
              <input
                autoFocus
                placeholder="photos"
                required
                maxLength={63}
                pattern="[a-zA-Z0-9][a-zA-Z0-9-]*"
                value={v.subdomain}
                onChange={(e) => setV({ ...v, subdomain: e.target.value.toLowerCase() })}
              />
              <span>.{settings.baseDomain}</span>
            </div>
          </label>
          <label>
            宿主机端口
            {s ? (
              <select
                required
                value={
                  s.ports.some(
                    (p) =>
                      p.eligible && p.hostPort === v.port && p.containerPort === v.containerPort,
                  )
                    ? `${v.port}:${v.containerPort}`
                    : ''
                }
                onChange={(e) => {
                  const [port, containerPort] = e.target.value.split(':').map(Number);
                  setV({ ...v, port, containerPort });
                }}
              >
                <option value="" disabled>
                  请选择宿主机端口
                </option>
                {s.ports
                  .filter((p) => p.eligible)
                  .map((p, i) => (
                    <option key={i} value={`${p.hostPort}:${p.containerPort}`}>
                      {p.hostPort} → 容器 {p.containerPort}
                    </option>
                  ))}
              </select>
            ) : (
              <input
                type="number"
                min="1"
                max="65535"
                required
                value={v.port}
                onChange={(e) => setV({ ...v, port: Number(e.target.value) })}
              />
            )}
            <small>使用 Compose ports 左侧的端口，不是容器内部端口。</small>
          </label>
          <label>
            HTTPS 证书
            <select
              required
              value={v.certificateId || ''}
              onChange={(e) => setV({ ...v, certificateId: Number(e.target.value) })}
            >
              <option value="" disabled>
                请选择覆盖此域名的证书
              </option>
              {certs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nice_name}
                </option>
              ))}
            </select>
          </label>
          <details className="advanced">
            <summary>高级设置</summary>
            <label>
              后端协议
              <select
                value={v.scheme}
                onChange={(e) => setV({ ...v, scheme: e.target.value as 'http' | 'https' })}
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </select>
            </label>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={v.websocket}
                onChange={(e) => setV({ ...v, websocket: e.target.checked })}
              />
              启用 WebSocket 支持
            </label>
          </details>
          <div className="preview">
            <small>保存后的访问地址</small>
            <strong>
              https://{v.subdomain || 'your-project'}.{settings.baseDomain}
            </strong>
            <span>
              → {settings.forwardHost}:{v.port || '请选择端口'}
            </span>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-footer">
            <button type="button" disabled={busy} onClick={close}>
              取消
            </button>
            <button className="primary" disabled={busy || !v.certificateId}>
              {busy ? '正在应用…' : entry ? '保存修改' : '创建入口 →'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
