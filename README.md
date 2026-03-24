# ShyTalk

一个最小可部署的加密聊天程序：

- Vue 3 H5 前端，适配手机浏览器
- Node.js v22 + Express + WebSocket 后端
- SQLite 持久化用户、联系人和加密消息
- 首次使用注册用户名和密码
- 后续自动读取本地缓存的用户名密码登录
- 联系人可直接按用户名添加
- 支持文字、表情、图片聊天
- 支持消息状态：发送中、已送达、已读
- 支持聊天图片点击全屏预览
- 支持 PWA，可添加到手机桌面
- 聊天内容在浏览器端加密，服务端只存密文

## 技术说明

- 用户密码用于登录，也用于解锁本地聊天私钥
- 每个用户首次注册时生成一对公私钥
- 私钥会用用户密码派生出的密钥加密后保存到服务端
- 消息发送前在浏览器端使用双方共享密钥加密
- 服务端只负责认证、联系人管理、消息转发和密文存储

## 安装

```bash
npm install
```

## 开发

```bash
npm run dev
```

- 前端开发地址默认是 `http://localhost:5173`
- 后端开发地址默认是 `http://localhost:3000`

## 构建

```bash
npm run build
```

## 生产启动

```bash
npm start
```

默认监听 `3000` 端口，生产模式会直接把 `client/dist` 挂到首页 `/`。

## 云服务器部署

最简单的方式有两种。

### 方式 1：直接运行 Node

```bash
npm install
npm run build
PORT=3000 npm start
```

建议：

- 用 Nginx 或 Caddy 反代到 Node 服务
- 必须启用 HTTPS，手机浏览器上的加密能力和图片传输更稳定
- 数据库文件默认在 `server/data/shytalk.db`

### 方式 2：Docker

```bash
docker build -t shytalk .
docker run -d -p 3000:3000 -v $(pwd)/server/data:/app/server/data shytalk
```

### 方式 3：一键脚本（Ubuntu + HTTPS 反代）

仓库内置脚本会自动安装 Node.js 22、Caddy，并配置 systemd 与 HTTPS 反向代理：

```bash
sudo bash deploy/quick-deploy.sh your.domain.com https://github.com/cowbook/shytalk.git
```

部署后访问：`https://your.domain.com`

## 自动构建

项目已提供 GitHub Actions 工作流：

- 文件：`.github/workflows/ci.yml`
- 触发：push 到 `main` 或 pull request
- 任务：安装依赖并执行 `npm run build`

## 安全边界

这个版本是“最小可用”实现，不是高强度安全产品。

- 服务端看不到聊天明文，但能看到谁和谁通信、时间、消息大小
- 用户名和密码会按你的需求长期缓存在浏览器 `localStorage`
- 如果设备本身不安全，本地缓存会带来风险
- 建议生产环境只在 HTTPS 下运行
