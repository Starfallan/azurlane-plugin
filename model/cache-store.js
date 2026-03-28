import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CHARACTER_ROOT = fileURLToPath(new URL('../resources/character', import.meta.url))

let cachePromise

export class CacheLookupError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CacheLookupError'
  }
}

export function normalizeKeyword(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[·・･‧]/g, '')
    .replace(/[()（）[\]【】]/g, '')
    .replace(/[_./\\\-\s]+/g, '')
}

export function getCharacterRoot() {
  return CHARACTER_ROOT
}

export function toShipDirName(name) {
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

async function readShipDataFile(dirName) {
  const raw = await fs.readFile(path.join(CHARACTER_ROOT, dirName, 'data.json'), 'utf8')
  return JSON.parse(raw)
}

function buildCacheMeta(ships) {
  const generatedAt = ships
    .map((ship) => ship.cacheUpdatedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? ''

  return {
    generatedAt,
    count: ships.length
  }
}

export async function readShipCacheFromDisk({ allowMissing = false } = {}) {
  let dirEntries = []

  try {
    dirEntries = await fs.readdir(CHARACTER_ROOT, { withFileTypes: true })
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') {
      return {
        ships: [],
        generatedAt: '',
        count: 0
      }
    }
    throw error
  }

  const shipDirs = dirEntries.filter((entry) => entry.isDirectory())
  const ships = []

  for (const entry of shipDirs) {
    try {
      const ship = await readShipDataFile(entry.name)
      ships.push(ship)
    } catch {
      continue
    }
  }

  return {
    ships,
    ...buildCacheMeta(ships)
  }
}

export async function getShipCache() {
  cachePromise ??= readShipCacheFromDisk()
  return cachePromise
}

export function invalidateShipCache() {
  cachePromise = undefined
}

function scoreShip(ship, keyword) {
  let best = 0

  for (const token of ship.searchKeywords ?? []) {
    if (!token) {
      continue
    }
    if (token === keyword) {
      best = Math.max(best, 100)
      continue
    }
    if (token.startsWith(keyword)) {
      best = Math.max(best, 75)
      continue
    }
    if (token.includes(keyword)) {
      best = Math.max(best, 55)
      continue
    }
    if (keyword.startsWith(token) && token.length > 1) {
      best = Math.max(best, 35)
    }
  }

  const compactName = normalizeKeyword(ship.name)
  if (compactName === keyword) {
    best = Math.max(best, 110)
  }

  return best
}

function formatAlternatives(resultList) {
  if (!resultList.length) {
    return []
  }
  return resultList.slice(0, 5).map((item) => item.ship.name)
}

export async function findShipFromCache(keyword) {
  const query = normalizeKeyword(keyword)
  if (!query) {
    throw new CacheLookupError('请输入要查询的舰船名称。')
  }

  let cache
  try {
    cache = await getShipCache()
  } catch {
    throw new CacheLookupError('未检测到本地舰船缓存，请先执行 `pnpm run build:ships` 在 `resources/character` 下生成数据。')
  }

  if (!Array.isArray(cache?.ships) || cache.ships.length === 0) {
    throw new CacheLookupError('`resources/character` 下还没有舰船资料，请先执行 `pnpm run build:ships` 抓取数据。')
  }

  const ranked = cache.ships
    .map((ship) => ({ ship, score: scoreShip(ship, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score
      }
      return a.ship.name.length - b.ship.name.length
    })

  if (!ranked.length) {
    throw new CacheLookupError(`本地缓存里没有找到“${keyword}”，请先确认名称或重新构建缓存。`)
  }

  const best = ranked[0]
  const alternatives = formatAlternatives(ranked.slice(1))

  return {
    ship: best.ship,
    alternatives,
    cacheMeta: {
      generatedAt: cache.generatedAt,
      count: cache.count
    }
  }
}
