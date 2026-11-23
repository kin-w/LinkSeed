<p align="center">
  <img src="https://raw.githubusercontent.com/kin-w/LinkSeed/main/static/logo.svg" width="96" height="96" alt="logo">
</p>

<h1 align="center">链种工坊 LinkSeed</h1>

<p align="center">自托管的 ED2K 链接与 BT 种子工作台：批量计算 ED2K、制作 / 解析 / 编辑种子，并一键推送到 115 离线与 qBittorrent。</p>

<p align="center">
  <a href="https://hub.docker.com/r/ikimi/linkseed"><img src="https://img.shields.io/docker/pulls/ikimi/linkseed" alt="pulls"></a>
  <a href="https://github.com/kin-w/LinkSeed/actions/workflows/docker-publish.yml"><img src="https://github.com/kin-w/LinkSeed/actions/workflows/docker-publish.yml/badge.svg" alt="build"></a>
</p>

---

## 它解决什么问题

想给 NAS / 网盘整理资源时，常常要同时维护 ED2K 链接、BT 种子和磁力链：本地算哈希要装工具，做种子要装客户端，做完还要手动传到 115 或 qBittorrent。这个项目把这些步骤合到一个浏览器页面里：

- 选文件夹、点上传或直接读服务器目录，后台自动算 ED2K 哈希
- 已上传的文件可以直接打包成种子，不必重复上传
- 种子里可内嵌 ED2K 链接，解析种子能把文件反查成 ED2K
- 生成结果与操作历史保留下来，随时推送、复制、导出

界面参考 Apple 设计规范，桌面、平板、手机竖屏 / 横屏都可直接操作。

## 功能

| 能力 | 说明 |
|---|---|
| ED2K 批量生成 | 上传单文件、多文件或整个文件夹，后台异步计算 MD4，生成标准 `ed2k://` 链接 |
| 服务器目录直读 | 宿主机目录挂载为 `/host`，界面中直接选择文件计算，大文件无需上传；删除记录不影响原文件 |
| 分片上传与续传 | 浏览器按 4 MiB 分片上传，刷新后重新添加同一文件可从断点继续 |
| 链接导入 | 粘贴含 `ed2k://` 的任意文本，自动提取、去重并规范化 |
| BT 种子制作 | 自定义名称、Tracker、注释、分块大小（16 KiB–128 MiB）、私有标记，可选内嵌 ED2K |
| BT 种子解析 | 导入 `.torrent`，按路径与大小匹配已上传文件，批量转换为 ED2K 链接 |
| 种子编辑 | 查看文件树与元数据，批量修改 Tracker、私有标记、分块等后保存下载 |
| 磁力链 | 由种子信息哈希生成标准磁力链，可复制或加入历史 |
| 历史记录 | 种子与 ED2K 记录统一留存，可推送 115 / qB、复制、移除、导出 TXT，重启后仍在 |
| 跨模块复用 | 在制作种子、解析种子、ED2K 之间共用同一份文件数据，不重复上传 |
| 推送 115 离线 | 配置 Cookie 后，把种子或 ED2K 链接推送到 115 离线下载 |
| 推送 qBittorrent | 支持多个 qB 实例，自动读取默认下载目录，并按实例记忆做种保存路径 |
| 登录鉴权 | 设置密码后必须登录，连续失败锁定、会话持久化、30 天免登录 |
| 设置持久化 | 主题、分块、Tracker、内嵌 ED2K 等偏好保存在服务端，换浏览器 / 重建容器不丢 |
| 响应式 | 桌面双栏、移动端单栏 + 底部操作条，弹窗在小屏自动变为抽屉 |

## 快速开始

### 一键部署（推荐）

