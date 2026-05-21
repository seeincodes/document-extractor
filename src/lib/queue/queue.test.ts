import { describe, it, expect } from 'vitest';

import { isQueueFull } from './index';

describe('isQueueFull', () => {
  it('returns false when queue is empty', () => {
    expect(isQueueFull()).toBe(false);
  });
});
