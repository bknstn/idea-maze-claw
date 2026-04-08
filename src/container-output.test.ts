import { describe, expect, it } from 'vitest';

import { isIdleMarker } from './container-output.js';

describe('isIdleMarker', () => {
  it('returns true for the final success marker', () => {
    expect(
      isIdleMarker({
        status: 'success',
        result: null,
      }),
    ).toBe(true);
  });

  it('returns false for streamed assistant output', () => {
    expect(
      isIdleMarker({
        status: 'success',
        result: 'Partial assistant output',
      }),
    ).toBe(false);
  });

  it('returns false for error markers', () => {
    expect(
      isIdleMarker({
        status: 'error',
        result: null,
        error: 'API Error: 529',
      }),
    ).toBe(false);
  });
});
