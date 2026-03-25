<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { api } from './lib/api'
import { decryptChatPayload, decryptPrivateKey, encryptChatPayload, generateIdentity } from './lib/crypto'

const STORAGE_KEY = 'shytalk.credentials'
const STORAGE_OPTIONS_KEY = 'shytalk.chat.options'
const IMAGE_SIZE_LIMIT = 2 * 1024 * 1024
const SOCKET_RECONNECT_MIN_DELAY = 1_000
const SOCKET_RECONNECT_MAX_DELAY = 8_000
const emojiPanel = ['😀', '😂', '🥹', '❤️', '👍', '🔥', '🎉', '🌙']
const GENDER_OPTIONS = [
  { value: 'unknown', label: '保密' },
  { value: 'male', label: '男' },
  { value: 'female', label: '女' },
  { value: 'other', label: '其他' },
]

const authMode = ref('login')
const authForm = reactive({
  username: '',
  password: '',
})
const contactForm = reactive({
  username: '',
})
const profileForm = reactive({
  nickname: '',
  avatarUrl: '',
  gender: 'unknown',
  bio: '',
})
const imagePicker = ref(null)
const messagesContainer = ref(null)
const isMobile = ref(false)
const mobilePane = ref('contacts')
const mobileTabs = [
  { key: 'contacts', label: '联系人' },
  { key: 'chat', label: '聊天' },
  { key: 'profile', label: '我的' },
]
const installPromptEvent = ref(null)
const socketReconnectTimer = ref(null)
const socketReconnectAttempts = ref(0)

const state = reactive({
  status: 'booting',
  authToken: '',
  currentUser: null,
  privateKey: null,
  contacts: [],
  activeContact: null,
  messages: [],
  draft: '',
  error: '',
  info: '',
  socket: null,
  socketState: 'offline',
  loadingMessages: false,
  sendingImage: false,
  hideReadOnOpen: true,
  previewImage: '',
  clientCounter: 0,
  avatarOptions: [],
  savingProfile: false,
  showComposerExtras: false,
})

const activeTitle = computed(() => state.activeContact?.username || '选择联系人')
const showContactsPane = computed(() => !isMobile.value || mobilePane.value === 'contacts')
const showChatPane = computed(() => !isMobile.value || mobilePane.value === 'chat')
const showProfilePane = computed(() => isMobile.value && mobilePane.value === 'profile')
const canInstallPwa = computed(() => Boolean(installPromptEvent.value))
const currentDisplayName = computed(() => state.currentUser?.nickname || state.currentUser?.username || '')
const activeSubtitle = computed(() => {
  if (!state.activeContact) {
    return '选择联系人后开始端到端加密聊天'
  }

  return '文字、表情、图片都会先在浏览器端加密'
})
const cacheStateText = computed(() => (state.currentUser ? '已保存在本机' : '等待登录'))
const encryptionStateText = computed(() => (state.privateKey ? '本机私钥已解锁' : '尚未解锁'))
const sessionStateText = computed(() => (state.socketState === 'online' ? '实时连接已建立' : '实时连接待恢复'))

function contactDisplayName(contact) {
  return contact?.nickname || contact?.username || ''
}

function syncProfileFormFromCurrentUser() {
  profileForm.nickname = state.currentUser?.nickname || state.currentUser?.username || ''
  profileForm.avatarUrl = state.currentUser?.avatarUrl || state.avatarOptions[0] || ''
  profileForm.gender = state.currentUser?.gender || 'unknown'
  profileForm.bio = state.currentUser?.bio || ''
}

function loadChatOptions() {
  const raw = localStorage.getItem(STORAGE_OPTIONS_KEY)

  if (!raw) {
    state.hideReadOnOpen = true
    return
  }

  try {
    const parsed = JSON.parse(raw)
    state.hideReadOnOpen = parsed.hideReadOnOpen !== false
  } catch {
    state.hideReadOnOpen = true
  }
}

function saveChatOptions() {
  localStorage.setItem(
    STORAGE_OPTIONS_KEY,
    JSON.stringify({
      hideReadOnOpen: state.hideReadOnOpen,
    })
  )
}

function shortenPreview(text, maxLength = 22) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function fallbackPreview(kind, outgoing) {
  const prefix = outgoing ? '你: ' : ''
  return kind === 'image' ? `${prefix}[图片]` : `${prefix}新消息`
}

