import { load } from 'cheerio'

const SPECIAL_CAMPS = new Set([
  '白鹰',
  '皇家',
  '重樱',
  '铁血',
  '东煌',
  '哔哩哔哩',
  '撒丁帝国',
  '北方联合',
  '自由鸢尾',
  '维希教廷'
])

const STAT_LABELS = [
  ['耐久', 'naijiu'],
  ['装甲', 'zhuangjia'],
  ['装填', 'zhuangtian'],
  ['炮击', 'paoji'],
  ['雷击', 'leiji'],
  ['机动', 'jidong'],
  ['防空', 'fangkong'],
  ['航空', 'hangkong'],
  ['命中', 'mingzhong'],
  ['反潜', 'fanqian'],
  ['幸运', 'xingyun'],
  ['航速', 'hangsu'],
  ['氧气', 'yangqi'],
  ['弹药量', 'danyao'],
  ['消耗', 'xiaohao']
]

const STAT_LABEL_TO_KEY = new Map(STAT_LABELS)

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

function getDisplayText($cell) {
  const tjmode1 = cleanText($cell.find('span.tjmode1').first().text())
  if (tjmode1) {
    const content = tjmode1.split('→').at(-1)?.trim()
    if (content && !content.startsWith('{')) {
      return content
    }
  }

  const tjmode0 = cleanText($cell.find('span.tjmode0').first().text())
  if (tjmode0) {
    return tjmode0.split('→').at(-1)?.trim() ?? ''
  }

  return cleanText($cell.text()).split('→').at(-1)?.trim() ?? ''
}

function parseGeneralInfo($) {
  const rows = $('table.wikitable.sv-general').first().find('tr')
  const nameBlocks = rows.eq(0).find('b').map((_, node) => cleanText($(node).text())).get().filter(Boolean)
  const type = cleanText($('#PNshiptype').first().text()) || cleanText(rows.eq(1).find('td').eq(1).text())
  const rarity = cleanText(rows.eq(2).find('#PNrarity').first().text())
  const camp = cleanText(rows.eq(2).find('td').eq(3).text())

  let active = ''
  let time = ''
  let normalFrom = ''
  let activeFrom = ''
  let fileFrom = ''
  let otherFrom = ''

  rows.slice(3).each((_, row) => {
    const columns = $(row).find('td')
    const label = cleanText(columns.eq(0).text())
    const value = getMultilineText(columns.eq(1))

    if (label.includes('建造时间')) {
      time = value
    } else if (label.includes('普通掉落点')) {
      normalFrom = value
    } else if (label.includes('活动 掉落点')) {
      activeFrom = value
    } else if (label.includes('档案掉落点')) {
      fileFrom = value
    } else if (label.includes('相关活动')) {
      active = value
    } else if (label.includes('其他途径')) {
      otherFrom = value
    }
  })

  const canUpgrade = $('span#改造详情').length > 0

  let index = 0
  if (SPECIAL_CAMPS.has(camp) && !nameBlocks[0]?.includes('μ')) {
    index += 1
  }

  let name = nameBlocks[index] ?? cleanText($('#firstHeading').text())
  if (canUpgrade) {
    name += '.改'
  }
  index += 1

  if (index < nameBlocks.length - 2) {
    name += (nameBlocks[index] ?? '').replace('·META', '')
    index += 1
  }

  let code = nameBlocks[index] ?? nameBlocks.at(-1) ?? name
  if (name === 'HMS Little Cheshire') {
    name = '小柴郡'
    code = 'HMS Little Cheshire'
  }

  const picBlocks = $('div.Contentbox2').first().find('div')
  const image = canUpgrade
    ? absolutizeUrl(picBlocks.eq(Math.max(picBlocks.length - 2, 0)).find('img').first().attr('src'))
    : absolutizeUrl(picBlocks.eq(0).find('img').first().attr('src'))

  const sources = [
    normalFrom ? { label: '普通掉落点', value: normalFrom } : null,
    activeFrom ? { label: '活动掉落点', value: activeFrom } : null,
    fileFrom ? { label: '档案掉落点', value: fileFrom } : null,
    otherFrom ? { label: '其他途径', value: otherFrom } : null
  ].filter(Boolean)

  return {
    name,
    code,
    type,
    rarity,
    camp: camp || '余烬',
    active,
    time: time.replace('活动', active ? `${active}活动` : '活动'),
    image,
    canUpgrade,
    sources,
    normalFrom,
    activeFrom,
    fileFrom,
    otherFrom
  }
}

