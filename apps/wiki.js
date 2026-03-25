import plugin from '../../../lib/plugins/plugin.js'
import { renderShipCard } from '../components/render.js'
import { CacheLookupError, findShipFromCache } from '../model/cache-store.js'

const WIKI_REG = /^#(?:碧蓝|碧蓝航线|blhx)?\s*(.+?)(技能|天赋|资料|图鉴|属性)$/i

function parseMode(rawMode) {
  return ['技能', '天赋'].includes(rawMode) ? 'skill' : 'ship'
}

export class AzurLaneWiki extends plugin {
  constructor() {
    super({
      name: 'azurlane-wiki-cache',
      dsc: '读取本地缓存的碧蓝航线 Wiki 舰船资料并渲染图片',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#(?:碧蓝|碧蓝航线|blhx)?\\s*(.+?)(技能|天赋|资料|图鉴|属性)$',
          fnc: 'renderWikiCard'
        }
      ]
    })
  }

  async renderWikiCard(e) {
    const match = e.msg?.trim().match(WIKI_REG)
    if (!match) {
      return false
    }

    const keyword = match[1].replace(/\s+/g, '')
    const mode = parseMode(match[2])

    try {
      const { ship, alternatives, cacheMeta } = await findShipFromCache(keyword)
      const image = await renderShipCard(e, { ship, mode, keyword, alternatives, cacheMeta })

      if (!image) {
        await e.reply('图片渲染失败，请检查 Yunzai 的 Puppeteer 渲染器配置。')
        return true
      }

      await e.reply(image)
      return true
    } catch (error) {
      if (error instanceof CacheLookupError) {
        await e.reply(error.message)
        return true
      }

      globalThis.logger?.error?.('[azurlane-plugin] 查询舰船资料失败', error)
      await e.reply('查询失败了，请检查本地缓存数据是否存在且格式正确。')
      return true
    }
  }
}
