import fs from 'node:fs/promises'
import path from 'node:path'

const SHIP_REQUEST_CONFIG_FILE = path.resolve('resources', 'character', 'request-config.local.json')
const DEFAULT_REQUEST_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'cache-control': 'max-age=0',
  'dnt': '1',
  'priority': 'u=0, i',
  'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0'
}

function normalizeHeaders(headers = {}) {
  const normalized = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    normalized[String(key).toLowerCase()] = String(value)
  }
  return normalized
}

async function loadLocalRequestConfig() {
  try {
    const raw = await fs.readFile(SHIP_REQUEST_CONFIG_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export async function buildShipRequestHeaders(url) {
  const localConfig = await loadLocalRequestConfig()
  const envCookie = process.env.BLHX_SHIP_COOKIE ?? ''
  const cookie = localConfig.cookie || envCookie

  const merged = {
    ...DEFAULT_REQUEST_HEADERS,
    ...normalizeHeaders(localConfig.headers)
  }

  if (cookie) {
    merged.cookie = cookie
  }

  if (url) {
    merged.referer = 'https://wiki.biligame.com/'
  }

  return merged
}

function isRetryableStatus(status) {
  return status === 403 || status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 567
}

function shouldRetry(error) {
  if (!error) {
    return false
  }
  if (error.name === 'TimeoutError') {
    return true
  }
  if (typeof error.status === 'number') {
    return isRetryableStatus(error.status)
  }
  return true
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchShipText(url, options = {}) {
  const {
    method = 'GET',
    retries = 4,
    retryDelayMs = 2500,
    timeoutMs = 30000
  } = options

  let lastError

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const headers = await buildShipRequestHeaders(url)
      const response = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      })

      if (!response.ok) {
        const error = new Error(`请求失败: ${response.status} ${response.statusText}`)
        error.status = response.status
        throw error
      }

      return {
        data: await response.text(),
        contentType: response.headers.get('content-type') ?? '',
        headers
      }
    } catch (error) {
      lastError = error
      if (attempt >= retries || !shouldRetry(error)) {
        break
      }
      await sleep(retryDelayMs * attempt)
    }
  }

  throw lastError
}
