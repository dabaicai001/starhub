import { interactionMessages } from './interaction-messages.ts'

const QUOTE_EVENT = 'starhub:workbench-quote'
export const WORKBENCH_QUOTE_LIMIT = 4_000

/** Context captured when the user opens the preview. */
export type WorkbenchQuote =
  | { kind: 'ssh'; terminalSessionId: string; directory: string; text: string }
  | { kind: 'database'; database: string; table: string; text: string }

interface QuoteRequest {
  quote: WorkbenchQuote
  respond: (result: Promise<void>) => void
}

export function requestWorkbenchQuote(quote: WorkbenchQuote): Promise<void> {
  let result: Promise<void> | undefined
  window.frameElement?.dispatchEvent(new CustomEvent<QuoteRequest>(QUOTE_EVENT, {
    detail: { quote, respond: response => { result = response } },
  }))
  return result ?? Promise.reject(new Error(interactionMessages().noReferenceConversation))
}

/** Receive context from this iframe; the parent supplies the asset identity. */
export function listenForWorkbenchQuote(frame: HTMLIFrameElement, receive: (quote: WorkbenchQuote) => Promise<void>): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<Partial<QuoteRequest> | undefined>).detail
    const quote = detail?.quote
    if (typeof detail?.respond !== 'function' || typeof quote?.text !== 'string') return
    const text = quote.text.slice(0, WORKBENCH_QUOTE_LIMIT)
    if (quote.kind === 'ssh' && typeof quote.terminalSessionId === 'string' && typeof quote.directory === 'string') {
      detail.respond(receive({ ...quote, directory: quote.directory.slice(0, 1024), text }))
    } else if (quote.kind === 'database' && typeof quote.database === 'string' && typeof quote.table === 'string') {
      detail.respond(receive({ ...quote, database: quote.database.slice(0, 255), table: quote.table.slice(0, 255), text }))
    }
  }
  frame.addEventListener(QUOTE_EVENT, listener)
  return () => { frame.removeEventListener(QUOTE_EVENT, listener) }
}

export function workbenchQuoteTarget(quote: WorkbenchQuote): string {
  const messages = interactionMessages()
  if (quote.kind === 'ssh') {
    const terminal = messages.quoteTerminal(quote.terminalSessionId.split('__').at(-1) ?? quote.terminalSessionId)
    return quote.directory === '' ? terminal : `${terminal} · ${messages.quoteDirectory(quote.directory)}`
  }
  return [
    quote.database === '' ? '' : messages.quoteDatabase(quote.database),
    quote.table === '' ? '' : messages.quoteTable(quote.table),
  ].filter(Boolean).join(' · ')
}
