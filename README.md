# Docker2Web

为 Docker 项目绑定域名

为 Docker Compose 项目绑定子域名，通过 Nginx Proxy Manager 管理 HTTPS 入口。继续使用原始 Compose 部署，DNS 与证书保留在已有的 Cloudflare / NPM 中。

Docker2Web 的 Compose 项目名、镜像名和外部网络名仍保留 `project-domain-manager`，用于兼容已有部署、数据卷和 NPM 网络配置。

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

需要 Docker Desktop 和 Node.js 22.22+（建议 22.22.0）。在仓库根目录执行：

```sh
npm ci
npm run init
cp .env.example .env
docker compose up -d --build
```

打开 [http://127.0.0.1:3100](http://127.0.0.1:3100)。

首次初始化时，读取本机 `secrets/bootstrap-token` 中的初始化密钥，并设置至少 12 位的管理员密码。不要把密钥粘贴到聊天、工单或 Git。

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

## 适用范围

当前版本适合一台 Docker 主机、一个 NPM 实例和一个基础域名的使用场景。NPM 需使用 2.16.0 版本，通过邮箱和密码登录；其他版本目前只能读取配置。

项目需要先映射 Web 服务端口，再绑定形如 `photos.example.com` 的子域名。多域名、通配符和自定义 Nginx 配置等复杂规则，请继续在 NPM 中管理。

新增容器或调整端口后，点击刷新查看变化，并按需修改入口。已有托管入口时，NPM 实例、基础域名和默认转发主机暂时无法更换，首次设置时请确认这三项。

## 文档

- [项目规划](docs/PLAN.md)
- [架构与决策](docs/ARCHITECTURE.md)
- [运维、备份、升级与恢复](docs/OPERATIONS.md)
- [测试与交付记录](docs/VALIDATION.md)
- [版本记录](CHANGELOG.md)
