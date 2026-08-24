# 本机账号登录设计

## 目标
公开的 Coder 端口不再要求用户取得或粘贴 Web token。首次访问创建本机管理员账号；以后使用账号和密码登录 Project Orchestrator。

## 范围与边界
- 首版只有一个管理员：数据库没有账号时才显示注册；首个账号创建后公开注册永久关闭。
- 账号只管理网页的“模板编排 + Run 只读观察”，不拥有 Agent、部署或生产操作权限。
- 密码用 Node 内置 `scrypt` 加随机 salt 编码，数据库不保存明文密码、会话 token 或 CSRF token。
- 登录会话是数据库保存的随机不透明 token 哈希；浏览器 Cookie 使用 `HttpOnly; Secure; SameSite=Strict`。
- 每个会话有独立 CSRF token；配置写操作必须同时通过会话、精确 Origin 和 CSRF 校验。
- 同时允许精确的 Coder 端口域名和 `orchestrator.co.weifashi.cn`；其它 Origin 与 Host 一律拒绝。
- Web token 登录入口删除；服务重启时旧内存 Cookie 失效。

## 数据模型
```text
web_users
  id, username (UNIQUE NOCASE), password_hash, created_at, updated_at
web_sessions
  id, user_id -> web_users.id, token_hash (UNIQUE), csrf_hash,
  created_at, expires_at, last_seen_at, revoked_at
```
会话存活 12 小时。连续失败 5 次/15 分钟/来源地址后临时拒绝；成功登录清除此来源的失败计数。

## 页面与流转
```text
GET /bootstrap
  ├─ 没有 web_users → 创建管理员账号
  └─ 已有 web_users → 账号 + 密码登录
注册 / 登录成功 → HttpOnly 会话 Cookie → /
登出 / 过期       → 失效 → /bootstrap
```
首次注册：账号名、密码、确认密码和安全说明。登录：账号名、密码、登录按钮与“在本机终端重置密码”的说明。错误紧邻字段，且登录不透露账号是否存在。

## 验收
1. 空 SQLite 显示注册页，首个账号注册后进入控制台。
2. 后续访问显示登录页；重复注册、短密码、错误密码和超限登录均拒绝。
3. SQLite 中无密码、会话 token、CSRF token 明文。
4. 注销和过期会话无法访问；写操作继续要求 CSRF。
5. Coder 与自定义域名都可登录，伪造 Origin/Host 仍为 403。
6. 公共端口不存在 Web token 输入框；旧 token POST 不是认证方式。
