# Docker2Web

为 Docker Compose 项目绑定域名。在页面中选择服务和端口、填写子域名，Docker2Web 就会在 Nginx Proxy Manager（NPM）中创建对应的 HTTPS 入口。

适合已经用 NPM 管理本机 Docker 服务、经常添加新项目的用户。域名解析和证书沿用现有配置，业务请求由 NPM 转发。

## 使用前准备

当前版本面向一台 Docker 主机、一个 NPM 实例和一个基础域名。安装前需要准备：

- Docker Desktop 和 Node.js 22.22+。
- NPM 2.16.0，以及可管理代理规则、读取证书的邮箱和密码账号。其他 NPM 版本目前只能读取配置。
- 已解析到访问地址的子域名，以及 NPM 中覆盖这些域名的有效证书。经常添加项目时，可以使用泛域名解析和通配符证书。
- 已映射到宿主机端口、可供 NPM 访问的 Web 服务。

例如，项目端口映射为 `18080:3000`，绑定 `photos.example.com` 后，NPM 会将请求转发到 `host.docker.internal:18080`。

## 安装

在仓库根目录执行：

```sh
npm ci
npm run init
cp .env.example .env
docker compose up -d --build
```

打开 [http://127.0.0.1:3100](http://127.0.0.1:3100)，填写 `secrets/bootstrap-token` 文件中的初始化密钥，再设置至少 12 位的管理员密码。

### 连接 NPM

打开“连接设置”，按实际环境填写。以下为 Docker Desktop 的常见配置：

| 字段                      | 示例或说明                                        |
| ------------------------- | ------------------------------------------------- |
| NPM 管理地址              | `http://host.docker.internal:81`                  |
| 账号邮箱 / 密码           | NPM 账号                                          |
| 基础域名                  | `example.com`                                     |
| 默认转发主机              | `host.docker.internal`                            |
| NPM 代理地址 / HTTPS 端口 | `host.docker.internal` / `443`，用于访问检查      |
| 预期 DNS IPv4             | 可选；使用 Tailscale 时可填写 Mac 的 Tailscale IP |

点击“验证连接并保存”，待证书加载后，选择默认 HTTPS 证书并再次保存。

已有托管入口时，NPM 实例、基础域名和默认转发主机暂时无法更换，请在添加第一个入口前确认这三项。

### 从手机访问管理页面

默认管理页面只在本机开放。需要从手机访问时，在 NPM 中为 Docker2Web 配置 HTTPS 入口，并将 `.env` 中的 `APP_ORIGIN` 设为对应地址。具体网络配置见[运维手册](docs/OPERATIONS.md#手机管理入口)。

## 日常使用

1. 在“Docker 项目”中找到项目，选择 Web 服务及其映射端口。
2. 填写子域名，确认 HTTPS 证书和转发信息后保存。
3. 在“域名入口”中查看结果，使用“检查”排查 DNS、证书和 HTTP 访问问题。

入口可以编辑、启停或归档。归档会停用入口，恢复后重新启用。已有 NPM 规则需要先“接管”才能在这里编辑；多域名、通配符和自定义 Nginx 配置等复杂规则继续在 NPM 中管理。

新增容器或调整端口后，点击刷新，并按需修改入口。需要撤销最近一次编辑或核对保存结果时，可查看“操作记录”。

备份、升级和故障排查见[运维手册](docs/OPERATIONS.md)。现有部署沿用 `project-domain-manager` 的 Compose 项目名和镜像名，升级时保留即可。

## 本地开发

后端默认使用 3100 端口。如果 Docker 版正在运行，先执行 `docker compose stop app` 释放端口。

安装依赖并启动后端：

```sh
npm ci
npm run init
APP_ORIGIN=http://127.0.0.1:5173 npm run dev
```

在另一个终端启动前端：

```sh
npm run dev:web
```

浏览器打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。

### 检查与构建

```sh
npm run check
npm run format:check
npm test
npm run build
```

构建后执行 `npm start`，通过 [http://127.0.0.1:3100](http://127.0.0.1:3100) 访问。

集成测试使用独立的 NPM 测试实例：

```sh
npm run test:prepare
NODE_EXTRA_CA_CERTS=.runtime/test.crt npm run test:integration
```

测试结束后执行 `docker compose -f compose.integration.yaml down`。重新初始化测试环境的方法见[运维手册](docs/OPERATIONS.md#隔离测试重置)。

## 相关文档

- [运维、备份、升级与恢复](docs/OPERATIONS.md)
- [架构与决策](docs/ARCHITECTURE.md)
- [项目规划](docs/PLAN.md)
- [测试记录](docs/VALIDATION.md)
- [界面操作测试](docs/BUTTON-QA.md)
- [版本记录](CHANGELOG.md)
