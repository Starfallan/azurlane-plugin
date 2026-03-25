import { load } from 'cheerio'

const RARITY_STYLE_MAP = new Map([
  ['text-align:center;font-size:1.2em;background:#dbdcdf', '白色'],
  ['text-align:center;font-size:1.2em;background:#1bb7eb', '蓝色'],
  ['text-align:center;font-size:1.2em;background:#ae90ef', '紫色'],
  ['text-align:center;font-size:1.2em;background:#f9f593', '金色'],
  ['text-align:center;font-size:1.2em;background:linear-gradient(135deg,#59AE6A,#48AE96,#60D9EC,#65A5D5,#9491E0,#C382A4)', '彩色']
])

function cleanText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanMultilineText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function getMultilineText($cell) {
  const $clone = $cell.clone()
  $clone.find('br').replaceWith('\n')
  return cleanMultilineText($clone.text())
}

function absolutizeUrl(url) {
  if (!url) {
    return ''
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url
  }
  if (url.startsWith('//')) {
    return `https:${url}`
  }
  if (url.startsWith('/')) {
    return `https://wiki.biligame.com${url}`
  }
  return url
}

function normalizeWikiImageUrl(url) {
  const absoluteUrl = absolutizeUrl(url)
  if (!absoluteUrl) {
    return ''
  }

  try {
    const parsed = new URL(absoluteUrl)
    if (!parsed.pathname.includes('/thumb/')) {
      return parsed.toString()
    }

    parsed.pathname = parsed.pathname
      .replace('/thumb/', '/')
      .replace(/\/\d+px-[^/]+$/, '')
    return parsed.toString()
  } catch {
    return absoluteUrl
  }
}

function getDirectEquipUl($) {
  return $('div.equipRoot > ul.equip').first()
}

function parseEquipHeader($, $rootUl) {
  const items = $rootUl.children('li')
  const $titleLi = items.eq(0)
  const $summaryLi = items.eq(1)
  const $headerLink = $titleLi.find('a').first()
  const badgeList = $summaryLi.find('div').map((_, node) => cleanText($(node).text())).get().filter(Boolean)

  const fullName = cleanText($headerLink.attr('title')) || cleanText($summaryLi.find('a[title]').first().attr('title'))
  const displayName = cleanText($headerLink.text()) || fullName
  const tier = cleanText($summaryLi.find('b').last().text())
  const image = normalizeWikiImageUrl($summaryLi.find('img').first().attr('src'))
  const rarity = RARITY_STYLE_MAP.get(($titleLi.attr('style') ?? '').replace(/\s+/g, '')) ?? ''

  return {
    name: displayName,
    full_name: fullName,
    tier,
    image,
    badges: badgeList,
    equipment_type: badgeList[0] ?? '',
    equip_tag: badgeList[1] ?? '',
    rarity
  }
}

function parseTablePair($, $table) {
  const $row = $table.find('tr').first()
  const cells = $row.children('th,td')
  return {
    label: cleanText(cells.eq(0).text()),
    value: cleanMultilineText(cells.eq(1).text())
  }
}

function parseAttrNodes($, elements) {
  const nodes = []

  for (let index = 0; index < elements.length; index += 1) {
    const $li = $(elements[index])
    const $child = $li.children().first()

    if (!$child.length) {
      continue
    }

    if ($child.is('table')) {
      const node = {
        ...parseTablePair($, $child),
        children: []
      }

      const $nextLi = index + 1 < elements.length ? $(elements[index + 1]) : null
      const $nextChild = $nextLi?.children().first()
      if ($nextChild?.is('ul.equip')) {
        node.children = parseAttrNodes($, $nextChild.children('li').toArray())
        index += 1
      }

      nodes.push(node)
      continue
    }

    if ($child.is('ul.equip')) {
      nodes.push(...parseAttrNodes($, $child.children('li').toArray()))
    }
  }

  return nodes
}

