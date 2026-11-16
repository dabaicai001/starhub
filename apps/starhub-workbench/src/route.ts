/**
 * Standalone window routing: parse the opening URL into a requested workbench
 * kind + asset id, and map a StarHub asset to the workbench React component
 * that should render it full-window. Pure and unit-testable.
 */

import type { RustAsset } from '@deepseek-ai/dsh-starhub-client-nav/src/client/store.ts'
import { routeNameForAsset } from '@deepseek-ai/dsh-starhub-client-nav/src/client/sections.ts'

/** The workbench kinds this standalone window can host. */
export type WindowWorkbench = 'ssh' | 'db-mysql' | 'db-postgresql' | 'db-clickhouse' | 'db-sqlite' | 'db-mssql' | 'db-redis' | 'db-elasticsearch' | 'broker' | 'docker'

/** All accepted workbench kinds (for the URL hint narrow). */
const WINDOW_WORKBENCHES: readonly string[] = [
  'ssh', 'db-mysql', 'db-postgresql', 'db-clickhouse', 'db-sqlite', 'db-mssql', 'db-redis', 'db-elasticsearch', 'broker', 'docker',
]

/** Narrow a string to a WindowWorkbench, or null. */
export function isWindowWorkbench(value: string | null | undefined): value is WindowWorkbench {
  return value !== null && value !== undefined && WINDOW_WORKBENCHES.includes(value)
}

/** Map a route name (from routeNameForAsset) to a workbench kind, or null. */
export function workbenchForRouteName(routeName: string): WindowWorkbench | null {
  switch (routeName) {
    case 'ssh-terminal':
      return 'ssh'
    case 'db-broker':
      return 'broker'
    case 'db-mysql':
      return 'db-mysql'
    case 'db-postgresql':
      return 'db-postgresql'
    case 'db-clickhouse':
      return 'db-clickhouse'
    case 'db-sqlite':
      return 'db-sqlite'
    case 'db-mssql':
      return 'db-mssql'
    case 'db-redis':
      return 'db-redis'
    case 'db-elasticsearch':
      return 'db-elasticsearch'
    case 'docker':
      return 'docker'
    default:
      return null
  }
}

/**
 * Parse the standalone-window URL query into `{ assetId, workbench }`.
 * Asset id is required; a missing/blank id yields null (window shows a
 * friendly error instead of mounting a workbench).
 * @param search - `window.location.search`, e.g. `?asset=a1__1&workbench=ssh`.
 * @returns the requested asset id + workbench hint, or null.
 */
export function parseWindowParams(search: string): { assetId: string; workbench: WindowWorkbench | null } | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const assetId = params.get('asset')?.trim() ?? ''
  if (assetId === '') return null
  const hint = params.get('workbench')?.trim() ?? ''
  return { assetId, workbench: isWindowWorkbench(hint) ? hint : null }
}

/**
 * Map a hydrated Rust asset to the workbench kind it should render.
 * Assets without a React workbench (for example local files) return null;
 * the window shows an error for those rather than mounting a Vue embed.
 * @param asset - the hydrated asset from get_assets.
 * @returns the workbench kind, or null.
 */
export function workbenchForAsset(asset: RustAsset): WindowWorkbench | null {
  return workbenchForRouteName(routeNameForAsset(asset))
}
