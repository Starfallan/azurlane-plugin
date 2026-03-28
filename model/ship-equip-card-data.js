import { resolvePreferredShipAssetSrc, resolveShipAssetSrc } from './ship-card-data.js'

const HEADER_COLOR_FALLBACKS = ['#F18080', '#F18080', '#F18080', '#FFB700', '#FFB700', '#F18080', '#F18080']
const assetSrcCache = new Map()

function resolveAsset(assetPath) {
  if (!assetPath) {
    return ''
  }

  const key = String(assetPath)
  if (assetSrcCache.has(key)) {
    return assetSrcCache.get(key)
  }

  const src = resolveShipAssetSrc(key)
  assetSrcCache.set(key, src)
  return src
}

function cleanLines(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function normalizeColor(value) {
  const raw = String(value ?? '').trim()
  if (!raw || raw === '#') {
    return ''
  }

  if (/^#[0-9a-f]{3}$/i.test(raw) || /^#[0-9a-f]{6}$/i.test(raw)) {
    return raw.toUpperCase()
  }

  return raw
}

function parseHexColor(value) {
  const normalized = normalizeColor(value)
  if (!/^#[0-9a-f]{3}$/i.test(normalized) && !/^#[0-9a-f]{6}$/i.test(normalized)) {
    return null
  }

  const hex = normalized.slice(1)
  if (hex.length === 3) {
    return hex.split('').map((char) => Number.parseInt(char.repeat(2), 16))
  }

  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16)
  ]
}

function rgbaFromHex(value, alpha, fallback) {
  const rgb = parseHexColor(value)
  if (!rgb) {
    return fallback
  }

  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

function isLightColor(value) {
  const rgb = parseHexColor(value)
  if (!rgb) {
    return false
  }

  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })

  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance >= 0.44
}

function pad(number) {
  return String(number).padStart(2, '0')
}

