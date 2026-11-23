import { interactionMessages } from '../interaction-messages.ts'

const REFERENCE_EVENT = 'starhub:ssh-terminal-reference'

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