function parseStats($) {
  const tableRows = $('table.wikitable.sv-performance').eq(1).children().first().children()
  const flattenedCells = []
  const stats = []
  const statFields = Object.fromEntries(STAT_LABELS.map(([, key]) => [key, '']))

  const maxRowIndex = Math.min(7, tableRows.length - 1)
  for (let rowIndex = 1; rowIndex <= maxRowIndex; rowIndex += 1) {
    tableRows.eq(rowIndex).children().each((_, cell) => {
      flattenedCells.push($(cell))
    })
  }

  for (let index = 0; index < flattenedCells.length; index += 1) {
    const label = cleanText(flattenedCells[index].text())
    const key = STAT_LABEL_TO_KEY.get(label)
    if (!key || index + 1 >= flattenedCells.length) {
      continue
    }

    const value = getDisplayText(flattenedCells[index + 1])
    if (!value) {
      continue
    }

    statFields[key] = value
    stats.push({
      key,
      label,
      value
    })
  }

  return {
    stats,
    statFields
  }
}

function parseSkills($) {
  const rows = $('table.wikitable.sv-skill').first().find('tr')
  const normalSkills = []
  const retrofitSkills = []

  rows.each((_, row) => {
    const $row = $(row)
    const style = $row.attr('style') ?? ''
    const className = $row.attr('class') ?? ''
    if (className.includes('tjmode2')) {
      return
    }

    const cells = $row.find('td')
    if (cells.length < 2) {
      return
    }

    // Ignore placeholder/template rows that are hidden and have no rendered content.
    if (style.includes('display:none') && !className.includes('tjmode1')) {
      return
    }

    let detail = getMultilineText(cells.eq(1))
    const tabContents = cells.eq(1).find('div.resp-tab-content')
    if (tabContents.length >= 2) {
      detail = getMultilineText(tabContents.eq(0))
    }

    let name = cleanText(cells.eq(0).text())
    if (detail.includes('（天运拟合')) {
      name += '+'
      detail = detail.split('+：').at(-1)?.trim() ?? detail
    }

    const skill = {
      name,
      icon: absolutizeUrl(cells.eq(0).find('img').attr('src')),
      detail
    }

    if (className.includes('tjmode1')) {
      retrofitSkills.push(skill)
      return
    }

    normalSkills.push(skill)
  })

  return {
    normalSkills,
    retrofitSkills
  }
}

function parseEquipments($, canUpgrade) {
  const rows = $('table.wikitable.sv-equipment').first().find('tr')
  const equipments = []

  for (let index = 2; index <= 4; index += 1) {
    const row = rows.eq(index + (canUpgrade ? 1 : 0))
    const cells = row.find('td')
    if (cells.length < 5) {
      continue
    }

    equipments.push({
      slot: cleanText(cells.eq(0).text()),
      name: cleanText(cells.eq(1).find('span.tjmode1').text()),
      efficiency: cleanText(cells.eq(2).find('span.tjmode1').text()),
      count: cleanText(cells.eq(3).find('span.tjmode1').text()),
      prefill: cleanText(cells.eq(4).find('span.tjmode1').text())
    })
  }

  return equipments
}

function normalizeTechPoint(text) {
  return cleanText(text).replace(/\+\s+/g, '+')
}

