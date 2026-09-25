import { randomUUID } from 'node:crypto';
import type { Binding, Entry, Host, Input, Operation, Settings } from '../shared/types.js';
import {
  AppError,
  Serial,
  assertSimple,
  checkCertificate,
  fingerprint,
  inputSchema,
  overlaps,
  payload,
} from './domain.js';
import { Store } from './store.js';
import type { NpmPort } from './npm.js';
import type { Docker } from './docker.js';
function snapshot(h: Host): Host {
  return {
    id: h.id,
    ...payload(h),
    meta: { nginx_online: h.meta?.nginx_online },
  } as unknown as Host;
}
export class Manager {
  readonly serial = new Serial();
  constructor(
    public store: Store,
    private client: () => NpmPort,
    private docker: Pick<Docker, 'services'>,
    private ownDomain = '',
  ) {}
  settings(): Settings {
    const s = this.store.settings();
    if (!s) throw new AppError(400, '请先完成连接设置');
    return s;
  }
  isProtected(h: Host) {
    return h.domain_names.some((d) =>
      [this.ownDomain, ...this.settings().protectedDomains]
        .filter(Boolean)
        .some((p) => overlaps(d, p)),
    );
  }
  async entries(): Promise<Entry[]> {
    const hosts = await this.client().hosts();
    return hosts.map((h) => {
      let editable = true;
      try {
        assertSimple(h);
      } catch {
        editable = false;
      }
      return {
        ...snapshot(h),
        fingerprint: fingerprint(h),
        binding: this.store.binding(h.id),
        editable,
        protected: this.isProtected(h),
      };
    });
  }
  async compatible() {
    const v = await this.client().version();
    if (v !== '2.16.0') throw new AppError(409, `当前 NPM ${v} 尚未验证写入兼容性；支持 2.16.0`);
  }
  private async checkConflict(domain: string, exclude?: number) {
    for (const h of await this.client().hosts()) {
      if (h.id !== exclude && h.domain_names.some((d) => overlaps(d, domain)))
        throw new AppError(409, `域名与现有规则 ${h.domain_names.join(', ')} 冲突（含停用规则）`);
    }
  }
  private async desired(input: Input, exclude?: number) {
    const i = inputSchema.parse(input),
      s = this.settings(),
      domain = `${i.subdomain}.${s.baseDomain}`;
    if (domain.length > 253) throw new AppError(400, '完整域名过长');
    if ([this.ownDomain, ...s.protectedDomains].includes(domain))
      throw new AppError(400, '此域名是受保护的管理入口');
    await this.checkConflict(domain, exclude);
    checkCertificate(
      (await this.client().certificates()).find((c) => c.id === i.certificateId),
      domain,
    );
    if (i.project || i.service) {
      if (!i.project || !i.service || !i.containerPort)
        throw new AppError(400, '服务关联信息不完整');
      const matches = (await this.docker.services()).filter(
        (x) => x.project === i.project && x.service === i.service,
      );
      if (matches.length !== 1) throw new AppError(409, '服务不存在或有多个副本，请刷新后重新选择');
      if (
        !matches[0].ports.some(
          (p) => p.eligible && p.hostPort === i.port && p.containerPort === i.containerPort,
        )
      )
        throw new AppError(409, '服务映射端口已变化或不可代理，请刷新后选择');
    }
    return {
      domain_names: [domain],
      forward_host: s.forwardHost,
      forward_port: i.port,
      forward_scheme: i.scheme,
      certificate_id: i.certificateId,
      ssl_forced: true,
      allow_websocket_upgrade: i.websocket,
    };
  }
  private async current(id: number, expected: string) {
    const h = await this.client().get(id);
    if (this.isProtected(h)) throw new AppError(403, '管理入口受保护');
    assertSimple(h);
    if (fingerprint(h) !== expected)
      throw new AppError(409, '规则已在其他位置修改，请刷新并重新检查');
    return h;
  }
  private requireManaged(id: number) {
    const b = this.store.binding(id);
    if (!b) throw new AppError(403, '请先明确接管此规则');
    return b;
  }
  async adopt(id: number, expected: string) {
    return this.serial.run(async () => {
      await this.compatible();
      const h = await this.current(id, expected);
      if (h.forward_host !== this.settings().forwardHost)
        throw new AppError(400, '该规则的转发主机不同，请继续在 NPM 管理');
      if (!h.domain_names[0].endsWith('.' + this.settings().baseDomain))
        throw new AppError(400, '域名不属于当前基础域名');
      const label = h.domain_names[0].slice(0, -this.settings().baseDomain.length - 1);
      if (label.includes('.')) throw new AppError(400, '仅支持基础域名下一级入口');
      const b: Binding = {
        npmId: id,
        project: '',
        service: '',
        containerPort: null,
        archived: false,
      };
      this.store.bind(b);
      const now = new Date().toISOString();
      this.store.operation({
        id: randomUUID(),
        key: randomUUID(),
        action: 'adopt',
        npmId: id,
        status: 'applied',
        error: null,
        createdAt: now,
        updatedAt: now,
        before: snapshot(h),
        after: snapshot(h),
        request: {},
      });
      return b;
    });
  }
  private async perform(
    action: string,
    id: number | null,
    key: string,
    before: Host | null,
    desired: Record<string, unknown>,
    binding: Omit<Binding, 'npmId'>,
    request: Record<string, unknown>,
  ): Promise<Operation> {
    const now = new Date().toISOString(),
      o: Operation = {
        id: randomUUID(),
        key,
        action,
        npmId: id,
        status: 'pending',
        error: null,
        createdAt: now,
        updatedAt: now,
        before: before ? snapshot(before) : null,
        after: null,
        request: { ...request },
      };
    // Persist recovery intent before any remote write.
    o.request = { ...request, _desired: desired, _binding: binding };
    this.store.operation(o);
    try {
      let result: Host;
      if (id === null) {
        result = await this.client().create({
          ...desired,
          meta: { pdm_operation: o.id },
          enabled: true,
          http2_support: true,
          block_exploits: true,
          caching_enabled: false,
          access_list_id: 0,
          advanced_config: '',
          locations: [],
          hsts_enabled: false,
          hsts_subdomains: false,
          trust_forwarded_proto: false,
        });
        o.npmId = result.id;
        this.store.operation(o);
      } else {
        await this.client().update(id, desired);
      }
      const actual = await this.client().get(o.npmId!);
      if (Object.entries(desired).some(([k, v]) => JSON.stringify(actual[k]) !== JSON.stringify(v)))
        throw new AppError(409, 'NPM 回读结果不一致，请检查外部修改');
      if (actual.meta?.nginx_online === false)
        throw new AppError(502, 'NPM 已保存规则，但 Nginx 未成功应用；请查看 NPM 错误日志');
      this.store.bind({ ...binding, npmId: actual.id });
      o.after = snapshot(actual);
      o.status = 'applied';
    } catch {
      o.status = 'needs_attention';
      o.error = '写入结果需要核对。请点击「核对未完成操作」，不要重复创建。';
    }
    o.updatedAt = new Date().toISOString();
    this.store.operation(o);
    return o;
  }
  async save(input: Input, key: string, id?: number, expected?: string) {
    return this.serial.run(async () => {
      const request = { input, ...(id ? { expected } : {}) },
        action = id ? 'update' : 'create';
      const old = this.store.byKey(key);
      if (old) {
        const normalized = { ...old.request };
        delete normalized._desired;
        delete normalized._binding;
        if (
          old.action !== action ||
          JSON.stringify(normalized) !== JSON.stringify(request) ||
          (id && old.npmId !== id)
        )
          throw new AppError(409, '操作标识与请求不匹配');
        if (old.status === 'applied') return old;
        throw new AppError(409, '该操作结果需要核对，请查看操作记录');
      }
      await this.compatible();
      let before: Host | null = null;
      if (id) {
        const b = this.requireManaged(id);
        if (b.archived) throw new AppError(409, '请先恢复归档入口');
        before = await this.current(id, expected || '');
      }
      const desired = await this.desired(input, id);
      const binding = {
        project: input.project,
        service: input.service,
        containerPort: input.containerPort,
        archived: false,
      };
      return this.perform(action, id || null, key, before, desired, binding, request);
    });
  }
  async change(
    id: number,
    action: 'enable' | 'disable' | 'archive' | 'restore',
    key: string,
    expected: string,
  ) {
    return this.serial.run(async () => {
      const old = this.store.byKey(key);
      if (old) {
        if (old.action !== action || old.npmId !== id || old.request.expected !== expected)
          throw new AppError(409, '操作标识与请求不匹配');
        if (old.status === 'applied') return old;
        throw new AppError(409, '该操作结果需要核对');
      }
      await this.compatible();
      const b = this.requireManaged(id),
        h = await this.current(id, expected);
      if (b.archived && action !== 'restore') throw new AppError(409, '请先恢复归档入口');
      const enabled = action === 'enable' || action === 'restore';
      if (enabled) {
        await this.checkConflict(h.domain_names[0], id);
        checkCertificate(
          (await this.client().certificates()).find((c) => c.id === h.certificate_id),
          h.domain_names[0],
        );
      }
      return this.perform(
        action,
        id,
        key,
        h,
        { enabled },
        { ...b, archived: action === 'archive' ? true : action === 'restore' ? false : b.archived },
        { expected },
      );
    });
  }
  async rollback(opId: string, key: string, expected: string) {
    return this.serial.run(async () => {
      const prior = this.store.operations().find((o) => o.id === opId);
      if (
        !prior?.before ||
        !prior.after ||
        !prior.npmId ||
        prior.action !== 'update' ||
        prior.status !== 'applied'
      )
        throw new AppError(400, '仅支持已成功编辑的规则回退');
      const old = this.store.byKey(key);
      if (old) {
        if (old.action === 'rollback' && old.request.source === opId && old.status === 'applied')
          return old;
        throw new AppError(409, '操作标识已使用');
      }
      await this.compatible();
      const b = this.requireManaged(prior.npmId),
        h = await this.current(prior.npmId, expected);
      if (b.archived || fingerprint(h) !== fingerprint(prior.after))
        throw new AppError(409, '规则在此次操作后又发生变化，不能直接回退');
      await this.checkConflict(prior.before.domain_names[0], h.id);
      checkCertificate(
        (await this.client().certificates()).find((c) => c.id === prior.before!.certificate_id),
        prior.before.domain_names[0],
      );
      return this.perform(
        'rollback',
        h.id,
        key,
        h,
        payload(prior.before),
        { ...b, project: '', service: '', containerPort: null },
        { source: opId },
      );
    });
  }
  async reconcile() {
    return this.serial.run(async () => {
      await this.compatible();
      const hosts = await this.client().hosts();
      for (const o of this.store.pending()) {
        const found = o.npmId
          ? hosts.find((h) => h.id === o.npmId)
          : hosts.find((h) => h.meta?.pdm_operation === o.id);
        const desired = o.request._desired as Record<string, unknown>;
        if (
          found &&
          desired &&
          Object.entries(desired).every(
            ([k, v]) => JSON.stringify(found[k]) === JSON.stringify(v),
          ) &&
          found.meta?.nginx_online !== false
        ) {
          o.npmId = found.id;
          o.after = snapshot(found);
          o.status = 'applied';
          o.error = null;
          this.store.bind({ ...(o.request._binding as Omit<Binding, 'npmId'>), npmId: found.id });
        } else {
          o.status = 'needs_attention';
          o.error = found
            ? '实际规则与预期不一致，请在 NPM 核对；工具不会覆盖。'
            : '未确认规则是否已创建，请在 NPM 核对后处理。';
        }
        o.updatedAt = new Date().toISOString();
        this.store.operation(o);
      }
      return this.store.operations();
    });
  }
}
