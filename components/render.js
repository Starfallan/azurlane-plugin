const PLUGIN_NAME = 'azurlane-plugin'
import { buildShipCardViewModel } from '../model/ship-card-data.js'

function createRenderData({ ship, mode, keyword, alternatives, cacheMeta }) {
  const view = buildShipCardViewModel({ ship, mode, keyword, alternatives, cacheMeta })

  return {
    ...view,
    tplFile: `./plugins/${PLUGIN_NAME}/resources/wiki/ship-card.html`,
    defaultLayout: `./plugins/${PLUGIN_NAME}/resources/common/layout/default.html`,
    _res_path: `./plugins/${PLUGIN_NAME}/resources/`,
    sys: {
      scale: 'data-scale="1.15"',
      copyright: `AzurLane Wiki Cache · ${cacheMeta?.generatedAt ?? 'local'}`
    }
  }
}

export async function renderShipCard(e, payload) {
  if (!e) {
    return false
  }

  const renderer = globalThis.Renderer?.getRenderer?.()
  if (!renderer?.render) {
    globalThis.logger?.error?.('[azurlane-plugin] 未找到可用的 Renderer 渲染器')
    return false
  }

  const data = createRenderData(payload)
  const image = await renderer.render('wiki/ship-card', data)
  return globalThis.segment?.image?.(image) ?? image
}
