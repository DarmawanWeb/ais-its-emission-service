/** The last message of the replayed subject, read before the replay starts. */
export interface ReplayEnd {
  /** Stream sequence. */
  readonly seq: number;
  /** When the message was stored in the stream. */
  readonly storedAt: Date;
}

/** How a replay ended (from the handler and the kit's `ReplayReport`). */
export interface ReplayProgress {
  /** The handler stopped the replay at the first message stored after the replay window. */
  readonly passedWindow: boolean;
  /** `ReplayReport.lastSequence`: stream sequence of the last message read, if any. */
  readonly lastSequence: number | undefined;
}

/**
 * Whether a replay starting at `windowStart` read every message of its
 * subject up to the end of its window. The kit's `StreamReplayer.replay`
 * also returns normally when it was cancelled or when its message iterator
 * ended early (e.g. the connection closed during a shutdown), so a caller
 * that deletes what the replay did not reproduce must check this first:
 * - nothing to read when the subject had no message stored at or after
 *   `windowStart` when the replay started (`end` older or absent);
 * - complete when the handler saw a message stored after the window (the
 *   replay ran past it), or when the replay read up to the subject's last
 *   message at start (`lastSequence ≥ end.seq`);
 * - incomplete otherwise.
 */
export function isReplayComplete(
  end: ReplayEnd | undefined,
  windowStart: Date,
  progress: ReplayProgress,
): boolean {
  if (end === undefined || end.storedAt.getTime() < windowStart.getTime())
    return true;
  if (progress.passedWindow) return true;
  return (
    progress.lastSequence !== undefined && progress.lastSequence >= end.seq
  );
}
