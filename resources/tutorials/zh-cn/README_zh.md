<div align="center">

![](https://github.com/user-attachments/assets/fb90a4cc-2e54-495c-87ca-34c1a54bf2c8)

# OpenWebUI Monitor

[English](../../../README.md) / **简体中文**

</div>

专为 OpenWebUI 设计的用量监控和余额管理面板。在 OpenWebUI 中安装仓库附带的[过滤器函数](../../functions/openwebui_monitor.py)，即可记录模型用量、计算费用并统一管理用户余额。

> **兼容性说明：** 此 fork 跟随当前 OpenWebUI API，不再维护旧版本兼容。最近一次验证基于 OpenWebUI `v0.10.2`。更新 Monitor 时，请同时更新 OpenWebUI 中已安装的函数。

## 功能

- 为每个模型独立选择按量计费或按次计费
- 按量计费可配置输入价格、输出价格和模型倍率
- 按次计费只配置一个固定价格，不使用输入输出价格和倍率
- 余额与费用按百万分之一的整数精度保存，并显示六位小数
- 读取当前 OpenWebUI usage 数据，并在发送计费请求前移除大体积图片数据
- 按稳定的 OpenWebUI 用户 ID 同步权威用户列表，正确处理改名、删除和列表顺序
- 分别管理已用余额和剩余余额，可调整剩余余额并单独清零已用余额
- 将基础模型的计费配置同步到派生模型，并代理 OpenWebUI 中的当前模型图标
- 测试模型可用性、查看用量记录和图表，以及导入或导出数据库备份
- 使用 PostgreSQL 18 和 Chromium E2E 验证 Monitor 界面及 OpenWebUI API 契约

## 部署

此 fork 为 `linux/amd64` 和 `linux/arm64` 发布多架构镜像：

```text
ghcr.io/yuzukumo/openwebui-monitor:latest
```

### Docker Compose

仓库中的 [docker-compose.yml](../../../docker-compose.yml) 是持续维护的 Compose 配置：

```bash
git clone https://github.com/yuzukumo/OpenWebUI-Monitor.git
cd OpenWebUI-Monitor
cp .env.example .env
# 编辑 .env，填写下文列出的必填变量。
docker compose pull
docker compose up -d
```

默认情况下，宿主机通过 `http://127.0.0.1:3003` 访问 Monitor。`OPENWEBUI_DOMAIN` 必须能从 Monitor 容器访问，而函数中的 `Api Endpoint` 必须能从 OpenWebUI 容器访问。请将两个服务加入同一 Docker 网络，或者使用彼此可路由的地址。

全新部署 PostgreSQL 18 时，应像本仓库配置一样将数据卷挂载到 `/var/lib/postgresql`。已有的 PostgreSQL 17 或更早版本数据不能仅通过修改镜像标签完成升级；需要使用 `pg_upgrade` 迁移，只有确认不再需要旧数据时才能删除旧数据卷。

Vercel、外部 PostgreSQL、函数安装和更新方法见[部署指南](./deployment_guide_zh.md)。

### Vercel

[![Deploy on Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyuzukumo%2FOpenWebUI-Monitor&project-name=openwebui-monitor&repository-name=openwebui-monitor&env=OPENWEBUI_DOMAIN,OPENWEBUI_API_KEY,ACCESS_TOKEN,API_KEY)

Vercel 部署需要通过 `POSTGRES_URL` 或 `DATABASE_URL` 连接 PostgreSQL，同时必须保证 Vercel 部署能够访问 OpenWebUI。

## 环境变量

### 必填

| 变量                | 说明                                                                   | 示例                       |
| ------------------- | ---------------------------------------------------------------------- | -------------------------- |
| `OPENWEBUI_DOMAIN`  | Monitor 能访问的 OpenWebUI 基础地址                                    | `https://chat.example.com` |
| `OPENWEBUI_API_KEY` | 用于模型、图标、测试和用户接口的 OpenWebUI 管理员 API Key 或管理员 JWT | `sk-xxxxxxxxxxxxxxxx`      |
| `API_KEY`           | OpenWebUI 函数调用 Monitor inlet/outlet 接口时使用的共享密钥           | `generated-random-secret`  |
| `ACCESS_TOKEN`      | 登录 Monitor 并访问面板接口时使用的共享密钥                            | `another-random-secret`    |

OpenWebUI 必须启用 API Key。若启用了 API 端点限制，该凭证需要允许访问模型、模型图标、聊天补全和用户接口。用户同步会调用 `GET /api/v1/users/all`，因此凭证必须属于管理员。

### 可选

| 变量                               | 说明                                                                          | 默认值              |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------- |
| `POSTGRES_URL`                     | PostgreSQL 连接串，优先级高于单独的 `POSTGRES_*` 变量                         | 未设置              |
| `DATABASE_URL`                     | 未设置 `POSTGRES_URL` 时使用的备用 PostgreSQL 连接串                          | 未设置              |
| `POSTGRES_HOST`                    | PostgreSQL 主机                                                               | `db`                |
| `POSTGRES_PORT`                    | PostgreSQL 端口                                                               | `5432`              |
| `POSTGRES_USER`                    | PostgreSQL 用户名                                                             | `postgres`          |
| `POSTGRES_PASSWORD`                | PostgreSQL 密码                                                               | 未设置              |
| `POSTGRES_DATABASE`                | PostgreSQL 数据库名                                                           | `openwebui_monitor` |
| `DEFAULT_MODEL_INPUT_PRICE`        | 新模型默认输入价格，单位为每百万 tokens                                       | `60`                |
| `DEFAULT_MODEL_OUTPUT_PRICE`       | 新模型默认输出价格，单位为每百万 tokens                                       | `60`                |
| `DEFAULT_MODEL_PER_MSG_PRICE`      | 新模型默认按次价格；负数表示默认使用按量计费                                  | `-1`                |
| `INIT_BALANCE`                     | 新同步用户获得的初始剩余余额                                                  | `0`                 |
| `COST_ON_INLET`                    | 可选的 inlet 预扣费，可填写单一数值或 `gpt-4:0.32,gpt-4o:0.01` 形式的模型配置 | `0`                 |
| `OPENWEBUI_USERS_SYNC_INTERVAL_MS` | 两次 OpenWebUI 用户列表刷新之间的最短间隔                                     | `30000`             |

## 计费规则

按量计费时，配置的输入价格和输出价格是模型每百万 tokens 的价格，模型倍率会同时作用于两项价格：

```text
计费价格 = 配置价格 x 模型倍率
```

倍率不为 `1` 时，模型页会将计算后的价格作为主价格，并在下方用灰色小字和删除线显示配置价格。按次计费只收取固定的按次价格，不应用倍率。

按量计费会以定点整数完成“配置价格 × 模型倍率 × tokens”的计算，只在生成最终费用时舍入一次。所有金额都以六位小数精度持久化。切换界面语言只会改变显示的货币符号，不会进行汇率换算。

## 函数配置

在 OpenWebUI 中使用 [openwebui_monitor.py](../../functions/openwebui_monitor.py) 创建过滤器函数，然后配置：

| Valves 配置    | 说明                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `Api Endpoint` | OpenWebUI 容器能够访问的 Monitor 基础地址；共享 Docker 网络中可使用 `http://openwebui-monitor-app:3000` |
| `Api Key`      | 与 Monitor `API_KEY` 完全相同的值                                                                       |
| `Language`     | 状态消息语言：`en` 或 `zh`                                                                              |

请全局启用该函数，使普通对话请求经过 inlet、stream 和 outlet。按次计费依据没有失败标记的完成回调，而不是补全 token 数，因此成功的生图响应即使上游返回 0 个输出 token，也会正常收取固定价格。部分自定义 Pipe 会把异常包装成 SSE 后继续进入 outlet，函数会在 stream 阶段识别并标记这类明确错误，失败请求和未进入 outlet 的取消请求都不会通过 outlet 扣费；显式配置的 `COST_ON_INLET` 预扣除是独立逻辑。

## 更新

每次向此 fork 推送代码，GitHub Actions 都会构建并向 GHCR 发布多架构 `latest` 镜像。Docker 部署的更新命令：

```bash
docker compose pull
docker compose up -d
```

仓库内函数发生变化时，应在同一次更新中将 OpenWebUI 里已安装的函数替换为当前版本。

## 测试

默认 E2E 会先在不启动 OpenWebUI 的情况下检查过滤器的成功/失败状态处理，再启动 PostgreSQL 18、模拟 OpenWebUI 服务、真实 Monitor 应用，并使用 Chromium 的桌面与移动端视口进行验证。覆盖零输出 token 的按次计费、Monitor 页面、当前 OpenWebUI API 调用、用户同步、模型定价、计费精度、模型图标、数据库迁移和余额操作。

```bash
pnpm e2e:install
pnpm e2e:owu
```

较慢的完整测试会启动官方 `ghcr.io/open-webui/open-webui:latest-slim` 镜像：

```bash
pnpm e2e:owu:full
```

测试产物写入已被 Git 忽略的 `artifacts/e2e/` 目录。

## 常见问题

### 为什么用户管理页面没有用户？

Monitor 从 `GET /api/v1/users/all` 同步用户。请确认 `OPENWEBUI_DOMAIN` 可访问，并确认 `OPENWEBUI_API_KEY` 是有权调用该接口的管理员凭证。用户以 OpenWebUI ID 匹配，因此改名不会创建重复用户，删除用户后也会在下次同步时从 Monitor 列表移除。

### 已用余额和剩余余额有什么区别？

已用余额是用户累计消耗的金额，剩余余额是后续请求仍可使用的金额。清零已用余额不会改变剩余余额。

### 模型图标保存在哪里？

Monitor 不持久化模型图标，而是通过短期 HTTP 缓存代理 OpenWebUI 中的当前图标。因此模型删除后，不会在 Monitor 存储中留下对应图片文件。