function formatDateTime(value) {
  if (!value) {
    return ''
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function buildTagChips(ship, equip) {
  const chips = [
    ship.rarity || '未知稀有度',
    ship.type || '未知舰种',
    ship.camp || '未知阵营'
  ]

  if ((equip.special_recommendations?.length ?? 0) > 0) {
    chips.push('含特殊推荐')
  }

  return chips
}

function buildShipMeta(ship, equip) {
  const sourceLabel = equip.source?.type === 'local_html' ? '本地 HTML' : '在线 Wiki'

  return [
    { label: '舰船编号', value: ship.ship_id || ship.id || equip.ship_id || 'N/A' },
    { label: '舰种', value: ship.type || '未知' },
    { label: '阵营', value: ship.camp || '未知' },
    { label: '实装日期', value: ship.release_date || equip.release_date || '未知' },
    { label: '配装来源', value: sourceLabel },
    { label: '配装更新', value: formatDateTime(equip.generated_at) || '本地缓存' }
  ]
}

function buildSlotCards(ship) {
  return (ship.equipments ?? []).map((item) => {
    const parts = [
      item.efficiency ? `效率 ${item.efficiency}` : '',
      item.count ? `${item.count}座` : '',
      item.prefill ? `预装${item.prefill}` : ''
    ].filter(Boolean)

    return {
      ...item,
      detail: parts.join(' · ')
    }
  })
}

function buildSummaryMetrics(ship, equip, columnCount, rowCount) {
  return [
    { label: '特殊推荐', value: String(equip.special_recommendations?.length ?? 0) },
    { label: '通用列数', value: String(columnCount) },
    { label: '推荐行数', value: String(rowCount) },
    { label: '舰船槽位', value: String(ship.equipments?.length ?? 0) }
  ]
}

function buildEquipRef(ref) {
  return {
    ...ref,
    display_name: ref.name || ref.full_name || '未命名装备',
    image_src: resolvePreferredShipAssetSrc(ref.local_image, ref.wiki_icon)
  }
}

function buildColumn(column, index, ship) {
  const fallbackTitle = ship.equipments?.[index]?.name || `推荐${index + 1}`
  const background = normalizeColor(column?.background) || HEADER_COLOR_FALLBACKS[index % HEADER_COLOR_FALLBACKS.length]
  const light = isLightColor(background)

  return {
    index,
    title: String(column?.title ?? fallbackTitle).trim() || fallbackTitle,
    background_display: background,
    text_color: light ? '#4A2100' : '#FFF8ED',
    border_color: rgbaFromHex(background, 0.55, 'rgba(255, 255, 255, 0.2)'),
    is_light: light
  }
}

function buildCell(cell, rowIndex) {
  if (!cell) {
    return null
  }

  const normalizedBackground = normalizeColor(cell.background)
  const background = cell.warning
    ? (normalizedBackground || '#FFE8E2')
    : (normalizedBackground || (rowIndex % 2 === 0 ? '#FFFFFF' : '#F3F6FB'))
  const light = isLightColor(background) || !normalizedBackground
  const tone = cell.warning ? 'warning' : (light ? 'light' : 'dark')
  const textLines = cleanLines(cell.text)
  const equipRefs = (cell.equip_refs ?? []).map(buildEquipRef)

  return {
    ...cell,
    tone,
    is_light: light,
    background_display: background,
    text_color: cell.warning ? '#681A15' : (light ? '#233047' : '#F3F7FF'),
    border_color: cell.warning
      ? 'rgba(225, 67, 67, 0.42)'
      : rgbaFromHex(background, light ? 0.36 : 0.5, 'rgba(120, 145, 185, 0.28)'),
    shadow_color: cell.warning
      ? 'rgba(225, 67, 67, 0.12)'
      : (light ? 'rgba(101, 133, 185, 0.12)' : 'rgba(58, 120, 220, 0.18)'),
    text_lines: textLines.length ? textLines : ['暂无说明'],
    equip_refs: equipRefs,
    has_equips: equipRefs.length > 0
  }
}

function buildGeneralRecommendation(ship, equip) {
  const rawColumns = Array.isArray(equip.general_recommendation?.columns)
    ? equip.general_recommendation.columns
    : []
  const rawRows = Array.isArray(equip.general_recommendation?.rows)
    ? equip.general_recommendation.rows
    : []
  const columnCount = Math.max(
    rawColumns.length,
    ...rawRows.map((row) => Array.isArray(row?.cells) ? row.cells.length : 0),
    0
  )

  const columns = Array.from({ length: columnCount }, (_, index) => buildColumn(rawColumns[index], index, ship))
  const rows = rawRows.map((row, rowIndex) => ({
    index: typeof row?.index === 'number' ? row.index : rowIndex,
    cells: Array.from({ length: columnCount }, (_, columnIndex) => buildCell(row?.cells?.[columnIndex], rowIndex))
  }))

  return {
    title: String(equip.general_recommendation?.title || '通用配装').trim() || '通用配装',
    description: String(equip.general_recommendation?.description || '').trim(),
    description_lines: cleanLines(equip.general_recommendation?.description),
    columns,
    rows
  }
}

function buildSpecialRecommendations(equip) {
  return (equip.special_recommendations ?? []).map((item, index) => ({
    ...item,
    index: item.index || index + 1,
    title: String(item.title || `特殊推荐配装${index + 1}`).trim() || `特殊推荐配装${index + 1}`,
    recommender: String(item.recommender || '').trim(),
    reason_lines: cleanLines(item.reason_text)
  }))
}

function buildRecommenderSummary(items) {
  const names = Array.from(new Set(items.map((item) => item.recommender).filter(Boolean)))
  if (!names.length) {
    return ''
  }

  return names.slice(0, 3).join(' / ')
}

export function buildShipEquipCardViewModel({ ship, equip, keyword = '', alternatives = [], cacheMeta = {} }) {
  const specialRecommendations = buildSpecialRecommendations(equip)
  const generalRecommendation = buildGeneralRecommendation(ship, equip)
  const shipName = ship.name || equip.ship_name || equip.page_title || '未知舰船'

  return {
    ...ship,
    ...equip,
    title: `${shipName} · 配装推荐`,
    keyword,
    alternatives,
    cacheMeta,
    ship_name: shipName,
    portrait_image: resolvePreferredShipAssetSrc(ship.image, ship.wiki_image),
    rarity_background: ship.rarity ? resolveAsset(`resources/common/img/rarity/bg_${ship.rarity}.avif`) : '',
    camp_icon: ship.camp ? resolveAsset(`resources/common/img/camp/${ship.camp}.png`) : '',
    tag_chips: buildTagChips(ship, equip),
    ship_meta: buildShipMeta(ship, equip),
    slot_cards: buildSlotCards(ship),
    summary_metrics: buildSummaryMetrics(ship, equip, generalRecommendation.columns.length, generalRecommendation.rows.length),
    special_recommendations: specialRecommendations,
    has_special_recommendations: specialRecommendations.length > 0,
    recommender_summary: buildRecommenderSummary(specialRecommendations),
    general_recommendation: generalRecommendation,
    has_general_recommendation: generalRecommendation.columns.length > 0 && generalRecommendation.rows.length > 0,
    generated_at_display: formatDateTime(equip.generated_at),
    cache_generated_at_display: formatDateTime(cacheMeta.generatedAt),
    page_url: equip.source?.page_url || ship.pageUrl || ''
  }
}
