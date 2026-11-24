import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { interactionMessages } from './interaction-messages.ts'
import { StarHubToolWorkspace, type StarHubToolWorkspaceInjected } from './StarHubToolWorkspace.tsx'
import { ToolsIcon } from './ToolsPanelIcon.tsx'

const TOOLBOX_KIND = 'starhub-toolbox'

type ToolboxInjected = Omit<StarHubToolWorkspaceInjected, 'closeTools'> & { closeExecRecords: () => void }

function SidebarToolsTab({ useTabInfo, closeExecRecords, ...workspace }:
  Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useTabInfo'> & InjectFace<ToolboxInjected>) {
  const { tab } = useTabInfo()
  return (
    <StarHubToolWorkspace
      {...workspace}
      closeToolsLabel={interactionMessages().closeToolbox}
      closeTools={() => {
        closeExecRecords()
        tab.actions.close()
      }}
    />
  )
}

/** Add a toolbox card to the native right-sidebar guide when the host provides it. */
export function installSidebarTools(ctx: Context, injectWorkspace: () => ToolboxInjected): void {
  ctx.inject(['sidebarRightTabs'], sidebarCtx => {
    const title = () => interactionMessages().toolboxTitle
    sidebarCtx.effect(() => sidebarCtx.sidebarRightTabs.register({
      id: TOOLBOX_KIND,
      kind: TOOLBOX_KIND,
      title,
      guide: [{
        id: 'open',
        order: 100,
        title,
        description: () => interactionMessages().toolboxDescription,
        icon: ToolsIcon,
      }],
    }), 'starhub: toolbox sidebar tab type')
    sidebarCtx.effect(() => sidebarCtx.slots.inject('sidebar.right.pane.tab', () => sidebarCtx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TOOLBOX_KIND,
      inject: injectWorkspace,
    }, SidebarToolsTab)), 'starhub: toolbox sidebar tab body')
  })
}
