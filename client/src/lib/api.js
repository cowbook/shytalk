const jsonHeaders = {
  'Content-Type': 'application/json',
}

async function request(path, options = {}) {
  const response = await fetch(path, options)
  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(payload.error || '请求失败')
  }

  return payload
}

export const api = {
  get(path, token) {
    return request(path, {
      headers: token
        ? {
            Authorization: `Bearer ${token}`,
          }
        : undefined,
    })
  },

  post(path, body, token) {
    return request(path, {
      method: 'POST',
      headers: {
        ...jsonHeaders,
        ...(token
          ? {
              Authorization: `Bearer ${token}`,
            }
          : {}),
      },
      body: JSON.stringify(body),
    })
  },
}
