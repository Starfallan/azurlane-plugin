import { resolvePreferredShipAssetSrc, resolveShipAssetSrc } from './ship-card-data.js'

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function cleanLines(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function cleanMultilineText(value) {
  if (value == null) {
    return ''
  }

  const normalized = String(value).replace(/\r/g, '')
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.join('\n')
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function toMultilineHtml(value) {
  if (!value) {
    return ''
  }

  return escapeHtml(value).replace(/\n/g, '<br />')
}

function resolveRouteEquipImage(item) {
  const fullName = cleanText(item?.full_name)
  const candidates = []

  if (item?.local_image) {
    candidates.push(item.local_image)
  }

  if (fullName) {
    for (const ext of ['.jpg', '.png', '.jpeg', '.webp', '.gif']) {
      candidates.push(`resources/equip/${fullName}/img/${fullName}${ext}`)
    }
  }

  for (const candidate of candidates) {
    const src = resolvePreferredShipAssetSrc(candidate, '')
    if (src) {
      return src
    }
  }

  return resolveShipAssetSrc(item?.image || item?.remote_image || '')
}

function buildResearchRouteItems(acquisition) {
  const rawItems = Array.isArray(acquisition?.research_route_items) ? acquisition.research_route_items : []
  return rawItems
    .map((item) => {
      const type = cleanText(item?.type)
      if (type === 'arrow') {
        return {
          type: 'arrow',
          text: cleanText(item?.text) || '->'
        }
      }

      if (type === 'equip') {
        return {
          type: 'equip',
          full_name: cleanText(item?.full_name),
          display_name: cleanText(item?.display_name || item?.full_name || '未知装备'),
          image_src: resolveRouteEquipImage(item)
        }
      }

      return null
    })
    .filter(Boolean)
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

function flattenAttrNodes(nodes, depth = 0, rows = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const label = cleanText(node?.label)
    const value = cleanText(node?.value)
    const children = Array.isArray(node?.children) ? node.children : []

    if (!label && !value && !children.length) {
      continue
    }

    if (depth === 0) {
      rows.push({
        kind: 'section',
        label: label || '未命名分组',
        value,
        has_value: Boolean(value)
      })
    } else {
      rows.push({
        kind: 'item',
        label: label || '-',
        value: value || '-',
        depth,
        indent_px: 12 + (depth - 1) * 18
      })
    }

    if (children.length) {
      flattenAttrNodes(children, depth + 1, rows)
    }
  }

  return rows
}

function buildAcquisitionRows(acquisition) {
  const researchRouteItems = buildResearchRouteItems(acquisition)
  const rows = Array.isArray(acquisition?.rows) ? acquisition.rows : []
  return rows
    .map((item) => {
      const label = cleanText(item?.label)
      const value = cleanMultilineText(item?.value)
      const isRoute = label === '研发路线'

      return {
        label,
        value,
        value_html: toMultilineHtml(value),
        multiline: value.includes('\n'),
        is_research_route: isRoute,
        route_items: isRoute ? researchRouteItems : []
      }
    })
    .filter((item) => item.label || item.value)
}

function buildShipTypeChips(equip, entry) {
  const parsed = Array.isArray(equip?.applicable_ship_types) ? equip.applicable_ship_types : []
  if (parsed.length) {
    return parsed.map((item) => ({
      name: cleanText(item?.name) || '-',
      enabled: Boolean(item?.enabled),
      forbidden: Boolean(item?.forbidden),
      role: cleanText(item?.role) || 'normal'
    }))
  }

  return (Array.isArray(entry?.ship_types) ? entry.ship_types : []).map((name) => ({
    name: cleanText(name),
    enabled: true,
    forbidden: false,
    role: 'normal'
  }))
}

function buildBadgeList(equip, entry) {
  const result = []
  if (equip?.equipment_type || entry?.equipment_type) {
    result.push(cleanText(equip?.equipment_type || entry?.equipment_type))
  }
  if (equip?.tier || entry?.tier) {
    result.push(cleanText(equip?.tier || entry?.tier))
  }
  if (equip?.rarity || entry?.rarity) {
    result.push(cleanText(equip?.rarity || entry?.rarity))
  }
  if (equip?.faction || entry?.faction) {
    result.push(cleanText(equip?.faction || entry?.faction))
  }
  return result.filter(Boolean)
}

export function buildEquipCardViewModel({ equip, entry = {}, keyword = '', alternatives = [] }) {
  const attrRows = flattenAttrNodes(equip?.attr_nodes ?? [])
  const acquisitionRows = buildAcquisitionRows(equip?.acquisition)
  const shipTypeChips = buildShipTypeChips(equip, entry)
  const badgeList = buildBadgeList(equip, entry)
  const enabledShipTypes = shipTypeChips.filter((item) => item.enabled && !item.forbidden)

  const equipName = cleanText(equip?.name || entry?.name || equip?.page_title || '') || '未知装备'
  const tier = cleanText(equip?.tier || entry?.tier)
  const fullName = cleanText(equip?.full_name || entry?.full_name || equipName)
  const rarity = cleanText(equip?.rarity || entry?.rarity) || '未知'
  const title = tier ? `${equipName} ${tier} · 装备属性` : `${equipName} · 装备属性`

  return {
    ...equip,
    title,
    keyword,
    alternatives,
    equip_name: equipName,
    full_name: fullName,
    tier,
    rarity,
    rarity_class: rarity.replace(/\s+/g, ''),
    equipment_type: cleanText(equip?.equipment_type || entry?.equipment_type),
    faction: cleanText(equip?.faction || entry?.faction),
    ship_types: enabledShipTypes.map((item) => item.name),
    ship_types_display: enabledShipTypes.map((item) => item.name).join(' / '),
    image_src: resolvePreferredShipAssetSrc(equip?.local_image, equip?.image),
    source_page_url: cleanText(equip?.page_url || equip?.source?.page_url || entry?.wiki_url),
    source_wiki_url: cleanText(equip?.wiki_url || entry?.wiki_url),
    generated_at_display: formatDateTime(equip?.generated_at),
    attr_rows: attrRows,
    acquisition_rows: acquisitionRows,
    acquisition_remark: cleanText(equip?.acquisition?.remark),
    acquisition_demo_image: resolveShipAssetSrc(equip?.acquisition?.demo_image),
    ship_type_chips: shipTypeChips,
    badge_list: badgeList,
    has_attr_rows: attrRows.length > 0,
    has_acquisition_rows: acquisitionRows.length > 0,
    has_ship_type_chips: shipTypeChips.length > 0,
    has_demo_image: Boolean(equip?.acquisition?.demo_image),
    generated_source: cleanText(equip?.source?.type === 'local_html' ? '本地HTML' : '远程页面') || '本地缓存',
    updated_hint: formatDateTime(equip?.generated_at) || '',
    attr_text_lines: cleanLines(equip?.attr_text)
  }
}
