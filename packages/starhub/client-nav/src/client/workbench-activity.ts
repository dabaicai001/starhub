import { useSyncExternalStore } from 'react'

const ACTIVITY_EVENT = 'starhub:workbench-activity'

/** Let the host distinguish the application from the browser's iframe error document. */
export function reportWorkbenchLoaded(): void {
  window.frameElement?.setAttribute('data-starhub-ready', '')
}

/** Notify a mounted workbench after React commits its iframe's visibility attribute. */
export function notifyWorkbenchActivity(frame: HTMLIFrameElement): void {
  try {
    frame.contentWindow?.dispatchEvent(new Event(ACTIVITY_EVENT))
  } catch {
    // Ignore a frame that navigated away from the StarHub origin.
  }
}

function workbenchActive(): boolean {
  if (document.visibilityState === 'hidden') return false
  return window.frameElement?.getAttribute('data-starhub-active') !== 'false'
}

function subscribe(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  window.addEventListener(ACTIVITY_EVENT, listener)
  return () => {
    document.removeEventListener('visibilitychange', listener)
    window.removeEventListener(ACTIVITY_EVENT, listener)
  }
}

/** Combine shell tab activity with standalone browser tab visibility. */
export function useWorkbenchActivity(): boolean {
  return useSyncExternalStore(subscribe, workbenchActive, () => true)
}
