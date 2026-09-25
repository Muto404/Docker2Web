# 运维手册

## 初始化

仓库根目录运行 `npm ci`、`npm run init`、`docker compose up -d --build`。默认管理入口 `http://127.0.0.1:3100`。本机查看 `secrets/bootstrap-token`，在页面设定管理员密码。密钥只在本机使用，无需发给开发者。

NPM 账号要求能够看到需要管理的规则、编辑这些规则并读取对应证书。v0.1 已用隔离实例管理员账号验证；受限账号的具体授权组合尚未完成实测，若使用非管理员账号请先验证可见范围，不能假设它能检测到无权查看的规则冲突。

连接设置先保存账号，再选择已有证书。NPM 默认地址是容器可达的 `http://host.docker.internal:81`，不是容器自己的 `localhost:81`。

## 手机管理入口

业务服务的手机访问与工具自己的手机管理入口是两件事。默认工具只在本机开放，现有业务入口不受影响。

需要远程管理时，在 NPM 独立创建一个工具入口（如 `manager.example.com`），转发到宿主机工具端口，并绑定现有证书。为避免自锁，这条引导规则不通过工具自身创建/修改。

可选择：

1. 保持本机端口绑定，在 NPM 的 Compose 配置中持久化加入 `project-domain-manager_outbound` 外部网络，转发到该网络中的工具服务别名 `app:3100`；实际环境若别名冲突应设置唯一网络别名。这需要一次明确的 NPM 网络调整。
2. 按你的网络策略把工具端口绑定到 NPM 可访问的宿主机地址，并使用 `host.docker.internal:3100`。`0.0.0.0` 会扩大到局域网接口，不能视为仅 Tailscale 暴露；需要明确接受或通过防火墙限制。

将 `.env` 中 `APP_ORIGIN` 改为唯一 HTTPS 域名，重新 `docker compose up -d`。工具自动保护该域名，也可以在设置中增加其他受保护域名。启用 HTTPS origin 后不要继续从 HTTP localhost 登录；如入口故障，可临时改回本机 origin 并重建工具容器恢复管理。手机需要连接 Tailscale 且有访问权限。

正式环境 DNS、证书和手机链路的验收需要在这些设置完成后进行，不能用测试域名验证替代。

## 常用命令

```sh
docker compose ps
docker compose logs --tail 100 app
docker compose logs --tail 100 docker-reader
docker compose restart app
```

不要随意升级 NPM `latest`；工具只允许已验证的 2.16.0 写入。升级 NPM 前先运行隔离兼容测试。

## 备份

在宿主机仓库目录执行 `npm run backup`（需要 Node 22.22+）。使用 SQLite online backup，应用可继续运行；输出在 `backups/时间戳/pdm.sqlite`。

独立、安全地备份 `secrets/encryption-key`、`secrets/bootstrap-token` 和部署 `.env`。数据库备份不包含密钥。定期备份 NPM 自身的 `/data` 与 `/etc/letsencrypt` 持久化目录，它们不属于工具备份。

## 恢复

1. `docker compose stop app`。
2. 先保存当前 `data/` 副本，再用选定备份替换 `data/pdm.sqlite`。
3. 仅在应用停止后清理旧 `data/pdm.sqlite-wal` / `data/pdm.sqlite-shm`，避免旧 WAL 与备份混用。
4. 恢复对应的 `secrets/encryption-key`。密钥不匹配会导致 NPM 凭据无法解密。
5. `docker compose up -d app`，登录后检查连接、入口和操作记录。
6. 工具数据与 NPM 实际规则可能处于不同时间点，先核对，不自动用旧数据库覆盖 NPM。

忘记工具密码时，可在应用停止并备份后，用本机 Node SQLite 工具删除 `kv` 中的 `admin` 键并清空 `sessions`，重新使用本机引导密钥初始化；不会影响业务入口。不要通过网页开放免密重置接口。

## 升级与回退

升级前保存数据库与匹配密钥，并记录当前 Git commit。拉取指定版本，运行测试后构建，再 `docker compose up -d`。

回退使用原 commit 重建。若数据库 schema 高于旧程序支持版本，先按上述步骤恢复对应备份，不能直接强行降级 schema。规则回退使用工具里的操作快照；不推荐通过 NPM 整库覆盖来撤销单个入口的修改。

## 故障排查

| 现象                     | 处理                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| 请求来源不匹配           | 使用与 `APP_ORIGIN` 完全一致的协议、主机、端口；localhost 与 127.0.0.1 也不同 |
| Docker 未连接            | 确认 Docker Desktop 运行、reader 的 socket 挂载正确，并检查 reader 日志       |
| NPM 连接失败             | 容器中使用 host.docker.internal；检查 81 端口、账号权限和版本                 |
| 保存结果需要核对         | 点击操作记录中的核对按钮；仍不一致则在 NPM 检查，不要换名字盲目重建           |
| 规则已在其他位置修改     | 刷新列表重新编辑，不覆盖旧表单                                                |
| 502 / 504                | 检查业务容器启动、宿主机映射端口和应用监听地址                                |
| 401 / 403                | 应用或 NPM Access List 需要认证，不一定是代理故障                             |
| DNS 失败但 TLS/HTTP 成功 | 检查公开 A 记录、解析缓存、具体记录覆盖泛域名的情况                           |
| 手机打不开、本机通过     | 确认手机开启 Tailscale、设备权限、DNS 与访问网络                              |
| 未找到原服务             | 保留现有规则，检查 Compose 项目/服务名；必要时明确重新绑定                    |

## 隔离测试重置

`compose.integration.yaml` 只用于测试。停止后可以明确清理其测试数据：

```sh
docker compose -f compose.integration.yaml down -v
```

此命令会删除该 Compose 项目的测试卷。随后删除 `.runtime/integration/`、`.runtime/npm-credentials.json`、`.runtime/test.crt`、`.runtime/test.key` 再运行 `npm run test:prepare`，避免旧凭据、证书和旧绑定相互混用。不要把正式 NPM 数据目录挂到测试配置中。

当前 v0.1 没有自动日志清理；API 历史只展示最近 300 条，完整日志仍留在 SQLite。备份时检查磁盘使用量。

## Docker Desktop 宿主机 443 回连超时

如果 DNS 正常、Mac 上访问返回 200，但容器内经 `host.docker.internal:443` 的 TLS 检查超时，可以让域名管家加入现有 NPM 网络：

```sh
# 默认 NPM 网络为 npm_default；不同名称可通过 NPM_NETWORK 指定。
docker compose -f compose.yaml -f compose.npm-network.yaml up -d --build
```

在连接设置中将「NPM 代理地址」改为 NPM 容器名（例如 `npm-npm-1`），端口仍为 443。管理地址和业务转发主机不需要随之改变。要让后续普通 `docker compose up -d` 保留网络覆盖，可在本地 `.env` 增加 `COMPOSE_FILE=compose.yaml:compose.npm-network.yaml`（macOS/Linux）。外部 NPM 网络应先存在。域名管家的 Docker reader 仍然只加入内部 reader 网络。

如果命令行直连域名正常、浏览器访问超时，检查系统代理是否将该私有域名转发到了外部代理。可在代理软件中为自己的私有域名设置直连规则；不要关闭 TLS 验证。
