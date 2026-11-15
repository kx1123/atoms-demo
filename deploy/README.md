# Docker 部署

应用、网关、网络和 SQLite 数据卷均属于独立的 `atoms-demo` Compose 项目。真实模型配置放在服务器 `/opt/atoms-demo/shared/runtime.env`，权限 `600`，不进入源码目录、镜像或 Git。

## 首次启动

1. 将不包含 `.env.local`、数据库和构建产物的源码放到独立 release 目录。
2. 参考 `runtime.env.example` 创建真实运行配置，设置最终访问地址为 `ATOMS_PUBLIC_ORIGIN`。
3. 在 release 目录执行以下命令，替换版本号。

```sh
ATOMS_RELEASE=YOUR_RELEASE docker compose -p atoms-demo -f deploy/compose.yml build app
ATOMS_RELEASE=YOUR_RELEASE docker compose -p atoms-demo -f deploy/compose.yml up -d --wait
```

网关仅映射到宿主机 `127.0.0.1:3100`。由宿主机边缘代理添加独立虚拟主机并转发，保留 Host、覆盖 X-Real-IP、关闭代理缓冲，读超时至少 660 秒。若需要 HTTPS，使用该虚拟主机独立的证书与 HTTP 验证目录；不能替换现有站点的配置或证书。

网关以 `nginx.conf` 中 `set_real_ip_from` 指定的宿主入口为可信来源。首次部署后用 `docker network inspect atoms-demo_atoms` 核对 gateway 地址；如果网络重建后地址变化，更新此条再部署。不要把 app 的 3000 端口直接暴露到公网。

## 验证与更新

检查容器健康、外网首页和 `/api/status`，再验证真实生成、连续修改、版本恢复及重建容器后的数据保留。部署目录内的 `release.json` 保存源码文件哈希；镜像 tag 对应 release，便于定位运行版本。

示例配置将匿名会话限制为每天 12 次、同网络每天 20 次、全站每天 50 次、最多同时 2 个生成任务；每个任务最多调用模型两次。它们是任务次数上限，不能替代供应商账户的金额预算。

更新时构建新 tag，再用新 release 的 Compose 启动；数据卷沿用 `atoms-demo_atoms-data`。真实 env 文件保持在 shared 目录。首次验收可用 `up -d --force-recreate` 检验容器重建后保存的数据是否还在。

## 回滚与停止

回滚代码时，使用前一个保留 release 的 tag 和 Compose 文件执行 `up -d --no-build --wait`。启动前检查数据库结构是否向后兼容，避免旧代码误读新增结构。恢复代码版本不会回滚项目数据。

```sh
ATOMS_RELEASE=PREVIOUS_RELEASE docker compose -p atoms-demo -f /path/to/previous/deploy/compose.yml up -d --no-build --wait
```

停止服务使用当前 Compose 的 `down`，保留数据卷、env、release 和镜像。不要添加 `-v`。如需撤下公网入口，仅移除本项目新增的虚拟主机文件，配置检查通过后平滑 reload。

真实 env、TLS 私钥、数据库及验收 artifacts 均不应提交 Git。上传包使用源码白名单，构建时 `.dockerignore` 再次排除真实配置；镜像只在运行时读取 env。

模型调用默认每次最多等待 300 秒，连续 90 秒没有有效输出则停止；生成与自动修复分别计时。可用 `MODEL_TIMEOUT_MS` 和 `MODEL_IDLE_TIMEOUT_MS` 调整。服务商支持时，设置 `MODEL_THINKING=disabled` 可关闭额外思考开销；不支持该参数的服务商应留空。模型、地址和认证令牌仍完全由 env 提供。
