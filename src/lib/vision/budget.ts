const DEFAULT_BUDGET_USD = 0.05;

export class VisionBudget {
  private spent = 0;
  private readonly limit: number;

  constructor(limitUsd?: number) {
    this.limit = limitUsd ?? Number(process.env['VISION_BUDGET_USD_PER_REQUEST']) || DEFAULT_BUDGET_USD;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  canAfford(estimatedCost: number): boolean {
    return this.spent + estimatedCost <= this.limit;
  }

  charge(cost: number): void {
    this.spent += cost;
  }
}
