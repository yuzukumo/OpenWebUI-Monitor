# OpenWebUI Monitor 部署指南

OpenWebUI Monitor 需要：

- 当前版本的 OpenWebUI
- PostgreSQL
- Monitor 能够访问 OpenWebUI
- OpenWebUI 能够访问 Monitor
- 当前版本的 [OpenWebUI Monitor 过滤器函数](../../functions/openwebui_monitor.py)

最近一次集成验证基于 OpenWebUI `v0.10.2`。此 fork 跟随当前 OpenWebUI API，不再面向旧版 OpenWebUI。

## 一、使用 Docker Compose 部署

推荐使用 Docker Compose。仓库维护的配置使用公开多架构镜像 `ghcr.io/yuzukumo/openwebui-monitor:latest` 和 PostgreSQL 18。

### 1. 准备配置

```bash
git clone https://github.com/yuzukumo/OpenWebUI-Monitor.git
cd OpenWebUI-Monitor
cp .env.example .env
```

在 `.env` 中至少设置以下内容：

```dotenv
OPENWEBUI_DOMAIN=https://chat.example.com
OPENWEBUI_API_KEY=your-openwebui-admin-api-key-or-jwt
ACCESS_TOKEN=your-monitor-login-secret
API_KEY=your-function-shared-secret
```

- `OPENWEBUI_DOMAIN` 由 Monitor 容器访问。除非 OpenWebUI 与 Monitor 位于同一容器，否则不能使用 `127.0.0.1`。
- `OPENWEBUI_API_KEY` 必须属于 OpenWebUI 管理员。OpenWebUI 需要启用 API Key；若开启了端点限制，需要放行 `/api/models`、`/api/v1/models/model/profile/image`、`/api/chat/completions` 和 `/api/v1/users/all`。
- `ACCESS_TOKEN` 用于保护 Monitor 界面和面板接口。
- `API_KEY` 只用于 OpenWebUI 函数与 Monitor inlet/outlet 接口之间的鉴权。

请为 `ACCESS_TOKEN` 和 `API_KEY` 分别生成独立的随机值。它们不需要是 OpenWebUI JWT 或 API Key。

### 2. 启动 Monitor

```bash
docker compose pull
docker compose up -d
```

宿主机默认通过 `http://127.0.0.1:3003` 访问。容器在 Docker 网络内监听 `3000` 端口。

```bash
docker compose ps
docker compose logs -f openwebui-monitor
```

### 3. PostgreSQL 18 数据目录

仓库内置数据库将数据卷挂载到 `/var/lib/postgresql`，与 PostgreSQL 18 镜像的数据目录布局一致。

不要让 PostgreSQL 18 直接使用之前挂载在 `/var/lib/postgresql/data` 的 PostgreSQL 17 或更早版本数据卷。请选择一种处理方式：

1. 需要保留数据时，使用 `pg_upgrade` 或导出再导入完成 PostgreSQL 大版本迁移。
2. 确认旧 Monitor 数据可以丢弃时，停止服务并删除旧数据卷，再启动 PostgreSQL 18。

删除数据卷不可恢复。执行前必须核对卷名，并备份所有需要保留的数据。

### 4. 使用外部 PostgreSQL

应用支持 `POSTGRES_URL`、`DATABASE_URL` 或单独的 `POSTGRES_*` 变量。将仓库 Compose 配置改为使用外部数据库时，需要移除内置的 `openwebui-monitor-db` 服务和应用服务中的 `depends_on`，然后填写外部数据库连接参数。应用启动时会自动创建并迁移数据表。

## 二、使用 Vercel 部署

