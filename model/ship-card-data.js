import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function hasResolvableAsset(assetPath) {
  if (!assetPath) {
    return false
  }

  const value = String(assetPath).trim()
  if (!value) {
    return false
  }

  if (/^(https?:|file:)/i.test(value)) {
    return true
  }

  return fs.existsSync(path.resolve(PLUGIN_ROOT, value))
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.avif':
      return 'image/avif'
    case '.webp':
      return 'image/webp'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    default:
      return 'application/octet-stream'
  }
}

export function resolveShipAssetSrc(assetPath) {
  if (!assetPath) {
    return ''
  }

  const value = String(assetPath).trim()
  if (!value) {
    return ''
  }

  if (/^(https?:|file:)/i.test(value)) {
    return value
  }

  const absolutePath = path.resolve(PLUGIN_ROOT, value)

  try {
    const buffer = fs.readFileSync(absolutePath)
    const mimeType = getMimeType(absolutePath)
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  } catch {
    return pathToFileURL(absolutePath).href
  }
}

export function resolvePreferredShipAssetSrc(primaryAssetPath, fallbackAssetPath = '') {
  if (hasResolvableAsset(primaryAssetPath)) {
    return resolveShipAssetSrc(primaryAssetPath)
  }

  if (fallbackAssetPath && hasResolvableAsset(fallbackAssetPath)) {
    return resolveShipAssetSrc(fallbackAssetPath)
  }

  return ''
}

function modeLabel(mode) {
  return mode === 'skill' ? '技能档案' : '舰船资料'
}

function normalizeSkillList(skills = []) {
  return skills.map((skill) => ({
    ...skill,
    icon_src: resolveShipAssetSrc(skill.icon)
  }))
}

function buildProfileRows(ship) {
  return [
    { label: '舰船编号', en: 'ID', value: ship.ship_id || ship.id || 'N/A' },
    { label: '舰种', en: 'TYPE', value: ship.type || '未知' },
    { label: '阵营', en: 'CAMP', value: ship.camp || '未知' },
    { label: '建造时间', en: 'BUILD', value: ship.time || '暂无数据' },
    { label: '实装日期', en: 'RELEASE', value: ship.release_date || '未知' },
    { label: '声优', en: 'CV', value: ship.cv || '暂无数据' }
  ]
}

function buildMetaChips(ship) {
  const chips = [
    ship.rarity || '未知稀有度',
    ship.camp || '未知阵营',
    ship.type || '未知舰种'
  ]

  if (ship.canUpgrade) {
    chips.push('改造开放')
  }

  return chips
}

function resolveRarityBackground(rarity) {
  if (!rarity) {
    return ''
  }
  return resolveShipAssetSrc(`resources/common/img/rarity/bg_${rarity}.avif`)
}

function resolveCampIcon(camp) {
  if (!camp) {
    return ''
  }
  return resolveShipAssetSrc(`resources/common/img/camp/${camp}.png`)
}

export function buildShipCardViewModel({ ship, mode = 'ship', keyword = '', alternatives = [], cacheMeta = {} }) {
  const normalSkills = normalizeSkillList(ship.skills_normal || ship.skills || [])
  const retrofitSkills = normalizeSkillList(ship.skills_retrofit || [])

  return {
    ...ship,
    keyword,
    alternatives,
    cacheMeta,
    mode,
    modeLabel: modeLabel(mode),
    title: `${ship.name} · ${modeLabel(mode)}`,
    portrait_image: resolvePreferredShipAssetSrc(ship.image, ship.wiki_image),
    wiki_image_src: resolveShipAssetSrc(ship.wiki_image),
    rarity_background: resolveRarityBackground(ship.rarity),
    camp_icon: resolveCampIcon(ship.camp),
    profile_rows: buildProfileRows(ship),
    meta_chips: buildMetaChips(ship),
    skills: normalSkills,
    skills_normal: normalSkills,
    skills_retrofit: retrofitSkills,
    normal_skills: normalSkills,
    retrofit_skills: retrofitSkills,
    has_retrofit_skills: retrofitSkills.length > 0,
    has_retrofit_panel: ship.retrofit?.hasData || retrofitSkills.length > 0,
    retrofit_rows: ship.retrofit?.rows || [],
    retrofit_total: ship.retrofit?.total || '',
    source_cards: ship.sources || [],
    fleet_tech_rows: ship.fleetTech?.rows || [],
    has_fleet_tech: Boolean(ship.fleetTech?.hasData),
    has_alternatives: Array.isArray(alternatives) && alternatives.length > 0
  }
}
