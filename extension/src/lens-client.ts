import type { ReplyFrame } from './protocol/ReplyFrame';
import type { Request } from './protocol/Request';
import type { Reply } from './protocol/Reply';

export const HOST_NAME = 'studio.sirv.lens';

/** The reply type that answers each request method. */
type ReplyTo = {
  hello: 'hello';
  createObservation: 'observation';
  listObservations: 'observations';
  shutdown: 'stopping';
};
type ReplyData<M extends Request['method']> = Extract<Reply, { type: ReplyTo[M] }> extends { data: infer D } ? D : never;

export class LensError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One native messaging port to the shim, which relays to `lensd`. */
export class LensClient {
  private readonly port: Browser.runtime.Port;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  private closed: LensError | null = null;

  constructor(private readonly onClose: (error: LensError) => void = () => {}) {
    this.port = browser.runtime.connectNative(HOST_NAME);
    this.port.onMessage.addListener((frame: ReplyFrame) => {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      if (frame.status === 'ok') waiter.resolve(frame.result);
      else waiter.reject(new LensError(frame.error.code, frame.error.message));
    });
    this.port.onDisconnect.addListener(() => {
      this.closed = new LensError('disconnected', browser.runtime.lastError?.message ?? 'Lens closed the connection');
      for (const waiter of this.pending.values()) waiter.reject(this.closed);
      this.pending.clear();
      this.onClose(this.closed);
    });
  }

  request<M extends Request['method']>(request: Extract<Request, { method: M }>): Promise<ReplyData<M>> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (reply) => resolve((reply as { data?: unknown }).data as ReplyData<M>), reject });
      this.port.postMessage({ id, ...request });
    });
  }

  disconnect() {
    this.port.disconnect();
  }
}
