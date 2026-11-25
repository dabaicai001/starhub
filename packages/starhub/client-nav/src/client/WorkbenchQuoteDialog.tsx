import { useEffect, useRef, useState } from 'react'
import { interactionMessages } from './interaction-messages.ts'
import { requestWorkbenchQuote, workbenchQuoteTarget, WORKBENCH_QUOTE_LIMIT, type WorkbenchQuote } from './workbench-reference.ts'
import css from './WorkbenchQuoteDialog.module.css'

/** Preview the workbench context before adding it to the conversation. */
export function WorkbenchQuoteDialog({ assetName, quote, onClose, onAdded }: {
  assetName: string
  quote: WorkbenchQuote
  onClose: () => void
  onAdded?: () => void
}) {
  const messages = interactionMessages()
  const dialog = useRef<HTMLDialogElement>(null)
  const [includeText, setIncludeText] = useState(quote.text.trim() !== '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const excerpt = quote.text.slice(0, WORKBENCH_QUOTE_LIMIT)
  const target = workbenchQuoteTarget(quote)

  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    element.showModal()
    return () => { element.close() }
  }, [])

  const add = async (): Promise<void> => {
    setPending(true)
    setError('')
    try {
      await requestWorkbenchQuote({ ...quote, text: includeText ? excerpt : '' })
      onAdded?.()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setPending(false)
    }
  }

  return (
    <dialog ref={dialog} className={css.dialog} aria-label={messages.quoteWorkbenchContext}
      onCancel={event => { event.preventDefault(); if (!pending) onClose() }}>
      <h2>{messages.quoteWorkbenchContext}</h2>
      <div className={css.target}>
        <strong>{assetName}</strong>
        {target !== '' && <span>{target}</span>}
      </div>
      {excerpt.trim() !== '' && (
        <div className={css.selection}>
          <label><input type="checkbox" checked={includeText} disabled={pending}
            onChange={event => { setIncludeText(event.currentTarget.checked) }} />
            {quote.kind === 'ssh' ? messages.quoteIncludeTerminal : messages.quoteIncludeSql}
          </label>
          {includeText && <pre>{excerpt}</pre>}
          {includeText && quote.text.length > excerpt.length && <small>{messages.quoteTruncated(WORKBENCH_QUOTE_LIMIT)}</small>}
        </div>
      )}
      {error !== '' && <p className={css.error} role="alert">{error}</p>}
      <div className={css.actions}>
        <button type="button" disabled={pending} onClick={onClose}>{messages.cancel}</button>
        <button type="button" className={css.primary} disabled={pending} onClick={() => void add()}>
          {pending ? messages.quoteAdding : messages.quoteAddToDraft}
        </button>
      </div>
    </dialog>
  )
}