在服务器上以 root 执行，脚本会自动安装 Docker、拉取镜像、生成 compose 并启动：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/kin-w/LinkSeed/main/install.sh) -p 你的访问密码
```

也可以用 wget：

```bash
bash <(wget -qO- https://raw.githubusercontent.com/kin-w/LinkSeed/main/install.sh) -p 你的访问密码
```

默认全盘模式（宿主机 `/` 以只读方式挂载到容器 `/host`），执行完会直接打印访问地址和密码。

常用组合：

```bash
# 只开放媒体目录，端口改成 9000
bash install.sh -p mypass -P 9000 -d /home/media

# 使用镜像加速 + 自定义数据目录
bash install.sh -p mypass -m docker.1panel.live -c /root/linkseed/data
```

| 参数 | 说明 | 默认值 |
|---|---|---|
| `-p` | 访问密码 | 不填则随机生成并打印 |
| `-P` | Web 端口 | `5566` |
| `-d` | 挂载的宿主机目录（只读） | `/`（全盘模式） |
| `-c` | 数据存放目录 | `/opt/linkseed/data` |
| `-n` | 容器名称 | `linkseed` |
| `-u` | Docker Hub 用户名 | `ikimi` |
| `-T` | 镜像标签 | `latest` |
| `-m` | 镜像加速前缀 | 空 |
| `-t` | 时区 | `Asia/Shanghai` |
| `-h` | 显示帮助 | — |

脚本可重复执行：检测到同名容器会先删除再重建，数据目录保留，上传文件、历史与设置不会丢。

### docker compose

仓库根目录的 [docker-compose.yml](docker-compose.yml) 已给出完整配置，启动前先修改访问密码：

```bash
docker compose up -d --build
```

启动后访问 `http://服务器IP:5566`。

### docker run

```bash
docker run -d --name linkseed --restart unless-stopped \
  -p 5566:5566 \
  -e TZ=Asia/Shanghai \
  -e ED2K_PASSWORD=你的访问密码 \
  -e ED2K_ROOTS=/host \
  -v ./data:/data \
  -v /:/host:ro \
  ikimi/linkseed:latest
```

Windows PowerShell 中挂载路径请使用 `${PWD}/data:/data`。

### 更新 / 升级

镜像使用 `latest` 标签，发布新版本后拉取并重建容器即可，`./data` 会保留：

```bash
docker compose pull && docker compose up -d
```

用 `docker run` 部署时，先 `docker rm -f linkseed` 再重新执行原命令。

### 路径对应

容器里的 `/` 是镜像自己的文件系统，宿主机根目录挂在 `/host`：

| 宿主机 | 界面里显示 |
|---|---|
| `/` | `/host` |
| `/home/media` | `/host/home/media` |
| `/mnt/disk2/iso` | `/host/mnt/disk2/iso` |

> 全盘只读挂载后界面可浏览整机文件名与大小，请务必设置 `ED2K_PASSWORD`，或改为只挂载需要的目录。

### 只开放部分目录

```yaml
volumes:
  - /home/media:/data2:ro
environment:
  ED2K_ROOTS: /data2
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TZ` | `UTC` | 时区，影响日志与历史时间 |
| `ED2K_PASSWORD` | 空 | 访问密码；留空则无需登录（不推荐公网使用） |
| `ED2K_PORT` | `5566` | 容器内监听端口 |
| `ED2K_HOST` | `0.0.0.0` | 监听地址 |
| `ED2K_DATA` | `/data` | 数据目录（上传、索引、种子、设置、会话） |
| `ED2K_ROOTS` | `/host` | 允许浏览的服务器目录，多个用 `:` 分隔 |
| `ED2K_HASH_WORKERS` | `2` | 并行哈希文件数，机械硬盘建议 1–2 |
| `ED2K_MAX_FILE_SIZE` | `0` | 单文件大小上限（字节），`0` 不限制 |
| `ED2K_MAX_TOTAL_SIZE` | `0` | 所有文件总大小上限（字节），`0` 不限制 |
| `ED2K_MAX_FILES` | `0` | 文件数量上限，`0` 不限制 |
| `ED2K_HISTORY_LIMIT` | `300` | 历史记录保留条数（最小 20） |
| `ED2K_QB_BLOCK_PRIVATE` | 关闭 | 设为 `1` 时禁止把私有种子推送到 qBittorrent |
| `ED2K_HTTPS` | 关闭 | 设为 `1` 时登录 Cookie 加 `Secure`，用于 HTTPS 反代 |
| `ED2K_TRACKER_URL` | trackerslist 公共列表 | 公共 Tracker 列表地址 |
| `ED2K_TRACKER_TTL` | `21600` | Tracker 列表缓存秒数 |
| `ED2K_TRACKER_TIMEOUT` | `12` | 拉取 Tracker 列表超时秒数 |
| `ED2K_115_COOKIE` | 空 | 115 离线 Cookie 初始值，也可在界面设置 |
| `ED2K_115_CID` | 空 | 115 目标目录 ID，也可在界面设置 |

数据目录结构：

```
data/
├── files.json      # 文件索引、哈希结果与历史记录
├── settings.json   # 集成配置、种子选项与界面偏好
├── sessions.json   # 登录会话
├── blobs/          # 上传文件（以内部 ID 命名）
└── torrents/       # 生成的 .torrent
```

只要保留 `./data`，容器重建不会丢失上传文件、历史与设置。

## 界面使用

### 生成 ED2K 链接

1. 点击「添加文件」「文件夹」，或直接把文件 / 文件夹拖进页面。
2. 上传完成后服务端自动计算哈希，行内显示进度与 MD4。
3. 完成后点击链接条或右侧按钮复制，顶部可「复制全部」「导出 TXT」。

文件夹会保留目录结构，后续制作种子时同样按目录组织。已生成链接的文件会同时写入历史记录。

### 从服务器目录添加

1. 点击「服务器目录」，从 `ED2K_ROOTS` 开始浏览。
2. 单击文件夹进入，「添加当前文件夹」递归加入；也可跨目录勾选后「添加选中」。
3. 文件不会被复制到 `./data`，删除记录只移除索引。

### 制作 BT 种子

1. 切到「制作种子」，勾选要打包的文件（默认全选）。
2. 填写种子名称、Tracker（每行一个）、注释，选择分块大小与是否私有。
3. 「内嵌 ED2K」默认开启，会把已算好的 ED2K 链接写入种子元数据；开关状态由服务端记忆。
4. 生成后可直接下载 `.torrent`、复制磁力链，或进入历史记录推送。

分块大小固定档位从 16 KiB 到 128 MiB；选择「自动」时按 16 KiB 起步翻倍，使分块数量不超过约 2048。

### 解析种子

拖入 `.torrent` 后显示文件树与匹配状态：

- 已匹配：显示对应文件，可一键计算并回填 ED2K 链接。
- 未匹配：先添加同名 / 同路径 / 同大小的源文件，再重新解析。

BT 种子的 `pieces` 是 SHA-1，无法反推 ED2K 的 MD4；解析只是把种子里的文件与真实文件对上。

### 历史记录

点「历史」查看所有生成过的种子与 ED2K 链接：

- 点击条目右侧「!」展开详情，Info Hash / 种子大小 / 分块 / 类型 / Tracker / 内嵌 ED2K 都在一张卡片里
- 勾选后可「推送 115 离线」「推送 qB 下载」「复制」「移除」「导出 TXT」
- 未配置 qBittorrent 时不会出现推送 qB 按钮；配置多个实例时会让你选择目标
- 删除历史会级联清理种子文件

### 推送 115 与 qBittorrent

在「设置」中填入 115 Cookie、目标目录 ID，以及 qBittorrent 地址、账号、密码：

- 115：种子以磁力链推送，ED2K 记录以 `ed2k://` 链接推送
- qB：推送前会读取该实例的默认下载目录；你填写的保存路径按实例记忆，下次自动带出
- 多个 qB 实例互不影响，路径不会串用

## 登录与安全

设置 `ED2K_PASSWORD` 后，访问任何页面都会先跳到登录页：

- 勾选「记住登录状态」有效期为 30 天，否则 12 小时
- 会话保存在 `/data/sessions.json`，容器重启后仍然有效
- 同一 IP 连续输错 5 次密码会锁定 10 分钟
- 密码只存在环境变量中；忘记密码改环境变量重启即可

> 密码以明文传入容器，能用 `docker inspect` 看到。对安全要求更高时建议再套一层反向代理与 HTTPS。

## 技术说明

- ED2K：文件 ≤ 9,728,000 字节时对整个文件做 MD4；更大时按 9,728,000 字节分块，逐块 MD4 后拼接再 MD4 一次。
- 优先使用 `pycryptodome` 的 C 实现 MD4，镜像中已安装；不可用时退回 `hashlib` 与内置纯 Python 实现。
- 上传：`POST /api/uploads/init` 以「相对路径 + 大小 + 修改时间」生成指纹，分片通过 `PUT /api/uploads/{id}/chunk` 顺序写入，偏移不一致返回 `409` 由前端校准。
- 种子：自实现 bencode，生成时每个 Tracker 单独写入一个 `announce-list` tier。

## 目录结构

```
LinkSeed/
├── app.py              # HTTP 服务、上传、任务、历史与 API
├── ed2k.py             # MD4 / ED2K 哈希 / 链接解析
├── torrent.py          # bencode / 种子生成、解析与编辑
├── static/
│   ├── index.html
│   ├── login.html
│   ├── style.css
│   ├── app.js
│   ├── theme-init.js
│   └── logo.svg
├── Dockerfile
├── docker-compose.yml
└── requirements.txt
```

## 常见问题

**Q：反向代理后大文件上传失败？**
调高 Nginx 的 `client_max_body_size`（例如 `0` 或 `10g`），并延长 `proxy_read_timeout`。应用按 4 MiB 分片接收，单次请求不超过 32 MiB。

**Q：哈希很慢？**
ED2K 需要完整读取文件，机械硬盘或多文件并发会受 I/O 限制，可把 `ED2K_HASH_WORKERS` 设为 `1`。

**Q：历史记录会丢吗？**
不会。历史写在 `data/files.json`，重启容器、更新镜像都会保留，条数上限由 `ED2K_HISTORY_LIMIT` 控制。

**Q：为什么界面上找不到配置 qB 的按钮？**
需要先在「设置」里添加至少一个 qBittorrent 实例，历史记录中才会出现「推送 qB 下载」。

**Q：解析种子为什么没有 ED2K 链接？**
先确认对应真实文件已添加（文件名 / 路径 + 大小匹配），或种子元数据里内嵌了 ED2K；两者都没有时只能看到文件清单。

**Q：为什么服务器目录里看不到某个路径？**
界面只能浏览 `ED2K_ROOTS` 指定的目录，多个目录用 `:` 分隔。

**Q：修改密码后需要重新登录吗？**
需要，修改密码会使已有会话失效。

## 安全提示

- 请务必修改默认密码；公网部署建议再加反向代理与 HTTPS。
- 挂载宿主机根目录会暴露整机文件名与大小，建议只挂载需要的目录并使用只读挂载。
- 上传文件会占用磁盘，请确保 `./data` 所在分区空间充足。
