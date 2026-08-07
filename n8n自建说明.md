# n8n 自建说明（Docker Desktop · Windows）

n8n 是系统 6 个 Webhook 的"枢纽"。因为系统里所有 Webhook 都是**应用主动去调 n8n**，n8n 只要能被本机访问、能往外连（SES/IMAP/Hunter）即可，**不需要公网、每月 ¥0**。

> 为什么用 Docker：n8n 带原生模块（sqlite3），在 Windows 上直接 npm 安装需要 Visual Studio C++ 构建工具（很重）。Docker 里是官方打好的镜像，免编译、最稳。

---

## 第 1 步：装 Docker Desktop（需管理员 + 重启，只做一次）

1. 双击桌面上的 **`Docker Desktop Installer.exe`**（我已帮你下载好；若没有，去 https://www.docker.com/products/docker-desktop/ 下载）。
2. 安装时**保持勾选 "Use WSL 2"**（默认），一路下一步。
3. 装完**重启电脑**。
4. 重启后打开 **Docker Desktop**，等左下角/托盘的**鲸鱼图标变绿**（表示 Engine running）。
   - 若提示缺 WSL2 内核：用**管理员 PowerShell** 运行 `wsl --install`，重启后再打开 Docker Desktop。
5. （建议）Docker Desktop → Settings → General → 勾选 **"Start Docker Desktop when you log in"**，这样开机自动就绪。

---

## 第 2 步：起 n8n（一条命令，只做一次）

Docker 变绿后，双击本目录的 **`启动n8n.bat`**（我已备好）。它执行：

```bat
docker volume create n8n_data
docker run -d --name n8n --restart unless-stopped ^
  -p 5678:5678 ^
  -v n8n_data:/home/node/.n8n ^
  -e GENERIC_TIMEZONE=Asia/Shanghai -e TZ=Asia/Shanghai ^
  -e N8N_SECURE_COOKIE=false ^
  docker.n8n.io/n8nio/n8n
```

- `--restart unless-stopped`：以后开机/Docker 启动时 n8n **自动跟着起**，不用每次手动。
- 数据存在 `n8n_data` 卷里，容器删了也不丢。
- 之后管理：`docker stop n8n` / `docker start n8n` / `docker logs -f n8n`（看日志）。
- 升级：`docker pull docker.n8n.io/n8nio/n8n` 后 `docker rm -f n8n` 再跑一次 `启动n8n.bat`。

起好后浏览器打开 **http://localhost:5678** → 第一次会让你**创建 owner 账号**（邮箱+密码，只存本机）。

---

## 第 3 步：建工作流 + 回填 URL

以最关键的两条为例（其余接口字段见 `上线执行清单.md` 第三节）。

### 通用建法
1. n8n 里 New Workflow → 加 **Webhook** 触发节点：
   - HTTP Method = **POST**
   - Path = 自定义，如 `send` / `inbound`
   - Respond =
     - 需要返回数据的接口（**search / enrich / inbound**）：选 **"Using 'Respond to Webhook' Node"**，工作流末尾加 **Respond to Webhook** 节点返回约定 JSON；
     - 只需回 200 的接口（**send / whatsapp / crm**）：保持默认 "Immediately" 即可。
2. ⚠️ **CORS**（用浏览器版 localhost:4174 时必须设）：Webhook 节点 → Options → **Allowed Origins (CORS)** 填 `*`（或 `http://localhost:4174`）。
   - 用 **Electron 桌面版**（webSecurity 关）则不需要设。
3. 中间接你的动作节点（发信/IMAP/Hunter…）。
4. 右上角**保存并 Activate（激活）**工作流。
5. 点 Webhook 节点，复制 **Production URL**（形如 `http://localhost:5678/webhook/send`）——**一定用 Production，不是 Test URL**。
6. 回系统：设置 → 切 **Webhook 模式** → 把 URL 粘到对应 Webhook 框 → 点「测试连接」。

### 示例 A：发信（SMTP / SES）
`Webhook(POST /send)` → `Split Out`(拆 `emails` 数组) → `Send Email`(SMTP 节点，收件人=`{{$json.email}}`、主题=`{{$json.subject}}`、正文=`{{$json.body}}`) → 结束（默认回 200）。

### 示例 B：拉取回复（IMAP）
`Webhook(POST /inbound, Respond=Using Respond node)` → `IMAP Email`(读未读/近期邮件) → `Set/Code`(整理成 `{from_email, from_name, company, text, channel:"email", at}` 数组) → `Respond to Webhook`(返回 `{ "replies": [ ... ] }`)。

---

## 常见问题
- **localhost:5678 打不开**：确认 Docker 鲸鱼图标是绿的；`docker ps` 看 n8n 是否 Up；`docker logs n8n` 看报错。
- **系统里测试连接失败但 n8n 收到了**：多半是 CORS——按第 3 步第 2 点给 Webhook 设 Allowed Origins；或改用桌面版。
- **autopilot 要在电脑关机时也跑**：本地方案做不到（n8n 随电脑）。需要 always-on 就把这套 docker 命令搬到便宜 VPS（约 ¥40/月）。
- **端口 5678 被占**：`docker run` 时把 `-p 5678:5678` 改成 `-p 5679:5678`，URL 相应用 5679。
