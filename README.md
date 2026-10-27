# dsh-qq

把 QQ 接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：一个 dsh 插件，负责

- 连 **OneBot v11**（NapCat / LLOneBot / Lagrange 都行）
- 白名单（只有指定 QQ 号能指挥它）、群聊 @、陌生人礼貌拒绝
- 消息串行排队 → 交给常驻的 SDK 子进程思考 → 拆段回复
- 设置页可视化：连接状态、白名单、测试发送、断开重连

> 它是 [dsh-heartbeat-inner](https://github.com/zy666946/dsh-heartbeat-inner) 的天然搭档：那个负责「什么时候主动找你」，这个负责「怎么跟你说话」。

## 架构

```
手机 QQ ──腾讯──▶ NapCat（协议端，独立进程）
                      │  OneBot v11 正向 WebSocket
                      ▼
              ┌───────────────┐
              │    dsh-qq     │  白名单 / 群@ / 排队
              └───────┬───────┘
                      │  JSON-RPC stdio（会话有记忆）
                      ▼
             dsh --profile qq  ← 常驻子进程
                      │
                      ▼
                 回复 → OneBot → 你
```

## 前置：一个 OneBot 协议端

推荐 [NapCat](https://napneko.github.io)（Linux 一键安装）：

```bash
mkdir -p ~/napcat && cd ~/napcat
curl -fL -o napcat-linux.sh https://raw.githubusercontent.com/NapNeko/napcat-linux-installer/main/install.sh
sudo bash napcat-linux.sh
bash ./launcher.sh -q <机器人QQ号>     # 首次扫码登录
```

装完后在 NapCat 的 WebUI（默认 `http://127.0.0.1:6099`）里加一个 **WebSocket 服务端**：

| 项 | 值 |
|---|---|
| Host | `127.0.0.1` |
| Port | `3001` |
| Token | 自己设一个 |
| 消息格式 | `array` |

或者直接改 `napcat/config/onebot11_<QQ号>.json`：

```json
{
  "network": {
    "httpServers": [], "httpSseServers": [], "httpClients": [],
    "websocketServers": [{
      "name": "dsh-qq", "enable": true, "host": "127.0.0.1", "port": 3001,
      "messagePostFormat": "array", "reportSelfMessage": false,
      "token": "你的token", "heartInterval": 30000
    }],
    "websocketClients": [], "plugins": []
  }
}
```

> ⚠️ 只绑 `127.0.0.1`。OneBot 端口暴露公网等于把 QQ 号送人。

## 安装插件

### 1. 建一个专用 profile

QQ 聊天需要一个**常驻 SDK 子进程**，而同一个 profile 不能被两个 dsh 实例同时用，所以给它单独建一个：

```bash
dsh --profile qq --from-default-profile sdk --dump-config
```

想让它也带上人格，可以在 `$DSH_HOME/profiles/qq/package.json` 的 `bundles` 里加你的 persona 插件。

### 2. 挂进 web profile

```bash
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
git clone https://github.com/zy666946/dsh-qq "$DSH_HOME/plugins/dsh-qq"
cd "$DSH_HOME/profiles/web"
mkdir -p node_modules
ln -sfn "$DSH_HOME/plugins/dsh-qq" node_modules/dsh-qq
```

`package.json` 里加两行：

```json
{
  "dependencies": { "dsh-qq": "link:../../plugins/dsh-qq" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-qq" ] } }
}
```

### 3. 配置

`$DSH_HOME/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- id: qq
  config:
    enabled: true
    onebotUrl: "ws://127.0.0.1:3001?access_token=你的token"
    selfId: "机器人QQ号"
    allowUsers: ["你的QQ号"]
    allowGroups: []          # 群号数组，空 = 不进群
    groupAtOnly: true        # 群里只在 @ 我时回
    politeReject: true       # 陌生人私聊礼貌拒绝
    profile: qq              # 上一步建的 profile
    dshBin: "/usr/local/bin/dsh"
    cwd: "/path/to/workspace"
    thinkPort: 3002          # /think 与 /api/qq/* 都在这
```

重启 dsh，**设置 → QQ** 就能看到状态和全部参数了。

## 设置页

| 区块 | 内容 |
|---|---|
| 状态 | 是否连上、登录昵称/QQ、运行时长、收到/回复/拒绝计数、最后一条消息 |
| 连接 | OneBot 地址、机器人 QQ 号、启用开关 |
| 谁能说话 | 私聊白名单、群白名单、群内 @ 开关、陌生人礼貌拒绝 |
| 思考引擎 | SDK profile、dsh 路径、工作目录 |

按钮：`保存并生效`、`断开重连`、`发条测试消息`、`刷新`。

保存写入 `$DSH_HOME/qq/config.json`，优先级高于 profile 配置，重启后保留。

## HTTP 接口

监听 `127.0.0.1:thinkPort`（默认 3002）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/qq/state` | 连接状态 + 统计 + 配置 |
| GET/POST | `/api/qq/config` | 读/写配置（热更新） |
| POST | `/api/qq/test` | 发测试消息 |
| POST | `/api/qq/reconnect` | 断开重连 |
| POST | `/api/qq/think` | 用 QQ 的会话问一句话 |
| POST | `/think` | 给 dsh-heartbeat 用的思考接口 |

## 自启动

插件本身随 dsh 启动。NapCat 是独立进程，建议用 systemd 托管：

```bash
sudo cp examples/napcat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now napcat
```

`examples/napcat.service` 里把 `WorkingDirectory`、`ExecStart` 改成你的实际路径。

## 排查

| 现象 | 原因 / 处理 |
|---|---|
| 设置页显示「未连接」 | NapCat 没启动，或地址/token 不对；看 `grep qq /var/log/dsh.log` |
| 连上了但收不到消息 | OneBot 的 WebSocket **服务端**没开，或端口不是 3001 |
| 收到消息但不回 | 你的号不在白名单；或 profile `qq` 没初始化（会卡在子进程启动） |
| 一直「正在想…」 | SDK 子进程的 profile 被别的实例占用 —— 换个 profile |
| 日志 `duplicate` | 插件被装载两次（HMR），已做幂等保护，可忽略 |

## 已知限制

- 只支持私聊 + 群聊 @，不支持频道/临时会话
- 单实例，不做多账号
- 消息串行处理：一条想完才处理下一条（避免上下文串台）
- 协议端有风控风险，强烈建议用**小号**

## License

MIT
