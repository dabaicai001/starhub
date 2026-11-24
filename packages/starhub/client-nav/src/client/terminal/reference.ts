import { interactionMessages } from '../interaction-messages.ts'

const REFERENCE_EVENT = 'starhub:ssh-terminal-reference'
const CONNECTED_TERMINAL_EVENT = 'starhub:connected-terminal'

interface TerminalReferenceDetail {
  terminalSessionId: string
  respond: (result: Promise<void>) => void
}

/** Send a reference request directly to this same-origin workbench frame. */
export function requestTerminalReference(terminalSessionId: string): Promise<void> {
  let result: Promise<void> | undefined
  window.frameElement?.dispatchEvent(new CustomEvent<TerminalReferenceDetail>(REFERENCE_EVENT, {
    detail: { terminalSessionId, respond: response => { result = response } },
  }))
  return result ?? Promise.reject(new Error(interactionMessages().noReferenceConversation))
}

/** Let the parent toolbox resolve the live connection of this workbench frame. */
export function exposeConnectedTerminal(terminalSessionId: string): () => void {
  const listener = (event: Event): void => {
    const respond = (event as CustomEvent<(id: string) => void>).detail
    if (typeof respond === 'function') respond(terminalSessionId)
  }
  window.addEventListener(CONNECTED_TERMINAL_EVENT, listener)
  return () => { window.removeEventListener(CONNECTED_TERMINAL_EVENT, listener) }
}

/** Read only this frame's current SSH connection, if it has connected. */
export function connectedTerminalInFrame(frame: HTMLIFrameElement, assetId: string): string | undefined {
  let terminalSessionId: string | undefined
  try {
    frame.contentWindow?.dispatchEvent(new CustomEvent<(id: string) => void>(CONNECTED_TERMINAL_EVENT, {
      detail: id => {
        if (typeof id === 'string' && id.startsWith(`${assetId}__`)) terminalSessionId = id
      },
    }))
  } catch {
    // A frame may have navigated away from the workbench origin.
  }
  return terminalSessionId
}

/** Pair each embedded frame with its own asset rather than trusting a supplied asset ID. */
export function listenForTerminalReference(
  frame: HTMLIFrameElement,
  assetId: string,
  onReference: (assetId: string, terminalSessionId: string) => Promise<void>,
): () => void {
  const listener = (event: Event): void => {
    // The CustomEvent originates in the iframe's realm.
    const detail = (event as CustomEvent<Partial<TerminalReferenceDetail> | undefined>).detail
    if (typeof detail?.respond !== 'function' || typeof detail.terminalSessionId !== 'string') return
    if (!detail.terminalSessionId.startsWith(`${assetId}__`)) return
    detail.respond(onReference(assetId, detail.terminalSessionId))
  }
  frame.addEventListener(REFERENCE_EVENT, listener)
  return () => { frame.removeEventListener(REFERENCE_EVENT, listener) }
}
