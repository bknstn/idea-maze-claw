import { ContainerOutput } from './container-runner.js';

/**
 * The host should only treat the container as idle after the query loop emits
 * its final success marker with a null result. Regular success results can be
 * intermediate assistant output while the query is still active.
 */
export function isIdleMarker(output: ContainerOutput): boolean {
  return output.status === 'success' && output.result === null;
}
