import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'

function toBase64(bytes) {
  return naclUtil.encodeBase64(bytes)
}

function fromBase64(value) {
  return naclUtil.decodeBase64(value)
}

async function derivePasswordKey(password, saltBase64) {
  const encoder = new TextEncoder()
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: fromBase64(saltBase64),
      iterations: 210000,
      hash: 'SHA-256',
    },
    passwordKey,
    256
  )

  return new Uint8Array(derivedBits)
}

export async function generateIdentity(password) {
  const keyPair = nacl.box.keyPair()
  const salt = nacl.randomBytes(16)
  const saltBase64 = toBase64(salt)
  const passwordKey = await derivePasswordKey(password, saltBase64)
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const encryptedSecretKey = nacl.secretbox(keyPair.secretKey, nonce, passwordKey)
  const packedSecretKey = new Uint8Array(nonce.length + encryptedSecretKey.length)

  packedSecretKey.set(nonce, 0)
  packedSecretKey.set(encryptedSecretKey, nonce.length)

  return {
    publicKey: toBase64(keyPair.publicKey),
    encryptedPrivateKey: toBase64(packedSecretKey),
    keySalt: saltBase64,
  }
}

export async function decryptPrivateKey(password, keySalt, encryptedPrivateKey) {
  const passwordKey = await derivePasswordKey(password, keySalt)
  const packedSecretKey = fromBase64(encryptedPrivateKey)
  const nonceLength = nacl.secretbox.nonceLength
  const nonce = packedSecretKey.slice(0, nonceLength)
  const cipherBytes = packedSecretKey.slice(nonceLength)
  const secretKey = nacl.secretbox.open(cipherBytes, nonce, passwordKey)

  if (!secretKey) {
    throw new Error('无法解锁私钥，请确认密码正确')
  }

  return secretKey
}

export function encryptChatPayload(payload, peerPublicKeyBase64, mySecretKey) {
  const peerPublicKey = fromBase64(peerPublicKeyBase64)
  const sharedKey = nacl.box.before(peerPublicKey, mySecretKey)
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const cipherBytes = nacl.box.after(
    naclUtil.decodeUTF8(JSON.stringify(payload)),
    nonce,
    sharedKey
  )

  return {
    nonce: toBase64(nonce),
    bodyCipher: toBase64(cipherBytes),
  }
}

export function decryptChatPayload(bodyCipher, nonce, peerPublicKeyBase64, mySecretKey) {
  const peerPublicKey = fromBase64(peerPublicKeyBase64)
  const sharedKey = nacl.box.before(peerPublicKey, mySecretKey)
  const plainBytes = nacl.box.open.after(fromBase64(bodyCipher), fromBase64(nonce), sharedKey)

  if (!plainBytes) {
    throw new Error('消息解密失败')
  }

  return JSON.parse(naclUtil.encodeUTF8(plainBytes))
}