function formatPreviewPayload(kind, payload, outgoing) {
  const prefix = outgoing ? '你: ' : ''

  if (kind === 'image' || payload.imageDataUrl) {
    return `${prefix}[图片]`
  }

  const text = String(payload.text || '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) {
    return `${prefix}新消息`
  }

  return `${prefix}${shortenPreview(text)}`
}

function buildPreviewFromEncryptedMessage(message, contact) {
  if (!message?.bodyCipher || !message?.nonce || !contact || !state.privateKey) {
    return message?.kind === 'image' ? '[图片]' : '点击开始聊天'
  }

  const outgoing = message.senderUsername === state.currentUser?.username

  try {
    const payload = decryptChatPayload(message.bodyCipher, message.nonce, contact.publicKey, state.privateKey)
    return formatPreviewPayload(message.kind, payload, outgoing)
  } catch {
    return fallbackPreview(message.kind, outgoing)
  }
}

function normalizeContact(contact) {
  return {
    ...contact,
    nickname: contact.nickname || contact.username,
    avatarUrl: contact.avatarUrl || '',
    unreadCount: Number(contact.unreadCount || 0),
    previewText: contact.lastMessageAt
      ? buildPreviewFromEncryptedMessage(
          {
            kind: contact.lastMessageKind,
            bodyCipher: contact.lastMessageBodyCipher,
            nonce: contact.lastMessageNonce,
            senderUsername: contact.lastMessageSenderUsername,
          },
          contact
        )
      : '点击开始聊天',
  }
}

function updateContactEntry(username, updates) {
  const contact = state.contacts.find((item) => item.username === username)

  if (!contact) {
    return null
  }

  Object.assign(contact, updates)

  if (state.activeContact?.username === username) {
    Object.assign(state.activeContact, updates)
  }

  return contact
}

async function markConversationRead(username) {
  if (!username || !state.authToken) {
    return
  }

  updateContactEntry(username, { unreadCount: 0 })

  try {
    await api.post(`/api/messages/${encodeURIComponent(username)}/read`, {}, state.authToken)
  } catch {
    // Ignore transient sync failures and let the next contacts refresh reconcile state.
  }
}

function syncViewportMode() {
  const keepProfilePane = mobilePane.value === 'profile'
  isMobile.value = window.innerWidth <= 820

  if (!isMobile.value) {
    mobilePane.value = 'chat'
    return
  }

  if (keepProfilePane) {
    mobilePane.value = 'profile'
    return
  }

  mobilePane.value = state.activeContact ? 'chat' : 'contacts'
}

function setMobilePane(pane) {
  mobilePane.value = pane
}

function setNotice(message = '') {
  state.error = ''
  state.info = message
}

function setError(message) {
  state.info = ''
  state.error = message
}