[![Deploy on Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyuzukumo%2FOpenWebUI-Monitor&project-name=openwebui-monitor&repository-name=openwebui-monitor&env=OPENWEBUI_DOMAIN,OPENWEBUI_API_KEY,ACCESS_TOKEN,API_KEY)

1. 使用上方按钮部署此 fork。
2. 在 Vercel 项目中添加 `OPENWEBUI_DOMAIN`、`OPENWEBUI_API_KEY`、`ACCESS_TOKEN` 和 `API_KEY`。
3. 创建或连接 PostgreSQL 服务，并将连接串提供为 `POSTGRES_URL` 或 `DATABASE_URL`。
4. 所有环境变量配置完成后重新部署。

Vercel 必须能够访问 OpenWebUI，同时 OpenWebUI 容器也必须能够访问 Vercel 提供的 Monitor 地址，因为该地址将作为函数的 `Api Endpoint`。

## 三、安装 OpenWebUI 函数

当前支持的集成方式是 [openwebui_monitor.py](../../functions/openwebui_monitor.py)。

1. 使用管理员账号登录 OpenWebUI，打开函数页面。
2. 创建函数，粘贴 `openwebui_monitor.py` 的当前内容并保存。
3. 配置函数 Valves：

| 配置           | 值                                                         |
| -------------- | ---------------------------------------------------------- |
| `Api Endpoint` | OpenWebUI 能访问的 Monitor 基础地址，不要附加具体 API 路径 |
| `Api Key`      | 与 Monitor `API_KEY` 相同的值                              |
| `Language`     | `en` 或 `zh`                                               |

4. 全局启用该函数。

在共享 Docker 网络中，`Api Endpoint` 可以直接使用 Monitor 容器名和内部端口：

```text
http://openwebui-monitor-app:3000
```

如果 OpenWebUI 与 Monitor 属于不同的 Compose 项目，请将它们接入同一外部网络，或使用 OpenWebUI 容器能够路由到的地址。宿主机绑定的 `127.0.0.1:3003` 并不是 OpenWebUI 容器自身回环地址。

函数会在请求前向 `/api/v1/inlet` 发送请求信息，并在完成后将带有上游 usage 的消息发送到 `/api/v1/outlet`。按次计费不使用补全 token 数判断成功与否，成功的生图响应即使输出 token 为 0 也会正常计费。部分自定义 Pipe 会把异常包装成 SSE 后继续进入 outlet，函数会在 stream 阶段识别并标记这类明确错误，使失败请求不被计费；未进入 outlet 的取消请求同样不会通过 outlet 扣费。发送前会移除大体积内联图片数据。更新 Monitor 时，请保持 OpenWebUI 中安装的函数与仓库版本一致。

## 四、配置模型计费

使用 `ACCESS_TOKEN` 登录 Monitor 后，打开模型管理页面。

### 按量计费

填写输入价格、输出价格和模型倍率。价格单位为每百万 tokens：

```text
输入计费价格 = 输入价格 x 模型倍率
输出计费价格 = 输出价格 x 模型倍率
```

### 按次计费

只填写固定的按次价格。此模式下不会使用输入输出价格，也不会应用模型倍率。

对于 OpenWebUI 派生模型，同步操作会从基础模型复制计费方式和相关价格字段。

## 五、更新

每次向此 fork 推送代码，GitHub Actions 都会分别使用原生 `amd64` 和 `arm64` runner 构建镜像，并向 GHCR 发布多架构 `latest` manifest。

```bash
docker compose pull
docker compose up -d
```

同时检查 `resources/functions/openwebui_monitor.py` 是否有变化，并更新 OpenWebUI 中已安装的函数。

## 六、验证

1. 通过 `http://127.0.0.1:3003` 或反向代理地址打开 Monitor，使用 `ACCESS_TOKEN` 登录。
2. 确认模型页能够从 OpenWebUI 加载模型和图标。
3. 确认用户页与当前 OpenWebUI 用户列表一致。
4. 配置一个模型的价格，然后在 OpenWebUI 中使用该模型完成一条消息。
5. 确认状态提示、用量记录、已用余额和剩余余额显示同一笔费用。

如果响应在 OpenWebUI 调用函数 outlet 之前被停止，该请求不会通过 outlet 扣费。同样，绕过全局函数钩子的 OpenWebUI 辅助请求也无法被 Monitor 观测；显式配置的 `COST_ON_INLET` 预扣除不受此规则影响。
