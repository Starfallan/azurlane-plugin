import path from 'node:path'
import fs from 'node:fs/promises'
import { getEquipDataFile, loadEquipIndex, readEquipData } from './equip-store.js'

let equipIndexPromise

export class EquipLookupError extends Error {
  constructor(message, reason = 'unknown') {
    super(message)
    this.name = 'EquipLookupError'
    this.reason = reason
  }
}

function normalizeKeyword(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[·・･‧]/g, '')
    .replace(/[()（）[\]【】]/g, '')
    .replace(/[_./\\\-\s]+/g, '')
}

function normalizeTier(value) {
  return String(value ?? '').trim().toUpperCase()
}

function normalizeDisplayName(value) {
  return String(value ?? '').replace(/T\d+$/i, '').trim()
}

function buildSearchKeywords(entry) {
  const keywords = new Set()
  const name = String(entry.name ?? '').trim()
  const fullName = String(entry.full_name ?? '').trim()
  const tier = normalizeTier(entry.tier)

  for (const value of [name, fullName, normalizeDisplayName(fullName)]) {
    const normalized = normalizeKeyword(value)
    if (normalized) {
      keywords.add(normalized)
    }
  }

  if (tier) {
    const normalizedNameTier = normalizeKeyword(`${name}${tier}`)
    if (normalizedNameTier) {
      keywords.add(normalizedNameTier)
    }
  }

  return Array.from(keywords)
}

async function getEquipIndex() {
  equipIndexPromise ??= (async () => {
    const index = await loadEquipIndex()
    return (Array.isArray(index) ? index : []).map((entry) => ({
      ...entry,
      searchKeywords: buildSearchKeywords(entry)
    }))
  })()

  return equipIndexPromise
}

function scoreEquip(entry, keyword) {
  let best = 0
  const fullName = normalizeKeyword(entry.full_name)
  const name = normalizeKeyword(entry.name)

  if (fullName === keyword) {
    best = Math.max(best, 130)
  }
  if (name === keyword) {
    best = Math.max(best, 120)
  }

  for (const token of entry.searchKeywords ?? []) {
    if (!token) {
      continue
    }
    if (token === keyword) {
      best = Math.max(best, 115)
      continue
    }
    if (token.startsWith(keyword)) {
      best = Math.max(best, 85)
      continue
    }
    if (token.includes(keyword)) {
      best = Math.max(best, 60)
      continue
    }
    if (keyword.startsWith(token) && token.length > 1) {
      best = Math.max(best, 38)
    }
  }

  return best
}

function formatAlternatives(items) {
  return items.slice(0, 5).map((item) => item.entry.full_name || item.entry.name).filter(Boolean)
}

export async function findEquipFromCache(keyword) {
  const rawQuery = String(keyword ?? '').trim()
  const query = normalizeKeyword(rawQuery)
  if (!query) {
    throw new EquipLookupError('请输入要查询的装备名称。', 'invalid-query')
  }

  let equipIndex = []
  try {
    equipIndex = await getEquipIndex()
  } catch {
    throw new EquipLookupError('未检测到本地装备索引，请先执行 `pnpm run build:equip`。', 'index-missing')
  }

  if (!equipIndex.length) {
    throw new EquipLookupError('装备索引为空，请先执行 `pnpm run build:equip`。', 'index-empty')
  }

  const ranked = equipIndex
    .map((entry) => ({ entry, score: scoreEquip(entry, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score
      }
      return String(a.entry.full_name || a.entry.name).length - String(b.entry.full_name || b.entry.name).length
    })

  if (!ranked.length) {
    throw new EquipLookupError(`本地缓存里没有找到“${rawQuery}”对应的装备。`, 'not-found')
  }

  const best = ranked[0]
  const alternatives = formatAlternatives(ranked.slice(1))

  let equip
  try {
    equip = await readEquipData(best.entry.full_name)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new EquipLookupError(
        `本地还没有这条装备的属性缓存，请先执行 \`pnpm run build:equip -- --only=${best.entry.full_name}\`。`,
        'data-missing'
      )
    }

    throw error
  }

  return {
    equip,
    entry: best.entry,
    alternatives,
    cacheMeta: {
      file: path.relative(process.cwd(), getEquipDataFile(best.entry.full_name)).replace(/\\/g, '/'),
      generatedAt: equip.generated_at || ''
    }
  }
}

export async function hasEquipData(fullName) {
  try {
    await fs.access(getEquipDataFile(fullName))
    return true
  } catch {
    return false
  }
}
