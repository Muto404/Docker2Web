# 域名管家 · Project Domain Manager

为 Docker Compose 项目绑定子域名，通过 Nginx Proxy Manager 管理 HTTPS 入口。继续使用原始 Compose 部署，DNS 与证书保留在已有的 Cloudflare / NPM 中。

**v0.1.0：可试用版本，NPM 2.16.0 已验证。** 真实 NPM 集成与本机 Docker Desktop ARM64 部署通过；正式 NPM 接入和手机 Tailscale 网络验收需要完成初始化后进行。

## 能做什么

- 按 Compose 项目识别运行及停止的容器，读取宿主机映射端口。
- 选择服务、填写子域名、绑定已有 HTTPS 证书，创建 NPM 入口。
- 编辑、启用、停用、归档与恢复；现有 NPM 规则显式接管后才可编辑。
- 域名冲突、证书覆盖与有效期校验；更新前检测外部修改。
- 操作日志、最近编辑回退、超时后对账，避免重复创建。
- DNS、TLS 和 HTTP 检查；中文桌面与手机界面。
- 单管理员登录、加密 NPM 凭据、隔离的 Docker 元信息读取网关。

正常业务流量经过 NPM，不经过本工具。工具停止不会使已配置入口失效。

## 安装运行

需要 Docker Desktop 和 Node.js 22.13+（建议 22.22.0）。在仓库根目录执行：

```sh
npm ci
npm run init
cp .env.example .env
docker compose up -d --build
```

打开 **http://127.0.0.1:3100**。首次初始化需要读取本机 `secrets/bootstrap-token`，设置至少 12 位的管理员密码。不要把密钥粘贴到聊天、工单或 Git。

在“连接设置”填写：

| 字段                      | Docker Desktop 常见值                           |
| ------------------------- | ----------------------------------------------- |
| NPM 管理地址              | `http://host.docker.internal:81`                |
| 账号邮箱 / 密码           | 你的 NPM 账号；权限应包含目标代理管理、证书读取 |
| 基础域名                  | `example.com`                                   |
| 默认转发主机              | `host.docker.internal`                          |
| NPM 代理地址 / HTTPS 端口 | `host.docker.internal` / `443`                  |
| 预期 DNS IPv4             | Mac 的 Tailscale IP（可选校验）                 |

先保存连接，加载证书后选择覆盖 `*.example.com` 的证书，再保存。无须填写 Cloudflare Token。

例如 Compose 的 `ports: ["18080:3000"]`，工具将转发到 `host.docker.internal:18080`。

默认仅监听本机，适合初始化。为手机管理配置 HTTPS 域名时，按 [运维手册](docs/OPERATIONS.md) 设置固定 `APP_ORIGIN` 和 NPM 引导入口。业务项目原有访问方式不受此设置影响。

## 开发与验证

```sh
npm ci
npm run init
npm run dev
```

另一个终端启动前端热更新：

```sh
npm run dev:web
```

使用 Vite 时，后端需以 `APP_ORIGIN=http://127.0.0.1:5173 npm run dev` 启动，浏览器访问 `http://127.0.0.1:5173`。正式构建使用 `npm run build && npm start`，默认端口 3100。运行 Docker 版时应先停止本地同端口进程，反之亦然。

```sh
npm run check
npm run format:check
npm test
npm run build
```

隔离集成测试（不使用正式 NPM 数据卷）：

```sh
npm run test:prepare
NODE_EXTRA_CA_CERTS=.runtime/test.crt npm run test:integration
```

测试端口：18181、18443、18081；临时后端端口：18999。测试证书仅通过测试进程显式信任，不安装到系统信任库，也不向 ACME 申请真实域名证书。测试结束可 `docker compose -f compose.integration.yaml down`。完整重置流程见运维手册。

## 版本边界

- 仅支持单个 NPM 2.16.0 与单个 Docker 引擎；未知 NPM 版本禁止写入。
- 新建入口仅支持基础域名下一级子域名与已发布的 TCP Web 端口。不能自动判断 TCP 服务是不是 HTTP，需用户选中 Web 服务。
- 多域名、自定义 Nginx 配置、路径级路由、通配符代理规则只读。
- 回环专属映射、无发布端口、UDP 不自动代理；不改 Compose 或 Docker 网络。
- 归档可恢复，无永久删除按钮。恢复会启用入口。
- 发现和状态更新使用手动刷新；端口变化不会自动改规则，需编辑确认。
- 写入不确定时保留操作日志，人工触发对账；不盲目重试或自动覆盖。
- 已托管规则存在时不能更换 NPM 实例、基础域名或默认转发主机。
- 支持普通 NPM 密码登录；需要交互式 2FA 的账号暂不支持。
- 手机排版已检查，真实手机 Tailscale 访问尚需现场验收。

## 文档

- [项目规划](docs/PLAN.md)
- [架构与决策](docs/ARCHITECTURE.md)
- [运维、备份、升级与恢复](docs/OPERATIONS.md)
- [测试与交付记录](docs/VALIDATION.md)
- [版本记录](CHANGELOG.md)

源代码、测试和示例可提交；`.env`、`secrets/`、`data/`、`.runtime/` 和 `backups/` 均已排除。不要把本机环境目录加入 Git。
