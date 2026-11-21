/** State of a {@link CircuitBreaker}. */
export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * Consecutive-failure circuit breaker: after `threshold` failures in a row it
 * opens for `cooldownMs`, then lets one trial request through (half open);
 * a success closes it, a failure opens it again.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private trialInFlight = false;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): CircuitState {
    if (this.openedAt === undefined) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  /** Whether a request may be sent now (reserves the trial when half open). */
  tryAcquire(): boolean {
    switch (this.state) {
      case 'closed':
        return true;
      case 'open':
        return false;
      case 'half_open':
        if (this.trialInFlight) return false;
        this.trialInFlight = true;
        return true;
    }
  }

  success(): void {
    this.failures = 0;
    this.openedAt = undefined;
    this.trialInFlight = false;
  }

  failure(): void {
    this.trialInFlight = false;
    this.failures += 1;
    if (this.openedAt !== undefined || this.failures >= this.threshold)
      this.openedAt = this.now();
  }
}
