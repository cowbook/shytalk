import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'
import { db } from './db.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const clientDist = path.resolve(__dirname, '../../client/dist')
const repoRoot = path.resolve(__dirname, '../..')
const port = Number(process.env.PORT || 4000)
const webhookRef = process.env.WEBHOOK_REF || 'refs/heads/main'
const webhookRemote = process.env.WEBHOOK_REMOTE || 'origin'
const webhookRepoFullName = process.env.WEBHOOK_REPO_FULL_NAME || ''
const sessions = new Map()
const sockets = new Map()

const usernamePattern = /^[\p{L}\p{N}_-]{2,20}$/u
const PROFILE_GENDERS = new Set(['unknown', 'male', 'female', 'other'])
const AVATAR_OPTIONS = [
  'https://api.dicebear.com/9.x/lorelei/svg?seed=MochiBear',
  'https://api.dicebear.com/9.x/lorelei/svg?seed=PeachBunny',
  'https://api.dicebear.com/9.x/lorelei/svg?seed=MintKitty',
  'https://api.dicebear.com/9.x/lorelei/svg?seed=CloudPuff',
  'https://api.dicebear.com/9.x/lorelei/svg?seed=TinyPanda',
  'https://api.dicebear.com/9.x/lorelei/svg?seed=BerryFox',
  'https://api.dicebear.com/9.x/lorelei/svg?seed=SugarDuck',
  'https://api.dicebear.com/9.x/lorelei/svg?seed=SunnyKoala',
  'https://api.dicebear.com/9.x/lorelei/svg?seed=LemonOtter',
  'https://api.dicebear.com/9.x/lorelei/svg?seed=CocoaSeal',
]

const app = express()
app.use(express.json({ limit: '8mb' }))

