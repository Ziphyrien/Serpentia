export class SnapshotDeliveryState {
  private readonly backpressured = new Set<string>();

  shouldSendSnapshot(connectionId: string): boolean {
    return !this.backpressured.has(connectionId);
  }

  recordSend(connectionId: string, status: number): void {
    if (status === -1) this.backpressured.add(connectionId);
  }

  drain(connectionId: string): boolean {
    return this.backpressured.delete(connectionId);
  }

  forget(connectionId: string): void {
    this.backpressured.delete(connectionId);
  }
}
