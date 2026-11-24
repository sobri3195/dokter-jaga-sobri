import * as v1 from './engine-v1'

export type { State } from './engine-v1'
export const currentEngineVersion = 1

// Keep the published engine and rubric available for sessions pinned to it.
export function engineFor(version: number) {
  if (version === 1) return v1
  throw new Error('Unsupported simulation engine version')
}
