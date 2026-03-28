import plugin from '../../../lib/plugins/plugin.js'
import { renderShipCard, renderShipEquipCard } from '../components/render.js'
import { CacheLookupError, findShipFromCache } from '../model/cache-store.js'
import { readShipEquipData } from '../model/ship-store.js'
import {
  formatGitUpdateError,
  formatGitUpdateReply,
  formatShipRefreshReply,
  refreshShipBundleByName,
  updatePluginFromGit
} from '../model/admin-service.js'
import { WIKI_COMMAND_RULE, buildMissingDataMessage, buildRenderFailureMessage, parseWikiCommand } from '../model/wiki-command.js'

const UPDATE_PLUGIN_RULE = '^(?:&|＆)碧蓝航线插件更新$'
const UPDATE_SHIP_DATA_RULE = '^(?:&|＆)更新(.+?)数据$'

function parseShipUpdateCommand(message) {
  const match = String(message ?? '').trim().match(/^(?:&|＆)更新(.+?)数据$/i)
  if (!match) {
    return ''
  }

  return String(match[1] ?? '').replace(/\s+/g, '').trim()
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
          reg: WIKI_COMMAND_RULE,
          fnc: 'dispatchWikiCommand'
        },
        {
          reg: UPDATE_PLUGIN_RULE,
          fnc: 'updatePlugin'
        },
        {
          reg: UPDATE_SHIP_DATA_RULE,
          fnc: 'updateShipData'
        }
      ]
    })
  }

  async checkAuth(e) {
    if (e?.isMaster) {
      return true
    }

    await e.reply('只有主人才能使用这个命令。')
    return false
  }

  async dispatchWikiCommand(e) {
    e.original_msg = e.original_msg || e.msg
    const parsed = parseWikiCommand(e.original_msg)
    if (!parsed) {
      return false
    }

    e.azurlaneWiki = parsed

    try {
      const { ship, alternatives, cacheMeta } = await findShipFromCache(parsed.keyword)
      const image = parsed.mode === 'equip'
        ? await this.renderEquipCard(e, { ship, keyword: parsed.keyword, alternatives, cacheMeta })
        : await this.renderWikiCard(e, { ship, mode: parsed.mode, keyword: parsed.keyword, alternatives, cacheMeta })

      if (!image) {
        await e.reply(buildRenderFailureMessage(parsed.mode))
        return true
      }

      await e.reply(image)
      return true
    } catch (error) {
      if (error instanceof CacheLookupError) {
        await e.reply(error.message)
        return true
      }

      if (error?.code === 'ENOENT') {
        await e.reply(buildMissingDataMessage(parsed.mode, parsed.keyword))
        return true
      }

      globalThis.logger?.error?.('[azurlane-plugin] 查询舰船资料失败', error)
      await e.reply('查询失败了，请检查本地缓存数据是否存在且格式正确。')
      return true
    }
  }

  async renderWikiCard(e, payload) {
    return renderShipCard(e, payload)
  }

  async renderEquipCard(e, payload) {
    const equip = await readShipEquipData(payload.ship.name)
    return renderShipEquipCard(e, { ...payload, equip })
  }

  async updatePlugin(e) {
    if (!await this.checkAuth(e)) {
      return true
    }

    try {
      const result = await updatePluginFromGit()
      await e.reply(formatGitUpdateReply(result))
      return true
    } catch (error) {
      globalThis.logger?.error?.('[azurlane-plugin] 插件更新失败', error)
      await e.reply(formatGitUpdateError(error))
      return true
    }
  }

  async updateShipData(e) {
    if (!await this.checkAuth(e)) {
      return true
    }

    const keyword = parseShipUpdateCommand(e.original_msg || e.msg)
    if (!keyword) {
      await e.reply('请输入要更新的舰船名称，例如：&更新卡辛数据')
      return true
    }

    try {
      const result = await refreshShipBundleByName(keyword)
      await e.reply(formatShipRefreshReply(result))
      return true
    } catch (error) {
      globalThis.logger?.error?.('[azurlane-plugin] 更新舰船缓存失败', error)
      await e.reply(`更新 ${keyword} 数据失败：${error?.message || error}`)
      return true
    }
  }
}
