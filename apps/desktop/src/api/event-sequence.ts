export type SequenceDecision = 'accept' | 'drop_old' | 'gap';

export class SequenceTracker {
  readonly #cursors = new Map<string, number>();

  accept(streamId: string, sequence: number): SequenceDecision {
    if (streamId.trim().length === 0 || !Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new Error('invalid event cursor');
    }
    const previous = this.#cursors.get(streamId);
    if (previous === undefined) {
      this.#cursors.set(streamId, sequence);
      return 'accept';
    }
    if (sequence <= previous) return 'drop_old';
    if (sequence > previous + 1) return 'gap';
    this.#cursors.set(streamId, sequence);
    return 'accept';
  }

  resume(streamId: string, sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid replay cursor');
    this.#cursors.set(streamId, sequence);
  }

  cursor(streamId: string): number | undefined { return this.#cursors.get(streamId); }
}
