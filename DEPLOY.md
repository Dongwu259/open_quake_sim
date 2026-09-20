# Earthquake Simulator Pro — 云服务器部署手册

## 目录

1. [准备工作](#1-准备工作)
2. [服务器环境配置](#2-服务器环境配置)
3. [部署应用](#3-部署应用)
4. [PM2 进程守护](#4-pm2-进程守护)
5. [Nginx 反向代理 + HTTPS](#5-nginx-反向代理--https)
6. [Docker 部署（可选）](#6-docker-部署可选)
7. [日常运维](#7-日常运维)
8. [常见问题](#8-常见问题)

---

## 1. 准备工作

### 你需要准备

| 项目 | 说明 |
|------|------|
| 云服务器 | 1核2G 以上，推荐 2核4G（阿里云/腾讯云/硅云/DigitalOcean 均可） |
| 操作系统 | Ubuntu 22.04 LTS（推荐）或 CentOS 7+ |
| 域名 | 可选，用于 HTTPS |
| SSH 工具 | 终端或 PuTTY |

### 项目文件清单（需要上传到服务器）

```
quake_sim/
├── server.js              # 生产级静态服务器
├── package.json           # 依赖声明
├── package-lock.json      # 锁定版本
├── Dockerfile             # Docker 构建文件
├── .gitignore
├── public/                # 前端所有文件
│   ├── index.html
│   ├── app.js
│   ├── config.js
│   ├── i18n.js
│   ├── style.css
│   ├── leaflet/
│   ├── turf/
│   └── geojson/
│       ├── stations.json      # 1,289 NIED 测站
│       ├── coastline_50m.json # 海岸线
│       ├── observed.json      # 验证数据
│       └── japan.json         # 备用
└── sounds/                # 音效文件
```

### 上传方式

```bash
# 方式一：Git（推荐）
cd /opt
git clone <your-repo-url> quake-sim

# 方式二：scp 上传
scp -r quake_sim user@your-server:/opt/quake-sim

# 方式三：rsync
rsync -avz --exclude node_modules quake_sim/ user@your-server:/opt/quake-sim/
```

---

## 2. 服务器环境配置

### Ubuntu 22.04

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 验证
node -v   # 应显示 v20.x.x
npm -v    # 应显示 10.x.x

# 安装 Nginx
sudo apt install -y nginx

# 安装 PM2（进程守护）
sudo npm install -g pm2

# 安装 Git（如果用 Git 部署）
sudo apt install -y git

# 配置防火墙
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP
sudo ufw allow 443/tcp     # HTTPS
sudo ufw enable
```

### CentOS 7+

```bash
# 更新系统
sudo yum update -y

# 安装 Node.js 20.x
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# 安装 Nginx
sudo yum install -y epel-release
sudo yum install -y nginx

# 安装 PM2
sudo npm install -g pm2

# 启动 Nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# 防火墙
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --permanent --add-port=22/tcp
sudo firewall-cmd --reload
```

---

## 3. 部署应用

```bash
# 进入项目目录
cd /opt/quake-sim

# 安装依赖
npm install --production

# 测试运行（前台，Ctrl+C 停止）
node server.js
# 看到 "QuakeSim running on http://0.0.0.0:3000" 即成功

# 浏览器访问 http://your-server-ip:3000 确认可用
```

---

## 4. PM2 进程守护

```bash
# 启动应用
pm2 start server.js --name quake-sim

# 查看状态
pm2 status

# 查看日志
pm2 logs quake-sim

# 设置开机自启
pm2 startup
# 执行上面命令输出的 sudo 命令

pm2 save

# 常用命令
pm2 restart quake-sim   # 重启
pm2 stop quake-sim      # 停止
pm2 reload quake-sim    # 零停机重载
pm2 monit               # 实时监控面板
```

---

## 5. Nginx 反向代理 + HTTPS

Nginx 作为前端接收 80/443 端口请求，反向代理到 Node.js 的 3000 端口。提供 GZip 压缩、静态资源缓存、安全头。

### 5.1 方案 A：已有 SSL 证书文件（如阿里云 DigiCert）

如果你已经从阿里云等平台下载了证书（`.pem` + `.key` 文件），上传到服务器某个目录（例如 `/etc/nginx/ssl/`），然后使用此配置。

```bash
# 上传证书到服务器
mkdir -p /etc/nginx/ssl
# 把 .pem 和 .key 文件放到 /etc/nginx/ssl/ 下
chmod 600 /etc/nginx/ssl/*.key   # 私钥必须 600 权限
```

创建 `/etc/nginx/sites-available/quake-sim`：

```nginx
# Earthquake Simulator Pro — Nginx Reverse Proxy
# SSL 证书：阿里云 DigiCert 等预先签发的证书

# ---- HTTP → HTTPS 重定向 ----
server {
    listen 80;
    listen [::]:80;
    server_name your-domain.com www.your-domain.com;

    return 301 https://$host$request_uri;
}

# ---- HTTPS 主站 ----
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name your-domain.com www.your-domain.com;

    # ====== SSL 证书：直接指向你的 pem 和 key 文件 ======
    ssl_certificate     /etc/nginx/ssl/你的证书.pem;
    ssl_certificate_key /etc/nginx/ssl/你的证书.key;

    # 如果证书是 .crt 格式也一样
    # ssl_certificate     /etc/nginx/ssl/你的证书.crt;
    # ssl_certificate_key /etc/nginx/ssl/你的证书.key;

    # SSL 安全配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    # 日志
    access_log /var/log/nginx/quake-sim.access.log;
    error_log  /var/log/nginx/quake-sim.error.log;

    # GZip 压缩
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/html text/css application/javascript application/json image/svg+xml;

    # 静态资源缓存
    location ~* \.(js|css)$ {
        proxy_pass http://127.0.0.1:3000;
        include /etc/nginx/proxy_params;
        expires 1h;
        add_header Cache-Control "public, max-age=3600";
    }

    # GeoJSON / 图片 / 音频
    location ~* \.(json|geojson|png|jpg|jpeg|svg|ico|wav|mp3)$ {
        proxy_pass http://127.0.0.1:3000;
        include /etc/nginx/proxy_params;
        expires 1d;
        add_header Cache-Control "public, max-age=86400";
    }

    # HTML 不缓存
    location ~* \.html$ {
        proxy_pass http://127.0.0.1:3000;
        include /etc/nginx/proxy_params;
        expires -1;
        add_header Cache-Control "no-cache, must-revalidate";
    }

    # 主代理：其他所有请求转发到 Node.js
    location / {
        proxy_pass http://127.0.0.1:3000;
        include /etc/nginx/proxy_params;

        # WebSocket 支持（P2PQuake SSE）
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # 健康检查端点
    location /health {
        proxy_pass http://127.0.0.1:3000;
        include /etc/nginx/proxy_params;
        access_log off;
    }

    # 客户端上传限制
    client_max_body_size 10m;
}
```

### 5.2 方案 B：Let's Encrypt 免费证书（Certbot 自动续期）

> 如果你没有现成证书，可使用 Let's Encrypt。证书路径与方案 A 不同。

创建 `/etc/nginx/sites-available/quake-sim`，SSL 部分改为：

```nginx
# ---- HTTPS 主站 ----
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name your-domain.com www.your-domain.com;

    # ====== SSL 证书：Let's Encrypt ======
    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # ... 其余配置与方案 A 完全相同 ...
}
```

（其余 server 块内容同方案 A）

### 5.2 proxy_params 文件

如果 `/etc/nginx/proxy_params` 不存在，创建它：

```nginx
# /etc/nginx/proxy_params
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Port $server_port;

proxy_connect_timeout 60s;
proxy_send_timeout 60s;
proxy_read_timeout 60s;

proxy_buffering on;
proxy_buffer_size 4k;
proxy_buffers 8 16k;
```

### 5.3 启用站点

**通用步骤（两种方案都需要）：**

```bash
# 1. 创建软链接
sudo ln -s /etc/nginx/sites-available/quake-sim /etc/nginx/sites-enabled/

# 2. 移除默认站点
sudo rm /etc/nginx/sites-enabled/default

# 3. 测试配置
sudo nginx -t

# 4. 重载 Nginx
sudo systemctl reload nginx
```

**方案 A（已有证书）到此完成**。证书到期前（DigiCert 通常 1 年）重新下载新证书覆盖 `/etc/nginx/ssl/` 中的文件，然后 `sudo systemctl reload nginx` 即可。

**方案 B（Let's Encrypt）继续获取证书：**

```bash
# 安装 Certbot
sudo apt install -y certbot python3-certbot-nginx

# 获取证书（替换为你的域名）
sudo certbot --nginx -d your-domain.com -d www.your-domain.com

# 验证自动续期
sudo certbot renew --dry-run
```

### 5.4 仅 HTTP（无域名的简化配置）

如果暂时不用域名和 HTTPS，使用这个简化版：

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

---

## 6. Docker 部署（可选）

如果不想手动配置环境，用 Docker 一键部署：

```bash
# 构建镜像
cd /opt/quake-sim
docker build -t quake-sim .

# 运行容器
docker run -d \
  --name quake-sim \
  --restart unless-stopped \
  -p 3000:3000 \
  quake-sim

# 查看日志
docker logs -f quake-sim

# Docker Compose（在项目目录创建 docker-compose.yml）
```

`docker-compose.yml` 示例：

```yaml
version: '3.8'
services:
  quake-sim:
    build: .
    container_name: quake-sim
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - NODE_ENV=production
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  # 可选：Nginx 反向代理
  nginx:
    image: nginx:alpine
    container_name: quake-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - quake-sim
```

---

## 7. 日常运维

### 更新应用

```bash
cd /opt/quake-sim
git pull                    # 拉取最新代码
npm install --production    # 更新依赖（如有变化）
pm2 reload quake-sim        # 零停机重载
```

### 查看状态

```bash
pm2 status                  # 进程状态
pm2 logs quake-sim --lines 50  # 最近 50 行日志
curl http://localhost:3000/health  # 健康检查
```

### 监控资源

```bash
pm2 monit                   # CPU / 内存实时监控
htop                        # 系统资源
df -h                       # 磁盘空间
```

### 备份

```bash
# 备份整个项目（不含 node_modules）
tar -czf quake-sim-backup-$(date +%Y%m%d).tar.gz \
  --exclude=node_modules \
  --exclude=public/tiles \
  /opt/quake-sim
```

---

## 8. 常见问题

### Q: 端口 3000 无法访问？
```bash
# 检查防火墙
sudo ufw status
sudo ufw allow 3000/tcp

# 检查进程是否在监听
ss -tlnp | grep 3000
```

### Q: Nginx 报 502 Bad Gateway？
```bash
# Node.js 进程可能挂了
pm2 status
pm2 restart quake-sim
```

### Q: 静态资源返回 404？
```bash
# 检查 public 目录是否完整
ls -la /opt/quake-sim/public/
# 确保 geojson/ 子目录存在
ls -la /opt/quake-sim/public/geojson/
```

### Q: 内存占用过高？
```bash
# Node.js 默认内存 ~512MB，如需限制：
pm2 start server.js --name quake-sim --max-memory-restart 300M
```

### Q: 如何配置 CDN？
将 `public/` 目录中的静态资源（leaflet/, turf/, geojson/）上传到 CDN，修改 `index.html` 中的引用路径即可。

---

## 快速部署清单

```bash
# 1. 服务器环境
sudo apt update && sudo apt install -y nodejs nginx git
sudo npm install -g pm2

# 2. 部署应用
cd /opt && git clone <repo-url> quake-sim
cd quake-sim && npm install --production

# 3. 启动
pm2 start server.js --name quake-sim
pm2 save && pm2 startup

# 4. Nginx（参考第 5 节配置）
sudo nano /etc/nginx/sites-available/quake-sim
sudo ln -s /etc/nginx/sites-available/quake-sim /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 5. SSL 证书
# 方案 A（已有证书如阿里云 DigiCert）：上传 pem/key 到 /etc/nginx/ssl/，见 5.1
# 方案 B（Let's Encrypt 免费）：
#   sudo apt install -y certbot python3-certbot-nginx
#   sudo certbot --nginx -d your-domain.com

# 6. 验证
curl https://your-domain.com/health
```
