# 部署到云服务器

> 适用于腾讯云轻量应用服务器或 CVM，系统需要是 Linux（Ubuntu / Debian / OpenCloudOS / CentOS 都可以），2GB 内存绰绰有余，服务器实际只占几十 MB。

有两种装法：

| 装法 | 适用情况 | 脚本 |
|---|---|---|
| **A. 免 sudo（实际在用的方式）** | 借别人服务器上的一个普通账号 | `deploy/setup-user.sh` |
| B. 有 root | 服务器是你自己的 | `deploy/setup.sh`（还没在真服务器上跑过） |

---

## A. 免 sudo 装法（2026-10-10 已部署成功）

**前提**：服务器主人已经为你：
- 建好一个普通账号（下文记作 `<用户名>`），并装好你的 SSH 公钥；
- 运行过 `sudo loginctl enable-linger <用户名>`。不加这条的话，你一退出登录程序就停了，服务器重启后也不会自动启动。

**你的电脑**上建议在 `~/.ssh/config` 里给服务器起个别名，下文都用 `poker` 指代：

```
Host poker
    HostName <服务器IP>
    User <用户名>
    IdentityFile ~/.ssh/<你的私钥文件>
```

配好后 `ssh poker` 就能直接登录。

### 首次安装和更新

在项目文件夹里（PowerShell）依次运行：
```bash
npm run pack
```
```bash
scp ..\texas-poker.tgz poker:~/texas-poker.tgz
```
```bash
ssh poker "rm -rf ~/texas-poker-src && mkdir ~/texas-poker-src && tar -xzf ~/texas-poker.tgz -C ~/texas-poker-src && bash ~/texas-poker-src/deploy/setup-user.sh && rm -rf ~/texas-poker-src ~/texas-poker.tgz"
```
- **首次安装**：在 `setup-user.sh` 后面加上 `--password 口令 --port 3000`。
- **之后更新**：不加参数，沿用原来的口令和端口，**计分数据保留**。

### 日常维护（`ssh poker` 登录后运行）

| 想做什么 | 命令 |
|---|---|
| 看实时日志 | `journalctl --user -u texas-poker -f` |
| 看状态和内存 | `systemctl --user status texas-poker` |
| 重启 | `systemctl --user restart texas-poker` |
| 改口令 | `bash ~/texas-poker/deploy/setup-user.sh --password 新口令` |
| 卸载（计分数据先备份到家目录） | `bash ~/texas-poker/deploy/uninstall-user.sh` |

备份计分数据，在**你的电脑上**运行：
```bash
scp poker:~/texas-poker/data/db.json .
```

### 在服务器上改了什么（给服务器主人看）

只在 `<用户名>` 自己的家目录里：

| 位置 | 用途 |
|---|---|
| `~/texas-poker/` | 代码、私有的 Node.js、计分数据，约 220MB |
| `~/.config/texas-poker.env` | 端口和口令，只有 `<用户名>` 能读 |
| `~/.config/systemd/user/texas-poker.service` | 用户级服务：崩溃后自动重启；有 linger 的话开机自启 |

- 程序以普通用户 `<用户名>` 的身份运行，**没有 sudo**，碰不到系统文件，也碰不到其他用户的文件（各家目录权限都是 750）。
- 内存上限 400MB；实测约 74MB。
- 只监听一个端口：TCP 3000。

---

## B. 有 root 的装法

> ⚠️ 这个脚本做过语法检查，但还没在真服务器上跑过。

## 要准备的

| 项目 | 说明 |
|---|---|
| 服务器公网 IP | 腾讯云控制台的实例详情里能看到 |
| 登录用户名 | 腾讯云 Ubuntu 镜像默认是 `ubuntu`，OpenCloudOS / CentOS 默认是 `root` |
| 端口 | 默认 3000。如果服务器上已经有程序占用了，就换一个，比如 3100 |
| 房间口令 | 4–32 位字母、数字、下划线或减号。打牌的朋友进门时要输入 |

---

## 第 1 步：在腾讯云控制台放行端口

