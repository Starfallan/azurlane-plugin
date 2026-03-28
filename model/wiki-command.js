export const WIKI_COMMAND_RULE = '^(?:&|＆)\\s*(?:碧蓝|碧蓝航线|blhx)?\\s*(.+?)(技能|天赋|资料|图鉴|属性|配装|配装推荐|推荐配装|装备)$'

const WIKI_COMMAND_REG = /^(?:&|＆)\s*(?:碧蓝|碧蓝航线|blhx)?\s*(.+?)(技能|天赋|资料|图鉴|属性|配装|配装推荐|推荐配装|装备)$/i

export function parseWikiCommand(message) {
  const rawMessage = String(message ?? '').trim()
  if (!rawMessage) {
    return null
  }

  const match = rawMessage.match(WIKI_COMMAND_REG)
  if (!match) {
    return null
  }

  const keyword = match[1].replace(/\s+/g, '').trim()
  const rawMode = String(match[2] ?? '').trim()
  if (!keyword || !rawMode) {
    return null
  }

  let mode = 'ship'
  if (/(技能|天赋)/i.test(rawMode)) {
    mode = 'skill'
  } else if (/配装/i.test(rawMode)) {
    mode = 'equip'
  }

  return {
    command: rawMessage,
    keyword,
    rawMode,
    mode
  }
}

export function buildMissingDataMessage(mode, keyword) {
  const safeKeyword = String(keyword ?? '').trim()
  if (mode === 'equip') {
    return `本地还没有这条舰船的配装缓存，请先执行 \`pnpm run build:ship-equip -- --only=${safeKeyword}\`。`
  }

  return `本地还没有这条舰船的资料缓存，请先执行 \`pnpm run build:ships -- --only=${safeKeyword}\`。`
}

export function buildRenderFailureMessage(mode) {
  if (mode === 'equip') {
    return '配装图片渲染失败，请检查 Yunzai 的 Puppeteer 渲染器配置。'
  }

  return '图片渲染失败，请检查 Yunzai 的 Puppeteer 渲染器配置。'
}