function flattenAttrNodes(nodes, depth = 0) {
  const lines = []

  for (const node of nodes) {
    const prefix = depth > 0 ? '  '.repeat(depth) : ''
    lines.push(`${prefix}${node.label}:${node.value ?? ''}`.trimEnd())
    if (node.children?.length) {
      lines.push(...flattenAttrNodes(node.children, depth + 1))
    }
  }

  return lines
}

function parseApplicableShipTypes($, $rootUl) {
  const $lastLi = $rootUl.children('li').last()
  const shipNodes = []
  const useMap = {}

  $lastLi.find('div.appShipType').each((_, element) => {
    const $element = $(element)
    const classes = ($element.attr('class') ?? '').split(/\s+/).filter(Boolean)
    const roleClass = $element.find('sup').first().attr('class') ?? ''
    const role = roleClass === 'mainAppShipType'
      ? 'main'
      : roleClass === 'subAppShipType'
        ? 'sub'
        : 'normal'
    const enabled = !classes.includes('notAppShipType')
    const forbidden = classes.includes('forbiddenShipType')
    const rawText = cleanText($element.text())
    const name = rawText.replace(/^主/, '').replace(/^副/, '')

    shipNodes.push({
      name,
      raw_text: rawText,
      role,
      enabled,
      forbidden,
      class_list: classes
    })

    if (enabled) {
      useMap[name] = role === 'main' ? 1 : role === 'sub' ? 2 : 0
    }
  })

  return {
    applicable_ship_types: shipNodes,
    use_map: useMap
  }
}

function parseAcquisitionPanel($) {
  const $panel = $('div.col-md-6 div.panel.panel-default').first()
  const $table = $panel.find('table.table.table-bordered').first()
  const rows = []

  $table.find('tr').each((_, row) => {
    const $row = $(row)
    const label = cleanText($row.find('th').first().text())
    const $valueCell = $row.find('td').first()

    rows.push({
      label,
      value: getMultilineText($valueCell),
      html: ($valueCell.html() ?? '').trim()
    })
  })

  const acquisition = {
    full_equipment: rows.find((row) => row.label === '整装获取')?.value ?? '',
    research_route: rows.find((row) => row.label === '研发路线')?.value ?? '',
    blueprint: rows.find((row) => row.label === '图纸获取')?.value ?? '',
    research_route_items: [],
    rows,
    remark: '',
    demo_image: ''
  }

  const researchRouteRow = rows.find((row) => row.label === '研发路线')
  if (researchRouteRow?.html) {
    acquisition.research_route_items = parseResearchRouteHtml($, researchRouteRow.html)
    if (acquisition.research_route_items.length) {
      acquisition.research_route = acquisition.research_route_items
        .map((item) => {
          if (item.type === 'arrow') {
            return item.text
          }
          return item.full_name || item.display_name || ''
        })
        .filter(Boolean)
        .join(' ')
      researchRouteRow.value = acquisition.research_route
    }
  }

  const $remarkLabel = $panel.find('span.label.label-default').filter((_, node) => cleanText($(node).text()) === '备注').first()
  if ($remarkLabel.length) {
    const $remarkParagraph = $remarkLabel.parent()
    const $clone = $remarkParagraph.clone()
    $clone.find('span.label.label-default').remove()
    acquisition.remark = cleanMultilineText($clone.text())
  }

  acquisition.demo_image = absolutizeUrl($panel.find('a.image img').first().attr('src'))
  return acquisition
}

