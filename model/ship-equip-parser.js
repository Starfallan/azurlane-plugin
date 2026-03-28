import { load } from 'cheerio'

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

function normalizeEquipFullName(raw) {
  return cleanText(raw)
    .replace(/\.(jpg|jpeg|png|gif)$/i, '')
    .replace(/#(T\d+)$/i, '$1')
}

function deriveEquipDisplayName(fullName) {
  return normalizeEquipFullName(fullName).replace(/T\d+$/i, '')
}

function extractBackground(styleValue = '') {
  const match = String(styleValue).match(/background\s*:\s*([^;]+)/i)
  return match ? match[1].trim() : ''
}

function parseEquipRefs($, $cell) {
  const refs = []
  const seen = new Set()

  $cell.find('.equipcell a, .equipcell img').each((_, node) => {
    const $node = $(node)
    const $anchor = $node.is('a') ? $node : $node.closest('a')
    const $img = $node.is('img') ? $node : $node.find('img').first()
    const anchorTitle = cleanText($anchor.attr('title'))
    const alt = cleanText($img.attr('alt'))
    const fullName = normalizeEquipFullName(anchorTitle || alt)

    if (!fullName || seen.has(fullName)) {
      return
    }

    seen.add(fullName)
    refs.push({
      full_name: fullName,
      name: deriveEquipDisplayName(fullName),
      wiki_url: absolutizeUrl($anchor.attr('href')),
      wiki_icon: absolutizeUrl($img.attr('src'))
    })
  })

  return refs
}

function parseSpecialRecommendations($, $panelBody) {
  const result = []

  $panelBody.children('div[class^="pverecommend"]').each((_, block) => {
    const $block = $(block)
    const $table = $block.find('table').first()
    const rows = $table.find('tr')
    const titleText = cleanText(rows.eq(0).find('th').first().text())
    const indexMatch = titleText.match(/特殊推荐配装(\d+)/)
    const recommender = cleanText(rows.eq(0).find('td').last().text())
    const reasonCell = rows.eq(1).find('td').first()

    result.push({
      index: indexMatch ? Number(indexMatch[1]) : result.length + 1,
      title: titleText || `特殊推荐配装${result.length + 1}`,
      recommender,
      reason_text: cleanMultilineText(reasonCell.text()),
      reason_html: (reasonCell.html() ?? '').trim()
    })
  })

  return result
}

function parseGeneralRecommendation($, $panelBody) {
  const $row = $panelBody.find('div.row').first()
  const $columns = $row.children('div[class*="col-"]')
  const columns = []

  $columns.each((columnIndex, column) => {
    const $column = $(column)
    const $table = $column.find('table.equiptable').first()
    const titleCell = $table.find('tr').first().find('th').first()
    const rows = []

    $table.find('tr').slice(1).each((_, row) => {
      const $rowCell = $(row).find('td').first()
      if (!$rowCell.length) {
        return
      }

      rows.push({
        background: extractBackground($rowCell.attr('style')),
        warning: $rowCell.find('[style*="color:red"], font[color="red"]').length > 0,
        text: cleanMultilineText($rowCell.find('.equiptext').text() || $rowCell.text()),
        html: ($rowCell.html() ?? '').trim(),
        equip_refs: parseEquipRefs($, $rowCell)
      })
    })

    columns.push({
      index: columnIndex,
      title: cleanText(titleCell.text()),
      background: extractBackground(titleCell.attr('style')),
      rows
    })
  })

  const rowCount = Math.max(...columns.map((column) => column.rows.length), 0)
  const mergedRows = []
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    mergedRows.push({
      index: rowIndex,
      cells: columns.map((column) => column.rows[rowIndex] ?? null)
    })
  }

  let title = ''
  let description = ''
  const generalMarker = $panelBody.find('b').filter((_, node) => cleanText($(node).text()) === '通用配装').first()
  if (generalMarker.length) {
    title = cleanText(generalMarker.text())
    const $desc = generalMarker.nextAll('span').first()
    description = cleanMultilineText($desc.text())
  }

  return {
    title: title || '通用配装',
    description,
    columns,
    rows: mergedRows
  }
}

export function parseShipEquipHtml(html, options = {}) {
  const { pageUrl = '', sourceFile = '' } = options
  const $ = load(html)
  const $panelBody = $('div#mc_collapse-pztj').first()

  if (!$panelBody.length) {
    return {
      has_data: false,
      special_recommendations: [],
      general_recommendation: {
        title: '',
        description: '',
        columns: [],
        rows: []
      }
    }
  }

  const pageTitle = cleanText($('#firstHeading').text()) || cleanText($('title').text()).replace(/\s*-\s*碧蓝航线WIKI_BWIKI_哔哩哔哩$/, '')

  return {
    version: 1,
    source: {
      type: sourceFile ? 'local_html' : 'remote_html',
      page_url: pageUrl,
      source_file: sourceFile
    },
    page_title: pageTitle,
    has_data: true,
    special_recommendations: parseSpecialRecommendations($, $panelBody),
    general_recommendation: parseGeneralRecommendation($, $panelBody)
  }
}
