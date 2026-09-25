# 架构与实现决策

## 组件

浏览器 → Fastify API + React 静态页面 → NPM API / 受限 Docker reader；SQLite 保存关联、加密设置、会话和操作日志。

- `src/server/app.ts`：认证、来源校验、API 与前端服务。
- `manager.ts`：冲突校验、写入流程、归档、回退与对账。
- `npm.ts`：NPM 2.16.0 接口适配与登录刷新。
- `docker.ts`：读取服务、Compose 标签和端口映射。
- `checks.ts`：DNS、通过指定 NPM 主机进行 TLS/SNI 与 HTTP 检查。
- `store.ts`：SQLite、AES-256-GCM 密文、持久化操作。
- `scripts/docker-gateway.mjs`：只允许容器列表和指定容器详情两个 GET 端点，返回过滤后的元信息。

## ADR-001：宿主机端口转发

选用 `host.docker.internal:publishedPort`。它适配现有 Docker Desktop + 不同 Compose 网络，不需要工具修改业务网络。仅接受明确发布的 TCP 端口。回环绑定标为不支持自动选择，即使某些 Desktop 版本能从 VM 访问，也不依赖该行为。

替代方案为共享 Docker 网络，未来可扩展，当前不实施。服务身份使用项目名、服务名、容器端口，容器 ID 仅用于当前发现。停止容器仍可配置，服务不可达不会撤销规则。

## ADR-002：NPM 是实际规则来源

只通过 API 写入，不直接改 SQLite 或 Nginx 配置文件。NPM 2.16.0 已验证支持局部 PUT；修改只传必要字段。对完整可写字段生成稳定指纹，外部修改后旧表单不能保存。多域名、高级配置与路径路由规则不接管。

同一工具进程串行执行变更；仅支持一个应用副本。NPM UI 是独立写入者，无法实现真正跨系统原子锁；提交前和回读都检查状态，仍应避免同一时刻在两个界面编辑同一规则。

## ADR-003：明确处理不确定写入

写前保存操作意图；新建规则带随机操作标识 `meta.pdm_operation`。请求超时后不重试创建，而是查询标识与预期字段核对。应用重启后记录仍保留，操作记录页面可核对未完成操作。不会根据相同域名猜测某条规则就是本工具创建的。

如果实际结果不同、Nginx 未上线或目标不存在，保留“需要核对”，交由用户检查 NPM。v0.1 不自动补偿写入，避免覆盖可能已经发生的外部修改。成功的编辑可在未再次变化时显式回退。此行为比初始规划的自动补偿更保守，作为版本边界记录。

归档 = 禁用 NPM 规则 + 本地归档标记；恢复 = 清除标记 + 启用。不会永久删除任何规则或业务资源。

## ADR-004：凭据与权限

独立管理员使用 scrypt 哈希。会话令牌仅保留哈希，12 小时过期；Cookie 为 HttpOnly、SameSite=Strict，HTTPS origin 下开启 Secure。写请求必须满足固定 Origin、JSON 与 CSRF token 检查。初始化需要本机生成的引导密钥。

NPM 密码经 AES-256-GCM 加密后保存，密钥独立于数据库。NPM 令牌在内存中缓存，不发给浏览器。证书接口响应严格筛选，证书私钥和 DNS Token 不进入客户端或存储。

Docker reader 虽挂载 `docker.sock:ro`，安全边界是其端点白名单及字段过滤，而不是文件只读标记。只有 reader 挂载 socket；reader 网络不发布端口。应用有出站网络，容器只读文件系统、丢弃 capabilities。为兼容 Mac bind mount 的 0600 密钥文件，容器进程当前使用容器内 root；未使用 privileged，也没有宿主机 Docker socket。这是明确的部署取舍，后续可添加运行 UID 适配。

## ADR-005：检查结果分层

DNS 仅检查 A 记录并可匹配期望 IPv4。代理探测直连配置的 NPM 地址，带实际域名的 SNI/Host 并保持 TLS 验证。HTTP 401/403 表示服务响应但需要授权；5xx 标记异常。没有 HTTP 响应不等于确定的 TLS 错误，界面用 HTTPS 检查失败说明。

不抓取任意 URL，不跟随跳转，不将本机结果声称为手机网络验证。

## 数据与恢复

SQLite schema v1，WAL 模式。新版本 schema 不允许旧应用直接打开。查询界面展示最近 300 条操作，但未完成操作的对账不受此数量限制。当前不自动清理日志，运维需关注文件大小。操作快照排除 owner/用户信息及 NPM meta 中的其他数据。

备份使用 SQLite online backup API 获取一致性副本；密钥另存。工具停止不影响 NPM 代理。恢复工具数据库不能自动恢复 NPM 的实际配置，两者需核对。
