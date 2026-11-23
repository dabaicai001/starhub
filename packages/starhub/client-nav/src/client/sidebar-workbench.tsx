import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { currentSessionId } from './current-session.ts'
import { interactionMessages } from './interaction-messages.ts'
import { StarHubSidebarWorkbench, type TerminalReference } from './StarHubWorkbenchPanel.tsx'
import type { StarHubAssets } from './store.ts'

const WORKBENCH_KIND = 'starhub-workbench'
const WORKBENCH_ADDRESS = 'dsh-resource://starhub-workbench/asset/'

function assetIdFromAddress(address: string): string | undefined {
  if (!address.startsWith(WORKBENCH_ADDRESS)) return undefined
  const encodedId = address.slice(WORKBENCH_ADDRESS.length)
  if (encodedId === '') return undefined
  try {
    return decodeURIComponent(encodedId)
  } catch {
    return undefined
  }
}

function WorkbenchTab({ useTabInfo, referenceTerminal }:
  PropsRuntime<'sidebar.right.pane.tab'> & { referenceTerminal: TerminalReference }) {
  const { tab } = useTabInfo()
  const assetId = assetIdFromAddress(tab.contentId)
  return assetId === undefined
    ? null
    : <StarHubSidebarWorkbench key={assetId} assetId={assetId} title={tab.title} referenceTerminal={referenceTerminal} />
}

/**
 * Register one native right-sidebar tab per asset and session when the host
 * provides the sidebar. Older hosts can still use the independent workbench.
 */
export function installSidebarWorkbench(
  ctx: Context, assets: StarHubAssets, layout: ILayout, sessions: ISessions, referenceTerminal: TerminalReference,
) {
  let openInSidebar: ((assetId: string, onlyIfOpen: boolean) => boolean) | undefined
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (sidebarCtx) => {
    const sidebar = sidebarCtx.sidebarRight
    sidebarCtx.effect(() => sidebarCtx.sidebarRightTabs.register({
      id: WORKBENCH_KIND,
      kind: WORKBENCH_KIND,
      keepMounted: true,
      patterns: [`${WORKBENCH_ADDRESS}**`],
      canOpen: address => assetIdFromAddress(address) !== undefined,
      title: address => {
        const id = assetIdFromAddress(address)
        return assets.source.getSnapshot().assets.find(asset => asset.id === id)?.name
          ?? interactionMessages().workbenchTitle
      },
    }), 'starhub: workbench sidebar tab type')
    sidebarCtx.effect(() => sidebarCtx.slots.inject('sidebar.right.pane.tab', () => sidebarCtx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: WORKBENCH_KIND,
      inject: () => ({ referenceTerminal }),
    }, WorkbenchTab)), 'starhub: workbench sidebar tab body')
    sidebarCtx.effect(() => {
      openInSidebar = (assetId, onlyIfOpen) => {
        const visibleSession = sidebar.mounted.getSnapshot()
        const sessionId = visibleSession ?? currentSessionId(sessions.list.getSnapshot())
        if (sessionId === undefined) return false

        const address = `${WORKBENCH_ADDRESS}${encodeURIComponent(assetId)}`
        if (onlyIfOpen && !sidebar.openTabs.getSnapshot().some(tab =>
          tab.sessionId === sessionId && tab.kind === WORKBENCH_KIND && tab.contentId === address,
        )) return false

        // The sidebar belongs to the Conversation. Return from the global
        // tools panel without changing the selected session.
        if (visibleSession === undefined) layout.selectPanel(null)
        if (sidebar.mounted.getSnapshot() !== sessionId) return false
        sidebar.openResource(address, { kind: WORKBENCH_KIND })
        return true
      }
      return () => { openInSidebar = undefined }
    }, 'starhub: workbench sidebar opener')
  })
  return (assetId: string, onlyIfOpen = false): boolean => openInSidebar?.(assetId, onlyIfOpen) ?? false
}
