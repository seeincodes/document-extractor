import { describe, it, expect } from 'vitest';

import { VisionBudget } from './budget';

describe('VisionBudget', () => {
  it('starts with full budget', () => {
    const b = new VisionBudget(0.05);
    expect(b.remaining).toBe(0.05);
  });

  it('tracks spending', () => {
    const b = new VisionBudget(0.05);
    b.charge(0.003);
    expect(b.remaining).toBeCloseTo(0.047);
    expect(b.canAfford(0.003)).toBe(true);
  });

  it('rejects when budget exhausted', () => {
    const b = new VisionBudget(0.005);
    b.charge(0.003);
    expect(b.canAfford(0.003)).toBe(false);
  });

  it('remaining never goes below zero', () => {
    const b = new VisionBudget(0.001);
    b.charge(1);
    expect(b.remaining).toBe(0);
  });
});