function parseFleetTech($) {
  const $table = $('table.wikitable.sv-category').filter((_, table) => {
    return cleanText($(table).find('tr').first().text()).includes('舰队科技')
  }).first()

  if (!$table.length) {
    return {
      hasData: false,
      total: '',
      rows: []
    }
  }

  const rows = $table.find('tr')
  const totalCell = $table.find('td[rowspan]').filter((_, cell) => {
    return cleanMultilineText($(cell).text()).includes('合计')
  }).first()
  const totalText = totalCell.length ? getMultilineText(totalCell) : ''
  const totalLines = totalText.split('\n').filter(Boolean)
  const total = totalLines.length > 1
    ? totalLines.at(-1) ?? ''
    : totalText.replace(/^合计/, '').trim()
  const techRows = []

  rows.slice(2).each((_, row) => {
    const cells = $(row).children('td')
    if (cells.length < 3) {
      return
    }

    const stage = cleanText(cells.eq(0).text())
    const points = normalizeTechPoint(cells.eq(1).text())
    const bonus = cleanMultilineText(cells.eq(cells.length - 1).text()) || '-'

    if (!stage || !points) {
      return
    }

    techRows.push({
      stage,
      points,
      bonus
    })
  })

  if (!techRows.length || techRows.every((row) => row.points === '+')) {
    return {
      hasData: false,
      total: '',
      rows: []
    }
  }

  return {
    hasData: true,
    total,
    rows: techRows,
    gain: techRows.find((row) => row.stage === '获得')?.points ?? '',
    full: techRows.find((row) => row.stage === '满星')?.points ?? '',
    lv120: techRows.find((row) => row.stage === 'Lv.120')?.points ?? ''
  }
}

function parsePortraitMeta($) {
  const rows = $('table.wikitable.sv-portrait').first().find('tr')
  let cv = ''

  rows.each((index, row) => {
    const $row = $(row)
    const sectionTitle = cleanText($row.find('td[colspan="2"]').first().text())
    if (sectionTitle !== 'CV') {
      return
    }

    const nextRow = rows.eq(index + 1)
    const nextCell = nextRow.find('td[colspan="2"]').first()
    cv = nextCell.length ? getMultilineText(nextCell) : ''
  })

  return {
    cv
  }
}

function parseRetrofit($) {
  const $table = $('table.wikitable').filter((_, table) => {
    const headers = $(table).find('tr').first().find('th').map((__, th) => cleanText($(th).text())).get()
    return headers.includes('改造项目') && headers.includes('项目属性') && headers.includes('需求图纸')
  }).first()

  if (!$table.length) {
    return {
      hasData: false,
      total: '',
      rows: []
    }
  }

  const rows = []
  let total = ''

  $table.find('tr').slice(1).each((_, row) => {
    const $row = $(row)
    const header = cleanText($row.find('th').first().text())

    if (header === '需求合计') {
      total = cleanText($row.find('td').first().text())
      return
    }

    const cells = $row.find('td')
    if (cells.length < 6) {
      return
    }

    rows.push({
      project: cleanText(cells.eq(0).text()),
      attribute: cleanText(cells.eq(1).text()),
      blueprints: cleanText(cells.eq(2).text()),
      materials: cleanText(cells.eq(3).text()),
      level: cleanText(cells.eq(4).text()),
      stars: cleanText(cells.eq(5).text())
    })
  })

  return {
    hasData: rows.length > 0,
    total,
    rows
  }
}

export function parseShipList(html) {
  const $ = load(html)
  return $('div#CardSelectTr span.jntj-4 a[title]')
    .map((_, node) => cleanText($(node).attr('title')))
    .get()
    .filter(Boolean)
}

export function parseShipPage(html, { pageUrl = '' } = {}) {
  const $ = load(html)
  const placeholder = $('big b').toArray().some((node) => cleanText($(node).text()).includes('这是某人挖的一个坑'))
  if (placeholder) {
    throw new Error('该词条还是占坑页，暂时没有可缓存的数据。')
  }

  const typeTitle = $('a[title="首页"]').first().next().attr('title')
  const hasShipTables = $('table.wikitable.sv-general').length && $('table.wikitable.sv-skill').length
  if (typeTitle !== '舰娘图鉴' && !hasShipTables) {
    throw new Error('当前页面不是舰船图鉴页，暂不写入舰船缓存。')
  }

  const general = parseGeneralInfo($)
  const { stats, statFields } = parseStats($)
  const { normalSkills, retrofitSkills } = parseSkills($)
  const equipments = parseEquipments($, general.canUpgrade)
  const fleetTech = parseFleetTech($)
  const portraitMeta = parsePortraitMeta($)
  const retrofit = parseRetrofit($)

  return {
    id: general.name,
    pageTitle: cleanText($('#firstHeading').text()) || general.name,
    pageUrl,
    ...general,
    ...statFields,
    ...portraitMeta,
    fleetTech,
    retrofit,
    stats,
    skills: normalSkills,
    skills_normal: normalSkills,
    skills_retrofit: retrofitSkills,
    equipments
  }
}
