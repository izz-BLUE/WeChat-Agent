/** Request-local wall-clock budget for one ACTIVE Agent request. */
export class RequestDeadlineExceededError extends Error {
  public constructor(public readonly phase: string) {
    super(`Agent request deadline exceeded during ${phase}`)
    this.name = 'RequestDeadlineExceededError'
  }
}

export class RequestDeadline {
  private currentPhase = 'START'
  private currentPhaseStartedAt: number
  private readonly phaseDurations = new Map<string, number>()

  public readonly startedAt: number
  public readonly deadlineAt: number

  public constructor(
    public readonly budgetMs: number,
    private readonly now: () => number = () => Date.now(),
    startedAt?: number,
  ) {
    if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) {
      throw new Error('Request deadline budget must be a positive integer')
    }
    this.startedAt = startedAt ?? this.now()
    this.deadlineAt = this.startedAt + budgetMs
    this.currentPhaseStartedAt = this.startedAt
  }

  public get phase(): string {
    return this.currentPhase
  }

  public mark(phase: string): void {
    const now = this.now()
    this.phaseDurations.set(
      this.currentPhase,
      (this.phaseDurations.get(this.currentPhase) ?? 0) + Math.max(0, now - this.currentPhaseStartedAt),
    )
    this.currentPhase = phase
    this.currentPhaseStartedAt = now
  }

  public phaseLatencyMs(phase: string): number {
    const completed = this.phaseDurations.get(phase) ?? 0
    if (phase !== this.currentPhase) {
      return completed
    }
    return completed + Math.max(0, this.now() - this.currentPhaseStartedAt)
  }

  public remainingMs(): number {
    return Math.max(0, this.deadlineAt - this.now())
  }

  public expired(): boolean {
    return this.remainingMs() <= 0
  }

  public throwIfExpired(): void {
    if (this.expired()) {
      throw new RequestDeadlineExceededError(this.currentPhase)
    }
  }
}

export function isRequestDeadlineExceeded(error: unknown): error is RequestDeadlineExceededError {
  return error instanceof RequestDeadlineExceededError
}

/**
 * Runs one Provider operation with an abort signal and the remaining request
 * budget. The timeout wins even when a custom Provider ignores the signal.
 */
export async function withRequestDeadline<T>(
  deadline: RequestDeadline,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  deadline.throwIfExpired()
  const controller = new AbortController()
  const remainingMs = Math.max(1, deadline.remainingMs())
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new RequestDeadlineExceededError(deadline.phase))
    }, remainingMs)
  })

  try {
    const result = await Promise.race([operation(controller.signal), timeout])
    deadline.throwIfExpired()
    return result
  } catch (error) {
    if (isRequestDeadlineExceeded(error) || deadline.expired()) {
      throw new RequestDeadlineExceededError(deadline.phase)
    }
    throw error
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}