function normalizeEquipFullName(value) {
  const text = cleanText(value)
    .replace(/\.(jpg|jpeg|png|gif)$/i, '')
    .replace(/#(T\d+)$/i, '$1')
  return text
}

function deriveDisplayName(fullName) {
  return normalizeEquipFullName(fullName).replace(/T\d+$/i, '')
}

function parseResearchRouteEquipNode($, element) {
  const $element = $(element)
  const $img = $element.is('img') ? $element : $element.find('img').first()
  if (!$img.length) {
    return null
  }

  const $anchor = $element.is('a')
    ? $element
    : $element.find('a[title]').first().length
      ? $element.find('a[title]').first()
      : $img.closest('a[title]')

  const anchorTitle = cleanText($anchor.attr('title'))
  const alt = cleanText($img.attr('alt'))
  const fullName = normalizeEquipFullName(anchorTitle || alt)
  if (!fullName) {
    return null
  }

  return {
    type: 'equip',
    full_name: fullName,
    display_name: deriveDisplayName(fullName),
    wiki_url: absolutizeUrl($anchor.attr('href')),
    image: normalizeWikiImageUrl($img.attr('src')),
    original_image: absolutizeUrl($img.attr('src'))
  }
}

function parseResearchRouteHtml($, html) {
  const $wrapper = load(`<div id="research-route-root">${html}</div>`, null, false)
  const items = []

  $wrapper('#research-route-root').contents().each((_, node) => {
    if (node.type === 'text') {
      const text = cleanText(node.data)
      if (!text) {
        return
      }
      if (text.includes('查看消耗')) {
        return
      }
      if (text.includes('->') || text.includes('→')) {
        items.push({
          type: 'arrow',
          text: '->'
        })
      }
      return
    }

    if (node.type !== 'tag') {
      return
    }

    const tagName = node.tagName?.toLowerCase()
    const $node = $wrapper(node)

    if (tagName === 'br') {
      return
    }

    if (tagName === 'a' && cleanText($node.text()).includes('查看消耗')) {
      return
    }

    if (tagName === 'span' && $node.hasClass('xtb-image')) {
      const equipItem = parseResearchRouteEquipNode($wrapper, node)
      if (equipItem) {
        items.push(equipItem)
      }
      return
    }

    if (tagName === 'img') {
      const equipItem = parseResearchRouteEquipNode($wrapper, node)
      if (equipItem) {
        items.push(equipItem)
      }
      return
    }
  })

  return items
}

function parseSourceInfo($, htmlPath, basicMeta) {
  const title = cleanText($('title').text()).replace(/\s*-\s*碧蓝航线WIKI_BWIKI_哔哩哔哩$/, '')
  const pageUrl = absolutizeUrl($('meta[property="og:url"]').attr('content'))

  return {
    title,
    html_file: htmlPath,
    wiki_url: basicMeta?.wiki_url ?? (basicMeta?.tier ? `${pageUrl}#${basicMeta.tier}` : pageUrl),
    page_url: pageUrl
  }
}

export function parseEquipHtml(html, options = {}) {
  const { htmlPath = '', basicMeta = null } = options
  const $ = load(html)
  const $rootUl = getDirectEquipUl($)

  if (!$rootUl.length) {
    throw new Error('未找到装备主结构 `div.equipRoot > ul.equip`。')
  }

  const header = parseEquipHeader($, $rootUl)
  const $items = $rootUl.children('li')
  const attrNodes = parseAttrNodes($, $items.slice(2, -1).toArray())
  const { applicable_ship_types, use_map } = parseApplicableShipTypes($, $rootUl)
  const acquisition = parseAcquisitionPanel($)
  const source = parseSourceInfo($, htmlPath, basicMeta)

  return {
    version: 1,
    source: {
      type: 'local_html',
      ...source
    },
    name: basicMeta?.name ?? header.name,
    full_name: basicMeta?.full_name ?? header.full_name,
    tier: basicMeta?.tier ?? header.tier,
    wiki_url: source.wiki_url,
    page_url: source.page_url,
    page_title: source.title,
    equipment_type: basicMeta?.equipment_type ?? header.equipment_type,
    faction: basicMeta?.faction ?? '',
    rarity: basicMeta?.rarity ?? header.rarity,
    ship_types: basicMeta?.ship_types ?? [],
    image: header.image,
    badges: header.badges,
    equip_tag: header.equip_tag,
    attr_nodes: attrNodes,
    attr_text: flattenAttrNodes(attrNodes).join('\n'),
    applicable_ship_types,
    use_map,
    acquisition
  }
}