- **轻量应用服务器**：实例详情 → 防火墙 → 添加规则 → 协议 `TCP`，端口 `3000`，策略"允许"
- **云服务器 CVM**：安全组 → 入站规则 → 添加规则 → 来源 `0.0.0.0/0`，协议端口 `TCP:3000`，策略"允许"

## 第 2 步：在你的电脑上打包

在项目文件夹里运行：
```bash
npm run pack
```
会在项目文件夹的**上一级目录**生成 `texas-poker.tgz`，大约 60KB。

## 第 3 步：上传并安装

在你的电脑上（Windows 10 以上自带 `scp` 和 `ssh` 命令）：
```bash
scp ..\texas-poker.tgz ubuntu@服务器IP:~
```
```bash
ssh ubuntu@服务器IP
```
登录服务器后，依次运行：
```bash
rm -rf ~/texas-poker && mkdir ~/texas-poker && tar -xzf ~/texas-poker.tgz -C ~/texas-poker
```
```bash
sudo bash ~/texas-poker/deploy/setup.sh --password 你的口令 --port 3000
```
运行完会打印出访问地址，例如 `http://1.2.3.4:3000`。把地址和口令发到群里，大家用浏览器打开就能玩。

---

## 更新代码

以后我改了代码，重复第 2、3 步即可。安装命令可以不带参数：
```bash
sudo bash ~/texas-poker/deploy/setup.sh
```
会沿用原来的口令和端口，**计分数据会保留**。

## 日常维护

| 想做什么 | 命令（在服务器上运行） |
|---|---|
| 看实时日志 | `journalctl -u texas-poker -f` |
| 重启 | `sudo systemctl restart texas-poker` |
| 改口令 | `sudo bash /opt/texas-poker/deploy/setup.sh --password 新口令` |
| 卸载（自动备份计分数据到 /root/） | `sudo bash /opt/texas-poker/deploy/uninstall.sh` |

备份计分数据，在**你的电脑上**运行：
```bash
scp ubuntu@服务器IP:/opt/texas-poker/data/db.json .
```

---

## 给服务器主人看：脚本对服务器改了什么

只动了下面这些东西，**不碰你原有的程序、网站、Node.js 或 Nginx**：

| 位置 | 用途 |
|---|---|
| `/opt/texas-poker/` | 程序代码、私有的 Node.js（在 `runtime/` 里）、计分数据（在 `data/` 里） |
| `/etc/texas-poker.env` | 端口和房间口令，只有 root 能读 |
| `/etc/systemd/system/texas-poker.service` | 系统服务，开机自启、崩溃自动重启 |
| 系统用户 `poker` | 专门用来运行这个程序，不能登录 |
| 本机防火墙 | **只有在 ufw 或 firewalld 本来就开着时**，才放行你指定的那一个端口 |

程序用 `poker` 用户运行，systemd 把它限制成"除了自己的 `data/` 目录，整个文件系统都是只读的"。也就是说，就算程序有漏洞，也改不了服务器上别的文件。

卸载脚本会把上面这些全部删掉，删之前先把计分数据备份到 `/root/`。

---

## 不想让朋友敲命令？让他给你开一个 SSH 登录

1. 你在自己电脑上生成一把 SSH 钥匙（已经有就跳过）：`ssh-keygen -t ed25519`
2. 把 `C:\Users\你的用户名\.ssh\id_ed25519.pub` 的内容发给朋友。这是**公钥**，可以随便发。
3. 朋友把这段内容加到服务器上 `~/.ssh/authorized_keys` 的末尾。

之后你就能直接 `ssh ubuntu@服务器IP` 登录，自己完成第 3 步。**别让朋友把 root 密码发给你**；不用了，让他从 `authorized_keys` 里删掉那一行就行。

## 已知限制

- **HTTP 明文传输**：口令和牌局数据在网络上不加密。朋友局够用；要上 HTTPS 需要有域名，内地服务器的域名还得先备案。
- **内地服务器**：用 `http://IP:端口` 访问一般没问题；要用域名访问必须先备案。香港服务器没有这个限制。
