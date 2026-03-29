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
import {
  buildMissingDataMessage,
  buildRenderFailureMessage,
  parseWikiCommand
} from '../model/wiki-command.js'

const COMMAND_HEAD = '(?:(?:;|；)\\s*(?:碧蓝|碧蓝航线|blhx)?|(?:碧蓝|碧蓝航线|blhx))\\s*'
const MATCH_ALL_RULE = `^${COMMAND_HEAD}.*$`
const COMMAND_TAIL = '[.。!！~～…]*$'
const UPDATE_PLUGIN_RULE = new RegExp(`^${COMMAND_HEAD}插件更新${COMMAND_TAIL}`, 'i')
const UPDATE_SHIP_DATA_RULE = new RegExp(`^${COMMAND_HEAD}更新(.+?)数据${COMMAND_TAIL}`, 'i')
let initLogged = false

function isUpdatePluginCommand(message) {
  return UPDATE_PLUGIN_RULE.test(String(message ?? '').trim())
}

function parseShipUpdateCommand(message) {
  const match = String(message ?? '').trim().match(/^(?:(?:;|；)\s*(?:碧蓝|碧蓝航线|blhx)?|(?:碧蓝|碧蓝航线|blhx))\s*更新(.+?)数据[.。~～…]*$/i)
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
          reg: MATCH_ALL_RULE,
          fnc: 'dispatchMessage'
        }
      ]
    })

    if (!initLogged) {
      initLogged = true
      const message = '[azurlane-plugin] 碧蓝航线 Wiki 插件初始化成功，已启用命令：;xxx / 碧蓝xxx'
      globalThis.logger?.info?.(message)
      if (!globalThis.logger?.info) {
        console.info(message)
      }
    }
  }

  async checkAuth(e) {
    if (e?.isMaster) {
      return true
    }
    return false
  }

  async dispatchMessage(e) {
    e.original_msg = e.original_msg || e.msg
    const message = String(e.original_msg ?? '').trim()
    if (!message) {
      return false
    }

    if (isUpdatePluginCommand(message)) {
      return this.updatePlugin(e)
    }

    if (parseShipUpdateCommand(message)) {
      return this.updateShipData(e)
    }

    const parsed = parseWikiCommand(message)
    if (!parsed) {
      return false
    }

    return this.dispatchWikiCommand(e, parsed)
  }

  async dispatchWikiCommand(e, parsed) {
    e.azurlaneWiki = parsed

    try {
      const { ship, alternatives, cacheMeta } = await findShipFromCache(parsed.keyword)
      const image = parsed.mode === 'equip'
        ? await this.renderEquipCard(e, { ship, keyword: parsed.keyword, alternatives, cacheMeta })
        : await this.renderWikiCard(e, { ship, mode: parsed.mode, keyword: parsed.keyword, alternatives, cacheMeta })

      if (!image) {
        return buildRenderFailureMessage(parsed.mode)
      }

      return image
    } catch (error) {
      if (error instanceof CacheLookupError) {
        return error.message
      }

      if (error?.code === 'ENOENT') {
        return buildMissingDataMessage(parsed.mode, parsed.keyword)
      }

      globalThis.logger?.error?.('[azurlane-plugin] 查询舰船资料失败', error)
      return '查询失败了，请检查本地缓存数据是否存在且格式正确。'
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
      return '只有主人才能使用这个命令。'
    }

    try {
      const result = await updatePluginFromGit()
      return formatGitUpdateReply(result)
    } catch (error) {
      globalThis.logger?.error?.('[azurlane-plugin] 插件更新失败', error)
      return formatGitUpdateError(error)
    }
  }

  async updateShipData(e) {
    if (!await this.checkAuth(e)) {
      return '只有主人才能使用这个命令。'
    }

    const keyword = parseShipUpdateCommand(e.original_msg || e.msg)
    if (!keyword) {
      return '请输入要更新的舰船名称，例如：!更新卡辛数据'
    }

    try {
      const result = await refreshShipBundleByName(keyword)
      return formatShipRefreshReply(result)
    } catch (error) {
      globalThis.logger?.error?.('[azurlane-plugin] 更新舰船缓存失败', error)
      return `更新 ${keyword} 数据失败：${error?.message || error}`
    }
  }
}