function wsUrl(token) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`
}

function storeCredentials(username) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      username,
    })
  )
}

function loadCredentials() {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

function formatClock(value) {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function normalizeUsername(value) {
  return value.trim()
}

function scrollMessagesToBottom() {
  nextTick(() => {
    const container = messagesContainer.value

    if (!container) {
      return
    }

    container.scrollTop = container.scrollHeight
  })
}

function peerOfMessage(message) {
  if (!state.currentUser) {
    return null
  }

  return message.senderUsername === state.currentUser.username
    ? message.recipientUsername
    : message.senderUsername
}

function decodeMessage(message, contact) {
  const payload = decryptChatPayload(
    message.bodyCipher,
    message.nonce,
    contact.publicKey,
    state.privateKey
  )
  const outgoing = message.senderUsername === state.currentUser.username

  return {
    id: message.id,
    senderUsername: message.senderUsername,
    recipientUsername: message.recipientUsername,
    outgoing,
    kind: message.kind,
    text: payload.text || '',
    imageDataUrl: payload.imageDataUrl || '',
    createdAt: message.createdAt,
    readAt: message.readAt || '',
    status: outgoing ? (message.readAt ? 'read' : 'delivered') : '',
  }
}

async function loadContacts() {
  const activeUsername = state.activeContact?.username
  const payload = await api.get('/api/contacts', state.authToken)
  state.contacts = payload.contacts.map((contact) => normalizeContact(contact))

  if (activeUsername) {
    const activeContact = state.contacts.find((contact) => contact.username === activeUsername)

    if (activeContact) {
      state.activeContact = activeContact
    }
  }

  if (!state.activeContact && state.contacts.length > 0) {
    await openConversation(state.contacts[0])
  }
}

async function openConversation(contact) {
  state.activeContact = contact
  state.loadingMessages = true

  if (isMobile.value) {
    mobilePane.value = 'chat'
  }

  setNotice('')

  try {
    const search = state.hideReadOnOpen ? '?unconfirmedOnly=1' : ''
    const payload = await api.get(`/api/messages/${encodeURIComponent(contact.username)}${search}`, state.authToken)
    state.messages = payload.messages.map((message) => decodeMessage(message, contact))
    updateContactEntry(contact.username, { unreadCount: 0 })
    scrollMessagesToBottom()
  } catch (error) {
    setError(error.message)
  } finally {
    state.loadingMessages = false
  }
}

function showContacts() {
  setMobilePane('contacts')
}

function touchContact(username) {
  const index = state.contacts.findIndex((contact) => contact.username === username)

  if (index <= 0) {
    return
  }

  const [contact] = state.contacts.splice(index, 1)
  state.contacts.unshift(contact)
}

function nextClientId() {
  state.clientCounter += 1
  return `${Date.now()}-${state.clientCounter}`
}

function appendLocalSendingMessage(contact, kind, payload, clientId) {
  const now = new Date().toISOString()

  const localMessage = {
    id: `pending:${clientId}`,
    senderUsername: state.currentUser.username,
    recipientUsername: contact.username,
    outgoing: true,
    kind,
    text: payload.text || '',
    imageDataUrl: payload.imageDataUrl || '',
    createdAt: now,
    readAt: '',
    status: 'sending',
  }

  state.messages.push(localMessage)

  updateContactEntry(contact.username, {
    lastMessageAt: now,
    previewText: formatPreviewPayload(kind, payload, true),
  })

  scrollMessagesToBottom()
}

function hasMessageId(messageId) {
  return state.messages.some((message) => String(message.id) === String(messageId))
}

function applyReadReceipt(contactUsername, readAt) {
  for (const message of state.messages) {
    if (
      message.outgoing &&
      message.recipientUsername === contactUsername &&
      message.status !== 'sending' &&
      !message.readAt
    ) {
      message.readAt = readAt
      message.status = 'read'
    }
  }
}

async function finishAuth(sessionPayload, password, username) {
  state.authToken = sessionPayload.token
  state.currentUser = sessionPayload.user
  state.avatarOptions = sessionPayload.avatarOptions || state.avatarOptions
  state.privateKey = await decryptPrivateKey(
    password,
    sessionPayload.user.keySalt,
    sessionPayload.user.encryptedPrivateKey
  )
  syncProfileFormFromCurrentUser()
  storeCredentials(username)
  state.status = 'ready'
  mobilePane.value = isMobile.value && !state.activeContact ? 'contacts' : 'chat'
  setNotice('已连接')
  await loadContacts()
  connectSocket()
}

async function saveProfile() {
  if (!state.authToken) {
    return
  }

  state.savingProfile = true

  try {
    const payload = await api.post(
      '/api/profile',
      {
        nickname: profileForm.nickname.trim(),
        avatarUrl: profileForm.avatarUrl,
        gender: profileForm.gender,
        bio: profileForm.bio,
      },
      state.authToken
    )

    state.currentUser = payload.user
    state.avatarOptions = payload.avatarOptions || state.avatarOptions
    syncProfileFormFromCurrentUser()
    setNotice(payload.message || '资料已更新')
  } catch (error) {
    setError(error.message)
  } finally {
    state.savingProfile = false
  }
}

async function logout() {
  const token = state.authToken
  const rememberedUsername = state.currentUser?.username || authForm.username

  clearSocketReconnectTimer()
  state.socket?.close()
  state.socket = null
  state.socketState = 'offline'

  if (token) {
    try {
      await api.post('/api/auth/logout', {}, token)
    } catch {
      // Ignore logout API failures and still clear local auth state.
    }
  }

  if (rememberedUsername) {
    storeCredentials(rememberedUsername)
  }
  contactForm.username = ''
  authForm.password = ''
  authForm.username = rememberedUsername || ''
  authMode.value = 'login'

  state.status = 'auth'
  state.authToken = ''
  state.currentUser = null
  state.privateKey = null
  state.contacts = []
  state.activeContact = null
  state.messages = []
  state.draft = ''
  state.previewImage = ''
  state.loadingMessages = false
  state.sendingImage = false
  state.savingProfile = false
  state.error = ''
  state.info = ''
}

async function submitAuth() {
  const username = normalizeUsername(authForm.username)
  const password = authForm.password.trim()

  if (!username || !password) {
    setError('请输入用户名和密码')
    return
  }

  state.status = 'loading'
  setNotice('')

  try {
    if (authMode.value === 'register') {
      const identity = await generateIdentity(password)
      const payload = await api.post('/api/auth/register', {
        username,
        password,
        ...identity,
      })
      await finishAuth(payload, password, username)
    } else {
      const payload = await api.post('/api/auth/login', {
        username,
        password,
      })
      await finishAuth(payload, password, username)
    }
  } catch (error) {
    state.status = 'auth'
    setError(error.message)
    return
  }

  authForm.username = username
  authForm.password = password
}

async function bootstrap() {
  state.status = 'booting'

  try {
    const saved = loadCredentials()

    if (saved?.username) {
      authForm.username = saved.username
    }
  } catch {
    // Ignore malformed local cache and continue with manual login.
  }

  authForm.password = ''
  state.status = 'auth'
  authMode.value = 'login'
}

async function addContact() {
  const username = normalizeUsername(contactForm.username)

  if (!username) {
    setError('请输入联系人用户名')
    return
  }

  try {
    const payload = await api.post(
      '/api/contacts',
      {
        username,
      },
      state.authToken
    )

    contactForm.username = ''
    setNotice(payload.message)
    await loadContacts()
    const addedContact = state.contacts.find((contact) => contact.username === username)

    if (addedContact) {
      await openConversation(addedContact)
    }
  } catch (error) {
    setError(error.message)
  }
}

function appendIncomingMessage(message, clientId = '') {
  const peerUsername = peerOfMessage(message)

  if (!peerUsername) {
    return
  }

  const contact = state.contacts.find((item) => item.username === peerUsername)

  if (!contact) {
    loadContacts().catch(() => {})
    return
  }

  touchContact(contact.username)
  updateContactEntry(contact.username, {
    lastMessageAt: message.createdAt,
    lastMessageKind: message.kind,
    lastMessageBodyCipher: message.bodyCipher,
    lastMessageNonce: message.nonce,
    lastMessageSenderUsername: message.senderUsername,
    lastMessageRecipientUsername: message.recipientUsername,
    previewText: buildPreviewFromEncryptedMessage(message, contact),
    unreadCount:
      message.senderUsername !== state.currentUser.username && state.activeContact?.username !== contact.username
        ? Number(contact.unreadCount || 0) + 1
        : 0,
  })

  const isOutgoing = message.senderUsername === state.currentUser.username
  const isActiveConversation = state.activeContact?.username === contact.username

  if (!isActiveConversation) {
    return
  }

  if (isOutgoing) {
    const pendingId = `pending:${clientId}`
    const pendingIndex = clientId ? state.messages.findIndex((item) => item.id === pendingId) : -1
    const decoded = decodeMessage(message, contact)

    if (pendingIndex >= 0) {
      state.messages.splice(pendingIndex, 1, decoded)
      scrollMessagesToBottom()
      return
    }

    if (!hasMessageId(message.id)) {
      state.messages.push(decoded)
      scrollMessagesToBottom()
    }

    return
  }

  try {
    if (!hasMessageId(message.id)) {
      state.messages.push(decodeMessage(message, contact))
    }
    markConversationRead(contact.username).catch(() => {})
    scrollMessagesToBottom()
  } catch (error) {
    setError(error.message)
  }
}

function connectSocket() {
  if (!state.authToken) {
    return
  }

  clearSocketReconnectTimer()
  state.socket?.close()
  state.socketState = 'connecting'
  const socket = new WebSocket(wsUrl(state.authToken))
  let downHandled = false

  function handleSocketDown() {
    if (downHandled) {
      return
    }

    downHandled = true

    if (state.socket === socket) {
      state.socket = null
    }

    scheduleSocketReconnect()
  }

  socket.addEventListener('open', () => {
    clearSocketReconnectTimer()
    socketReconnectAttempts.value = 0
    state.socketState = 'online'
    setNotice('实时连接已建立')
  })

  socket.addEventListener('message', (event) => {
    let payload = null

    try {
      payload = JSON.parse(event.data)
    } catch {
      return
    }

    if (payload.type === 'message_created') {
      appendIncomingMessage(payload.message, payload.clientId || '')
      return
    }

    if (payload.type === 'messages_read') {
      if (payload.peerUsername === state.currentUser?.username) {
        applyReadReceipt(payload.readerUsername, payload.readAt || new Date().toISOString())
      }
      return
    }

    if (payload.type === 'contact_refresh') {
      loadContacts().catch(() => {})
      return
    }

    if (payload.type === 'error') {
      setError(payload.error)
    }
  })

  socket.addEventListener('close', () => {
    handleSocketDown()
  })

  socket.addEventListener('error', () => {
    handleSocketDown()
  })

  state.socket = socket
}

function clearSocketReconnectTimer() {
  if (!socketReconnectTimer.value) {
    return
  }

  clearTimeout(socketReconnectTimer.value)
  socketReconnectTimer.value = null
}

function scheduleSocketReconnect() {
  if (!state.authToken || state.status !== 'ready') {
    state.socketState = 'offline'
    return
  }

  clearSocketReconnectTimer()
  const delay = Math.min(
    SOCKET_RECONNECT_MAX_DELAY,
    SOCKET_RECONNECT_MIN_DELAY * 2 ** socketReconnectAttempts.value
  )
  socketReconnectAttempts.value += 1
  state.socketState = 'reconnecting'

  socketReconnectTimer.value = window.setTimeout(() => {
    connectSocket()
  }, delay)
}

function markPendingMessageFailed(clientId) {
  const pendingId = `pending:${clientId}`
  const pending = state.messages.find((message) => message.id === pendingId)

  if (!pending) {
    return
  }

  pending.status = 'failed'
}

async function sendCipherMessage(kind, encryptedPayload, clientId) {
  if (!state.activeContact) {
    throw new Error('请先选择联系人')
  }

  const payload = await api.post(
    `/api/messages/${encodeURIComponent(state.activeContact.username)}`,
    {
      kind,
      clientId,
      ...encryptedPayload,
    },
    state.authToken
  )

  appendIncomingMessage(payload.message, payload.clientId || clientId)
}

async function sendDraft() {
  const text = state.draft.trim()

  if (!text || !state.activeContact) {
    return
  }

  const clientId = nextClientId()

  try {
    const plainPayload = {
      text,
    }
    appendLocalSendingMessage(state.activeContact, 'text', plainPayload, clientId)

    const encryptedPayload = encryptChatPayload(
      plainPayload,
      state.activeContact.publicKey,
      state.privateKey
    )

    await sendCipherMessage('text', encryptedPayload, clientId)
    state.draft = ''
  } catch (error) {
    markPendingMessageFailed(clientId)
    setError(error.message)
  }
}

function appendEmoji(emoji) {
  state.draft += emoji
}

function toggleComposerExtras() {
  state.showComposerExtras = !state.showComposerExtras
}

function selectImage() {
  imagePicker.value?.click()
}

function openImagePreview(imageDataUrl) {
  state.previewImage = imageDataUrl || ''
}

function closeImagePreview() {
  state.previewImage = ''
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

async function handleImageSelect(event) {
  const file = event.target.files?.[0]
  event.target.value = ''

  if (!file || !state.activeContact) {
    return
  }

  if (file.size > IMAGE_SIZE_LIMIT) {
    setError('图片请控制在 2MB 以内')
    return
  }

  state.sendingImage = true
  const clientId = nextClientId()

  try {
    const imageDataUrl = await readFileAsDataUrl(file)
    const plainPayload = {
      imageDataUrl,
    }

    appendLocalSendingMessage(state.activeContact, 'image', plainPayload, clientId)

    const encryptedPayload = encryptChatPayload(
      plainPayload,
      state.activeContact.publicKey,
      state.privateKey
    )

    await sendCipherMessage('image', encryptedPayload, clientId)
  } catch (error) {
    markPendingMessageFailed(clientId)
    setError(error.message)
  } finally {
    state.sendingImage = false
  }
}

async function promptInstallPwa() {
  if (!installPromptEvent.value) {
    return
  }

  const promptEvent = installPromptEvent.value
  installPromptEvent.value = null

  await promptEvent.prompt()
  await promptEvent.userChoice
}

function onBeforeInstallPrompt(event) {
  event.preventDefault()
  installPromptEvent.value = event
}

function onAppInstalled() {
  installPromptEvent.value = null
  setNotice('已安装到桌面')
}

onMounted(() => {
  syncViewportMode()
  loadChatOptions()
  window.addEventListener('resize', syncViewportMode)
  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.addEventListener('appinstalled', onAppInstalled)

  bootstrap().catch(() => {
    state.status = 'auth'
    setError('初始化失败，请手动登录')
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncViewportMode)
  window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.removeEventListener('appinstalled', onAppInstalled)
  clearSocketReconnectTimer()
  state.socket?.close()
})

watch(
  () => state.activeContact?.username,
  () => {
    if (state.activeContact) {
      scrollMessagesToBottom()
    }
  }
)

watch(
  () => state.messages.length,
  () => {
    scrollMessagesToBottom()
  }
)

watch(
  () => state.hideReadOnOpen,
  () => {
    saveChatOptions()
  }
)
</script>

<template>
  <div class="shell">
    <div class="backdrop"></div>

    <section v-if="state.status === 'booting' || state.status === 'loading'" class="auth-card compact-card">
      <p class="eyebrow">ShyTalk</p>
      <h1>正在进入加密聊天</h1>
      <p class="muted">首次注册后，后续会自动使用本地缓存的用户名和密码登录。</p>
    </section>

    <section v-else-if="state.status === 'auth'" class="auth-card">
      <p class="eyebrow">ShyTalk</p>
      <h1>{{ authMode === 'register' ? '创建你的聊天身份' : '登录' }}</h1>
      <p class="muted">
        {{ authMode === 'register' ? '用户名将作为联系人添加时使用的账号名。' : '会记住登录名，但每次都需要输入密码。' }}
      </p>

      <form class="auth-form" @submit.prevent="submitAuth">
        <label>
          <span>用户名</span>
          <input v-model="authForm.username" maxlength="20" placeholder="例如：momo 或 小宇" />
        </label>

        <label>
          <span>密码</span>
          <input v-model="authForm.password" type="password" maxlength="64" placeholder="至少 6 位" />
        </label>

        <button type="submit" class="primary-button">
          {{ authMode === 'register' ? '注册并进入' : '登录' }}
        </button>
      </form>

      <button type="button" class="ghost-button" @click="authMode = authMode === 'register' ? 'login' : 'register'">
        {{ authMode === 'register' ? '已有账号，去登录' : '没有账号，立即注册' }}
      </button>

      <p v-if="state.error" class="notice error">{{ state.error }}</p>
    </section>

    <main v-else class="app-frame">
      <aside v-if="showContactsPane" class="sidebar" :class="{ 'mobile-pane': isMobile }">
        <div class="sidebar-header">
          <div class="sidebar-user">
            <img v-if="state.currentUser?.avatarUrl" :src="state.currentUser.avatarUrl" alt="我的头像" class="avatar avatar-lg" />
            <p class="eyebrow">在线身份</p>
            <h2>{{ currentDisplayName }}</h2>
            <p class="muted username-tag">@{{ state.currentUser?.username }}</p>
          </div>

          <span class="status-pill" :class="state.socketState">{{ state.socketState }}</span>
        </div>

        <div class="mobile-summary">
          <div>
            <strong>{{ state.contacts.length }}</strong>
            <span>联系人</span>
          </div>
          <div>
            <strong>{{ state.socketState === 'online' ? '已加密' : '待连接' }}</strong>
            <span>连接状态</span>
          </div>
        </div>

        <form class="contact-form" @submit.prevent="addContact">
          <input v-model="contactForm.username" maxlength="20" placeholder="输入用户名添加联系人" />
          <button type="submit">添加</button>
        </form>

        <div class="contacts">
          <button
            v-for="contact in state.contacts"
            :key="contact.username"
            type="button"
            class="contact-item"
            :class="{ active: state.activeContact?.username === contact.username }"
            @click="openConversation(contact)"
          >
            <img v-if="contact.avatarUrl" :src="contact.avatarUrl" alt="联系人头像" class="avatar" />
            <div class="contact-copy">
              <strong>{{ contactDisplayName(contact) }}</strong>
              <p class="contact-preview">{{ contact.previewText }}</p>
            </div>

            <div class="contact-meta">
              <p>{{ contact.lastMessageAt ? formatClock(contact.lastMessageAt) : '刚添加' }}</p>
              <span v-if="contact.unreadCount > 0" class="unread-badge">{{ contact.unreadCount > 99 ? '99+' : contact.unreadCount }}</span>
              <span v-else class="contact-dot"></span>
            </div>
          </button>

          <div v-if="state.contacts.length === 0" class="empty-card">
            <p>还没有联系人</p>
            <span>先输入一个用户名把对方加进来。</span>
          </div>
        </div>
      </aside>

      <section v-if="showChatPane" class="chat-panel" :class="{ 'mobile-pane': isMobile }">
        <header class="chat-header">
          <div class="chat-title-wrap">
            <!--
            <button v-if="isMobile" type="button" class="back-button" @click="showContacts">通讯录</button>
          -->
            <div>
              <p class="eyebrow">当前会话</p>
              <h2>{{ activeTitle }}</h2>
            </div>
          </div>
          <!--
          <div class="chat-header-right">
            <label class="read-toggle">
              <input v-model="state.hideReadOnOpen" type="checkbox" />
              <span>仅看未确认</span>
            </label>
            <p class="muted chat-header-note">{{ activeSubtitle }}</p>
          </div>
        -->
        </header>

        <div v-if="!state.activeContact" class="chat-empty">
          <h3>{{ isMobile ? '先从通讯录里选择联系人' : '从左侧选择一个联系人' }}</h3>
          <p>或者直接输入用户名添加对方，双方就可以开始加密聊天。</p>
        </div>

        <template v-else>
          <div v-if="state.loadingMessages" class="chat-empty">
            <p>正在加载消息…</p>
          </div>

          <div v-else ref="messagesContainer" class="messages">
            <article
              v-for="message in state.messages"
              :key="message.id"
              class="message-row"
              :class="{ outgoing: message.outgoing }"
            >
              <div class="message-bubble">
                <p v-if="message.kind === 'text'">{{ message.text }}</p>
                <img
                  v-else
                  :src="message.imageDataUrl"
                  alt="聊天图片"
                  class="message-image"
                  @click="openImagePreview(message.imageDataUrl)"
                />
                <div class="message-meta">
                  <span>{{ formatClock(message.createdAt) }}</span>
                  <strong v-if="message.outgoing" class="message-state">
                    {{ message.status === 'sending' ? '发送中' : message.status === 'read' ? '已读' : '已送达' }}
                  </strong>
                </div>
              </div>
            </article>
          </div>

          <div class="composer">

            <div v-if="state.showComposerExtras" class="composer-tools-row">
             

              <button
                v-for="emoji in emojiPanel"
                :key="emoji"
                type="button"
                class="emoji-button"
                @click="appendEmoji(emoji)"
              >
                {{ emoji }}
              </button>
            </div>

            <div class="composer-up">
              <input ref="imagePicker" type="file" accept="image/*" hidden @change="handleImageSelect" />
               <button
                type="button"
                class="ghost-button image-icon-button"
                :title="state.sendingImage ? '图片发送中' : '发送图片'"
                :aria-label="state.sendingImage ? '图片发送中' : '发送图片'"
                @click="selectImage"
              >
                {{ state.sendingImage ? '...' : '🖼' }}
              </button>
              <button
                    type="button"
                    class="ghost-button toggle-tools-button"
                    :title="state.showComposerExtras ? '收起工具栏' : '展开工具栏'"
                    :aria-label="state.showComposerExtras ? '收起工具栏' : '展开工具栏'"
                    @click="toggleComposerExtras"
                  >
                    {{ state.showComposerExtras ? '−' : '+' }}
                  </button>
            </div>

            <div class="composer-box">
              <div class="composer-inline">
                <textarea
                  v-model="state.draft"
                  rows="1"
                  placeholder="输入文字，或者点上方表情。按 Enter 发送，Shift + Enter 换行。"
                  @keydown.enter.exact.prevent="sendDraft"
                ></textarea>

                <div class="composer-actions">
                
                  <button type="button" class="primary-button send-pill-button" @click="sendDraft">发送</button>
                </div>
              </div>
            </div>
          </div>
        </template>

        <footer class="panel-foot">
          <p v-if="state.error" class="notice error">{{ state.error }}</p>
          <p v-else-if="state.info" class="notice info">{{ state.info }}</p>
        </footer>
      </section>

      <section v-if="showProfilePane" class="profile-panel mobile-pane">
        <header class="profile-header">
          <div class="profile-title">
            <img v-if="profileForm.avatarUrl" :src="profileForm.avatarUrl" alt="头像预览" class="avatar avatar-lg" />
            <p class="eyebrow">我的</p>
            <h2>{{ currentDisplayName }}</h2>
            <p class="muted username-tag">@{{ state.currentUser?.username }}</p>
          </div>

          <span class="status-pill" :class="state.socketState">{{ state.socketState }}</span>
        </header>

        <div class="profile-grid">
          <article class="profile-card accent-card">
            <p class="eyebrow">资料编辑</p>

            <label class="profile-label">
              <span>昵称</span>
              <input v-model="profileForm.nickname" maxlength="24" placeholder="输入你的昵称" />
            </label>

            <label class="profile-label">
              <span>性别</span>
              <select v-model="profileForm.gender" class="profile-select">
                <option v-for="item in GENDER_OPTIONS" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
            </label>

            <label class="profile-label">
              <span>说明</span>
              <textarea v-model="profileForm.bio" rows="3" maxlength="140" placeholder="一句话介绍自己"></textarea>
            </label>

            <button type="button" class="primary-button" :disabled="state.savingProfile" @click="saveProfile">
              {{ state.savingProfile ? '保存中...' : '保存资料' }}
            </button>
          </article>

          <article class="profile-card">
            <p class="eyebrow">萌萌头像（10选1）</p>
            <div class="avatar-grid">
              <button
                v-for="avatar in state.avatarOptions"
                :key="avatar"
                type="button"
                class="avatar-pick"
                :class="{ active: profileForm.avatarUrl === avatar }"
                @click="profileForm.avatarUrl = avatar"
              >
                <img :src="avatar" alt="可选头像" class="avatar" />
              </button>
            </div>
          </article>

          <article class="profile-card">
            <p class="eyebrow">本地缓存</p>
            <strong>{{ cacheStateText }}</strong>
            <span>用户名和密码会按你的需求长期保存在浏览器本地。</span>
          </article>

          <article class="profile-card">
            <p class="eyebrow">加密状态</p>
            <strong>{{ encryptionStateText }}</strong>
            <span>消息发送前会先在当前浏览器完成加密。</span>
          </article>

          <article class="profile-card">
            <p class="eyebrow">实时连接</p>
            <strong>{{ sessionStateText }}</strong>
            <span>连接恢复后会继续使用当前身份收发消息。</span>
          </article>

          <article class="profile-card">
            <p class="eyebrow">安装到桌面</p>
            <strong>{{ canInstallPwa ? '可安装' : '已安装或当前设备不支持' }}</strong>
            <button v-if="canInstallPwa" type="button" class="ghost-button" @click="promptInstallPwa">添加到手机桌面</button>
            <span v-else>在支持的浏览器中会自动出现安装入口。</span>
          </article>

          <article class="profile-card wide-card">
            <p class="eyebrow">当前会话</p>
            <strong>{{ state.activeContact?.username || '还没有选择联系人' }}</strong>
            <span>
              {{ state.activeContact ? '点底部“聊天”即可继续当前会话。' : '先去联系人页添加或选择一个联系人。' }}
            </span>
          </article>

          <article class="profile-card">
            <p class="eyebrow">账号</p>
            <strong>需要更换账号？</strong>
            <button type="button" class="ghost-button logout-button" @click="logout">退出登录</button>
            <span>退出后会清除会话状态并返回登录页，登录名会保留。</span>
          </article>
        </div>
      </section>

      <nav v-if="isMobile" class="mobile-tabbar" aria-label="手机导航">
        <button
          v-for="tab in mobileTabs"
          :key="tab.key"
          type="button"
          class="tab-button"
          :class="{ active: mobilePane === tab.key }"
          @click="setMobilePane(tab.key)"
        >
          {{ tab.label }}
        </button>
      </nav>
    </main>

    <div v-if="state.previewImage" class="image-lightbox" @click="closeImagePreview">
      <img :src="state.previewImage" alt="全屏预览" class="lightbox-image" />
      <button type="button" class="lightbox-close">关闭</button>
    </div>
  </div>
</template>