function forceUpdateRepositoryFromRemote() {
  const branchName = webhookRef.replace(/^refs\/heads\//, '')

  const fetchOutput = execFileSync('git', ['fetch', webhookRemote, branchName], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const resetOutput = execFileSync('git', ['reset', '--hard', `${webhookRemote}/${branchName}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const cleanOutput = execFileSync('git', ['clean', '-fd'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  return {
    branch: branchName,
    output: [fetchOutput, resetOutput, cleanOutput].filter(Boolean).join('\n').trim(),
  }
}

let isDeploying = false

function runBackgroundDeploy() {
  if (isDeploying) {
    console.log('[webhook] 已有部署任务在进行中，跳过')
    return
  }

  isDeploying = true

  try {
    console.log('[webhook] 第 1 步：拉取最新代码...')
    const updateResult = forceUpdateRepositoryFromRemote()
    console.log(`[webhook] 代码更新成功 (${updateResult.branch})`)

    console.log('[webhook] 第 2 步：安装依赖...')
    execFileSync('npm', ['install'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    console.log('[webhook] 依赖安装完成')

    console.log('[webhook] 第 3 步：编译前端...')
    execFileSync('npm', ['run', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    console.log('[webhook] 前端编译完成，即将重启服务...')

    // systemd Restart=always 会自动拉起新进程
    process.exit(0)
  } catch (error) {
    isDeploying = false
    console.error('[webhook] 后台部署失败:', error?.stderr || error?.message || error)
  }
}

function nowPlusDays(days) {
  return Date.now() + days * 24 * 60 * 60 * 1000
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('base64')
}

function makeSalt(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64')
}

function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, {
    userId,
    expiresAt: nowPlusDays(7),
  })
  return token
}

function findSession(token) {
  const session = sessions.get(token)

  if (!session) {
    return null
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }

  return session
}

setInterval(() => {
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token)
    }
  }
}, 60_000).unref()

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname || row.username,
    avatarUrl: row.avatar_url || '',
    gender: row.gender || 'unknown',
    bio: row.bio || '',
    publicKey: row.public_key,
    encryptedPrivateKey: row.encrypted_private_key,
    keySalt: row.key_salt,
    createdAt: row.created_at,
  }
}

function pickRandomAvatar() {
  return AVATAR_OPTIONS[Math.floor(Math.random() * AVATAR_OPTIONS.length)]
}

function validateProfilePayload({ nickname, avatarUrl, gender, bio }) {
  const normalizedNickname = String(nickname || '').trim()
  const normalizedAvatarUrl = String(avatarUrl || '').trim()
  const normalizedGender = String(gender || 'unknown').trim().toLowerCase()
  const normalizedBio = String(bio || '').trim()

  if (!normalizedNickname || normalizedNickname.length > 24) {
    return { error: '昵称不能为空且不超过 24 个字符' }
  }

  if (!AVATAR_OPTIONS.includes(normalizedAvatarUrl)) {
    return { error: '头像不在可选列表中' }
  }

  if (!PROFILE_GENDERS.has(normalizedGender)) {
    return { error: '性别值不合法' }
  }

  if (normalizedBio.length > 140) {
    return { error: '说明不超过 140 个字符' }
  }

  return {
    value: {
      nickname: normalizedNickname,
      avatarUrl: normalizedAvatarUrl,
      gender: normalizedGender,
      bio: normalizedBio,
    },
  }
}

function parseBearerToken(req) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) {
    return null
  }

  return header.slice(7)
}

function authMiddleware(req, res, next) {
  const token = parseBearerToken(req)
  const session = token ? findSession(token) : null

  if (!session) {
    res.status(401).json({ error: '登录已失效，请重新登录' })
    return
  }

  const user = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(session.userId)

  if (!user) {
    res.status(401).json({ error: '用户不存在' })
    return
  }

  req.user = user
  next()
}

function validateAuthPayload({ username, password, publicKey, encryptedPrivateKey, keySalt }, requireKeys) {
  if (!usernamePattern.test(username || '')) {
    return '用户名需为 2-20 位，可使用中文、字母、数字、下划线或短横线'
  }

  if (!password || password.length < 6 || password.length > 64) {
    return '密码长度需在 6 到 64 位之间'
  }

  if (requireKeys && (!publicKey || !encryptedPrivateKey || !keySalt)) {
    return '缺少密钥信息'
  }

  return null
}

function ensureMutualContact(userId, contactId) {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)' 
  )
  const transaction = db.transaction(() => {
    stmt.run(userId, contactId)
    stmt.run(contactId, userId)
  })
  transaction()
}

function markConversationRead(userId, otherUserId) {
  return db
    .prepare(
      `
        UPDATE messages
        SET read_at = CURRENT_TIMESTAMP
        WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL
      `
    )
    .run(otherUserId, userId)
}

function parseBooleanFlag(value) {
  return value === '1' || value === 'true' || value === 'yes'
}

function listContacts(userId) {
  return db
    .prepare(
      `
        SELECT
          u.id,
          u.username,
          u.nickname AS nickname,
          u.avatar_url AS avatarUrl,
          u.public_key AS publicKey,
          COALESCE(lastMessage.created_at, c.created_at) AS lastMessageAt,
          lastMessage.kind AS lastMessageKind,
          lastMessage.body_cipher AS lastMessageBodyCipher,
          lastMessage.nonce AS lastMessageNonce,
          lastSender.username AS lastMessageSenderUsername,
          lastRecipient.username AS lastMessageRecipientUsername,
          COALESCE(unread.unreadCount, 0) AS unreadCount
        FROM contacts c
        JOIN users u ON u.id = c.contact_id
        LEFT JOIN messages lastMessage ON lastMessage.id = (
          SELECT m.id
          FROM messages m
          WHERE
            (m.sender_id = c.user_id AND m.recipient_id = c.contact_id)
            OR
            (m.sender_id = c.contact_id AND m.recipient_id = c.user_id)
          ORDER BY datetime(m.created_at) DESC, m.id DESC
          LIMIT 1
        )
        LEFT JOIN users lastSender ON lastSender.id = lastMessage.sender_id
        LEFT JOIN users lastRecipient ON lastRecipient.id = lastMessage.recipient_id
        LEFT JOIN (
          SELECT sender_id, recipient_id, COUNT(*) AS unreadCount
          FROM messages
          WHERE recipient_id = ? AND read_at IS NULL
          GROUP BY sender_id, recipient_id
        ) unread ON unread.sender_id = c.contact_id AND unread.recipient_id = c.user_id
        WHERE c.user_id = ?
        ORDER BY datetime(lastMessageAt) DESC, u.username ASC
      `
    )
    .all(userId, userId)
}

function conversationMessages(userId, otherUserId, options = {}) {
  const unconfirmedOnly = Boolean(options.unconfirmedOnly)

  return db
    .prepare(
      `
        SELECT
          m.id,
          m.kind,
          m.body_cipher AS bodyCipher,
          m.nonce,
          m.read_at AS readAt,
          m.created_at AS createdAt,
          sender.username AS senderUsername,
          recipient.username AS recipientUsername
        FROM messages m
        JOIN users sender ON sender.id = m.sender_id
        JOIN users recipient ON recipient.id = m.recipient_id
        WHERE
          (
            (m.sender_id = ? AND m.recipient_id = ?)
            OR
            (m.sender_id = ? AND m.recipient_id = ?)
          )
          AND
          (
            ? = 0
            OR m.read_at IS NULL
          )
        ORDER BY datetime(m.created_at) ASC, m.id ASC
        LIMIT 500
      `
    )
    .all(userId, otherUserId, otherUserId, userId, unconfirmedOnly ? 1 : 0)
}

function createMessage({ senderId, recipientUsername, kind, bodyCipher, nonce, clientId = '' }) {
  const normalizedRecipientUsername = String(recipientUsername || '').trim()
  const normalizedKind = kind === 'image' ? 'image' : 'text'
  const normalizedBodyCipher = String(bodyCipher || '')
  const normalizedNonce = String(nonce || '')
  const normalizedClientId = String(clientId || '').trim()

  if (!normalizedRecipientUsername || !normalizedBodyCipher || !normalizedNonce) {
    return { error: '消息内容不完整', status: 400 }
  }

  const recipient = db.prepare('SELECT * FROM users WHERE username = ?').get(normalizedRecipientUsername)

  if (!recipient) {
    return { error: '收件人不存在', status: 404 }
  }

  if (recipient.id === senderId) {
    return { error: '不能给自己发送消息', status: 400 }
  }

  ensureMutualContact(senderId, recipient.id)

  const result = db
    .prepare(
      `
        INSERT INTO messages (sender_id, recipient_id, kind, body_cipher, nonce)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .run(senderId, recipient.id, normalizedKind, normalizedBodyCipher, normalizedNonce)

  const message = db
    .prepare(
      `
        SELECT
          m.id,
          m.kind,
          m.body_cipher AS bodyCipher,
          m.nonce,
          m.read_at AS readAt,
          m.created_at AS createdAt,
          sender.username AS senderUsername,
          recipient.username AS recipientUsername
        FROM messages m
        JOIN users sender ON sender.id = m.sender_id
        JOIN users recipient ON recipient.id = m.recipient_id
        WHERE m.id = ?
      `
    )
    .get(result.lastInsertRowid)

  const responsePayload = {
    type: 'message_created',
    message,
    clientId: normalizedClientId,
  }

  broadcastTo(senderId, responsePayload)
  broadcastTo(recipient.id, responsePayload)

  return {
    message,
    clientId: normalizedClientId,
  }
}

function broadcastTo(userId, payload) {
  const userSockets = sockets.get(userId)

  if (!userSockets) {
    return
  }

  const encoded = JSON.stringify(payload)

  for (const socket of userSockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(encoded)
    }
  }
}

app.post('/api/auth/register', (req, res) => {
  const { username, password, publicKey, encryptedPrivateKey, keySalt } = req.body || {}
  const validationError = validateAuthPayload(
    { username, password, publicKey, encryptedPrivateKey, keySalt },
    true
  )

  if (validationError) {
    res.status(400).json({ error: validationError })
    return
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (existing) {
    res.status(409).json({ error: '用户名已存在' })
    return
  }

  const salt = makeSalt()
  const passwordHash = hashPassword(password, salt)

  const result = db
    .prepare(
      `
        INSERT INTO users (
          username,
          nickname,
          avatar_url,
          gender,
          bio,
          password_hash,
          password_salt,
          public_key,
          encrypted_private_key,
          key_salt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      username,
      username,
      pickRandomAvatar(),
      'unknown',
      '',
      passwordHash,
      salt,
      publicKey,
      encryptedPrivateKey,
      keySalt
    )

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid)
  const token = issueSession(user.id)
  res.json({ token, user: publicUser(user), avatarOptions: AVATAR_OPTIONS })
})

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {}
  const validationError = validateAuthPayload({ username, password }, false)

  if (validationError) {
    res.status(400).json({ error: validationError })
    return
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!user) {
    res.status(404).json({ error: '用户不存在' })
    return
  }

  const passwordHash = hashPassword(password, user.password_salt)
  if (passwordHash !== user.password_hash) {
    res.status(401).json({ error: '密码错误' })
    return
  }

  const token = issueSession(user.id)
  res.json({ token, user: publicUser(user), avatarOptions: AVATAR_OPTIONS })
})

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = parseBearerToken(req)

  if (token) {
    sessions.delete(token)
  }

  const userSockets = sockets.get(req.user.id)

  if (userSockets) {
    for (const socket of userSockets) {
      socket.close()
    }

    sockets.delete(req.user.id)
  }

  res.json({ message: '已退出登录' })
})

app.get('/api/contacts', authMiddleware, (req, res) => {
  res.json({
    contacts: listContacts(req.user.id),
  })
})

app.post('/api/contacts', authMiddleware, (req, res) => {
  const username = String(req.body?.username || '').trim()

  if (!username) {
    res.status(400).json({ error: '请输入联系人用户名' })
    return
  }

  const contact = db.prepare('SELECT * FROM users WHERE username = ?').get(username)

  if (!contact) {
    res.status(404).json({ error: '联系人不存在' })
    return
  }

  if (contact.id === req.user.id) {
    res.status(400).json({ error: '不能添加自己为联系人' })
    return
  }

  ensureMutualContact(req.user.id, contact.id)
  broadcastTo(contact.id, { type: 'contact_refresh' })
  res.json({
    message: '联系人已添加',
    contact: {
      username: contact.username,
      nickname: contact.nickname || contact.username,
      avatarUrl: contact.avatar_url || '',
      publicKey: contact.public_key,
    },
  })
})

app.get('/api/profile', authMiddleware, (req, res) => {
  res.json({
    user: publicUser(req.user),
    avatarOptions: AVATAR_OPTIONS,
  })
})

app.post('/api/profile', authMiddleware, (req, res) => {
  const validation = validateProfilePayload(req.body || {})

  if (validation.error) {
    res.status(400).json({ error: validation.error })
    return
  }

  const { nickname, avatarUrl, gender, bio } = validation.value

  db.prepare(
    `
      UPDATE users
      SET nickname = ?, avatar_url = ?, gender = ?, bio = ?
      WHERE id = ?
    `
  ).run(nickname, avatarUrl, gender, bio, req.user.id)

  const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)

  res.json({
    message: '资料已更新',
    user: publicUser(updatedUser),
    avatarOptions: AVATAR_OPTIONS,
  })
})

app.get('/api/messages/:username', authMiddleware, (req, res) => {
  const other = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username)

  if (!other) {
    res.status(404).json({ error: '联系人不存在' })
    return
  }

  ensureMutualContact(req.user.id, other.id)
  const unconfirmedOnly = parseBooleanFlag(req.query.unconfirmedOnly) || parseBooleanFlag(req.query.hideRead)
  const messages = conversationMessages(req.user.id, other.id, { unconfirmedOnly })
  const result = markConversationRead(req.user.id, other.id)

  if (result.changes > 0) {
    broadcastTo(other.id, {
      type: 'messages_read',
      readerUsername: req.user.username,
      peerUsername: other.username,
      readAt: new Date().toISOString(),
    })
  }

  res.json({
    messages,
  })
})

app.post('/api/messages/:username/read', authMiddleware, (req, res) => {
  const other = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username)

  if (!other) {
    res.status(404).json({ error: '联系人不存在' })
    return
  }

  ensureMutualContact(req.user.id, other.id)
  const result = markConversationRead(req.user.id, other.id)

  if (result.changes > 0) {
    broadcastTo(other.id, {
      type: 'messages_read',
      readerUsername: req.user.username,
      peerUsername: other.username,
      readAt: new Date().toISOString(),
    })
  }

  res.json({ updatedCount: result.changes })
})

app.post('/api/webhook', (req, res) => {
  const event = String(req.headers['x-github-event'] || '')

  if (event === 'ping') {
    res.json({ ok: true, message: 'pong' })
    return
  }

  if (event !== 'push') {
    res.json({ ok: true, ignored: true, reason: '仅处理 push 事件' })
    return
  }

  const payloadRef = String(req.body?.ref || '')

  if (payloadRef !== webhookRef) {
    res.json({ ok: true, ignored: true, reason: `仅处理 ${webhookRef}` })
    return
  }

  if (webhookRepoFullName) {
    const payloadRepo = String(req.body?.repository?.full_name || '')

    if (payloadRepo !== webhookRepoFullName) {
      res.json({ ok: true, ignored: true, reason: '仓库不匹配' })
      return
    }
  }

  // 立即响应 GitHub，避免回调超时
  res.json({ ok: true, accepted: true, message: '已接收 push 事件，后台部署已启动' })

  // 在响应刷出后异步执行部署（拉代码 → 装依赖 → 编译前端 → 重启）
  setImmediate(runBackgroundDeploy)
})

app.post('/api/messages/:username', authMiddleware, (req, res) => {
  const { kind, bodyCipher, nonce, clientId } = req.body || {}

  const created = createMessage({
    senderId: req.user.id,
    recipientUsername: req.params.username,
    kind,
    bodyCipher,
    nonce,
    clientId,
  })

  if (created.error) {
    res.status(created.status || 400).json({ error: created.error })
    return
  }

  res.json({
    message: created.message,
    clientId: created.clientId,
  })
})

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))

  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`ShyTalk listening on http://0.0.0.0:${port}`)
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (socket, req) => {
  const origin = new URL(req.url, `http://${req.headers.host}`)
  const token = origin.searchParams.get('token')
  const session = token ? findSession(token) : null

  if (!session) {
    socket.send(JSON.stringify({ type: 'error', error: '连接未授权' }))
    socket.close()
    return
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId)

  if (!user) {
    socket.close()
    return
  }

  const userSockets = sockets.get(user.id) || new Set()
  userSockets.add(socket)
  sockets.set(user.id, userSockets)

  socket.on('message', (raw) => {
    try {
      const payload = JSON.parse(raw.toString())

      if (payload.type !== 'send_message') {
        socket.send(JSON.stringify({ type: 'error', error: '未知消息类型' }))
        return
      }

      const created = createMessage({
        senderId: user.id,
        recipientUsername: payload.recipientUsername,
        kind: payload.kind,
        bodyCipher: payload.bodyCipher,
        nonce: payload.nonce,
        clientId: payload.clientId,
      })

      if (created.error) {
        socket.send(JSON.stringify({ type: 'error', error: created.error }))
      }
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', error: '消息处理失败' }))
    }
  })

  socket.on('close', () => {
    const userSocketsOnClose = sockets.get(user.id)

    if (!userSocketsOnClose) {
      return
    }

    userSocketsOnClose.delete(socket)

    if (userSocketsOnClose.size === 0) {
      sockets.delete(user.id)
    }
  })
})