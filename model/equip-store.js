import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchWithRetry } from './equip-request.js'

export const EQUIP_ROOT = fileURLToPath(new URL('../resources/equip', import.meta.url))
export const EQUIP_INDEX_FILE = path.join(EQUIP_ROOT, '装备图鉴_装备基础属性.json')
export const EQUIP_HTML_CACHE_DIR = path.join(EQUIP_ROOT, 'html')
export const EQUIP_IMAGE_DIR = path.join(EQUIP_ROOT, 'img')
export const EQUIP_BUILD_STATE_FILE = path.join(EQUIP_ROOT, 'build-state.json')

export function sanitizeEquipFileName(name) {
  const fileNameMap = {
    '<': '＜',
    '>': '＞',
    ':': '：',
    '"': '＂',
    '/': '／',
    '\\': '＼',
    '|': '｜',
    '?': '？',
    '*': '＊'
  }

  return String(name ?? '')
    .trim()
    .replace(/[<>:"/\\|?*]/g, (char) => fileNameMap[char] ?? '_')
    .replace(/\.+$/g, '')
}

export async function loadEquipIndex() {
  const raw = await fs.readFile(EQUIP_INDEX_FILE, 'utf8')
  return JSON.parse(raw)
}

export async function ensureEquipDirs() {
  await Promise.all([
    fs.mkdir(EQUIP_ROOT, { recursive: true }),
    fs.mkdir(EQUIP_HTML_CACHE_DIR, { recursive: true })
  ])
}

export async function findLocalEquipImage(fullName) {
  const candidates = [
    `${fullName}.jpg`,
    `${fullName}.png`,
    `${fullName}.jpeg`,
    `${fullName}.gif`
  ]

  for (const fileName of candidates) {
    const absolutePath = path.join(EQUIP_IMAGE_DIR, fileName)
    try {
      await fs.access(absolutePath)
      return path.relative(process.cwd(), absolutePath).replace(/\\/g, '/')
    } catch {
      continue
    }
  }

  return ''
}

export function getEquipDataDir(fullName) {
  return path.join(EQUIP_ROOT, sanitizeEquipFileName(fullName))
}

export function getEquipDataFile(fullName) {
  return path.join(getEquipDataDir(fullName), 'data.json')
}

export function getEquipImageDir(fullName) {
  return path.join(getEquipDataDir(fullName), 'img')
}

export function inferEquipImageExtension(remoteUrl, contentType = '') {
  const normalizedType = String(contentType).toLowerCase()
  if (normalizedType.includes('image/png')) {
    return '.png'
  }
  if (normalizedType.includes('image/gif')) {
    return '.gif'
  }
  if (normalizedType.includes('image/webp')) {
    return '.webp'
  }
  if (normalizedType.includes('image/jpeg') || normalizedType.includes('image/jpg')) {
    return '.jpg'
  }

  try {
    const pathname = new URL(remoteUrl).pathname
    const ext = path.extname(pathname)
    return ext || '.jpg'
  } catch {
    return '.jpg'
  }
}

export function getEquipImageFile(fullName, ext = '.jpg') {
  return path.join(getEquipImageDir(fullName), `${sanitizeEquipFileName(fullName)}${ext}`)
}

export function getEquipScopedImageFile(targetFullName, imageName, ext = '.jpg') {
  return path.join(getEquipImageDir(targetFullName), `${sanitizeEquipFileName(imageName)}${ext}`)
}

export function getEquipScopedImageRelativePath(targetFullName, imageName, ext = '.jpg') {
  return path.relative(
    process.cwd(),
    getEquipScopedImageFile(targetFullName, imageName, ext)
  ).replace(/\\/g, '/')
}

export function getExpectedEquipLocalImagePath(fullName, remoteUrl) {
  const ext = inferEquipImageExtension(remoteUrl)
  return getEquipScopedImageRelativePath(fullName, fullName, ext)
}

export async function resolveReferencedEquipImagePath(fullName, remoteUrl) {
  try {
    const data = await readEquipData(fullName)
    return data.local_image || data.image || getExpectedEquipLocalImagePath(fullName, remoteUrl)
  } catch {
    return getExpectedEquipLocalImagePath(fullName, remoteUrl)
  }
}

export function getEquipHtmlCacheFile(fullName) {
  return path.join(EQUIP_HTML_CACHE_DIR, `${sanitizeEquipFileName(fullName)}.html`)
}

export async function readEquipData(fullName) {
  const raw = await fs.readFile(getEquipDataFile(fullName), 'utf8')
  return JSON.parse(raw)
}

export async function writeEquipData(equip) {
  const dirPath = getEquipDataDir(equip.full_name)
  const filePath = path.join(dirPath, 'data.json')

  await fs.mkdir(dirPath, { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(equip, null, 2)}\n`, 'utf8')
  return filePath
}

export async function writeEquipHtmlCache(fullName, html) {
  const filePath = getEquipHtmlCacheFile(fullName)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, html, 'utf8')
  return filePath
}

export async function cleanupEquipImageDir(fullName, keepRelativePaths = []) {
  const dirPath = getEquipImageDir(fullName)
  const keepSet = new Set(keepRelativePaths.map((item) => path.resolve(item)))

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue
      }

      const absolutePath = path.join(dirPath, entry.name)
      if (!keepSet.has(path.resolve(absolutePath))) {
        await fs.unlink(absolutePath)
      }
    }
  } catch {
    // ignore missing folder
  }
}

export async function loadEquipBuildState() {
  try {
    const raw = await fs.readFile(EQUIP_BUILD_STATE_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {
      version: 1,
      completed: [],
      failed: {},
      updated_at: ''
    }
  }
}

export async function writeEquipBuildState(state) {
  const payload = {
    version: 1,
    completed: Array.from(new Set(state.completed ?? [])),
    failed: state.failed ?? {},
    updated_at: new Date().toISOString()
  }

  await fs.mkdir(path.dirname(EQUIP_BUILD_STATE_FILE), { recursive: true })
  await fs.writeFile(EQUIP_BUILD_STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

export async function downloadEquipImage(targetFullName, imageName, remoteUrl, options = {}) {
  const { force = false, retries = 3, retryDelayMs = 2000, timeoutMs = 30000 } = options
  if (!remoteUrl) {
    return ''
  }

  const { data, contentType } = await fetchWithRetry(remoteUrl, {
    method: 'GET',
    retries,
    retryDelayMs,
    timeoutMs,
    responseType: 'arrayBuffer'
  })

  const ext = inferEquipImageExtension(remoteUrl, contentType)
  const filePath = getEquipScopedImageFile(targetFullName, imageName, ext)

  if (!force) {
    try {
      await fs.access(filePath)
      return path.relative(process.cwd(), filePath).replace(/\\/g, '/')
    } catch {
      // continue
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, data)

  return path.relative(process.cwd(), filePath).replace(/\\/g, '/')
}
