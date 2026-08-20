import { createHmac } from 'node:crypto';
import { connect, type Socket } from 'node:net';

export type IpcClientOptions = Readonly<{
  socketPath: string;
  credential: string;
  rootSessionId: string;
  canonicalProjectPath: string;
  channel?: 'agent' | 'trusted_confirmation';
  timeoutMs?: number;
  maxFrameBytes?: number;
}>;

type FrameWaiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };

function safeErrorCode(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  const match = /^[A-Z][A-Z0-9_]*(?:: [^\r\n]*)?/.exec(message);
  return (match?.[0] ?? 'IPC_REQUEST_FAILED').slice(0, 4096);
}

export class IpcClient {
  readonly #options: Required<Pick<IpcClientOptions, 'timeoutMs' | 'maxFrameBytes'>> & IpcClientOptions;
  #socket: Socket | undefined;
  #connectPromise: Promise<void> | undefined;
  #buffer = '';
  #frames: unknown[] = [];
  #waiters: FrameWaiter[] = [];
  #requestTail: Promise<unknown> = Promise.resolve();

  constructor(options: IpcClientOptions) {
    this.#options = { timeoutMs: 5_000, maxFrameBytes: 1024 * 1024, ...options };
  }

  async connect(): Promise<void> {
    if (this.#socket !== undefined && !this.#socket.destroyed) return;
    if (this.#connectPromise !== undefined) return this.#connectPromise;
    this.#connectPromise = this.#open();
    try {
      await this.#connectPromise;
    } catch (error) {
      this.#socket?.destroy();
      this.#socket = undefined;
      throw error;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  async #open(): Promise<void> {
    const socket = connect(this.#options.socketPath);
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#onData(String(chunk)));
    socket.on('error', (error) => this.#rejectWaiters(new Error(`IPC_CONNECT_FAILED: ${safeErrorCode(error)}`)));
    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#rejectWaiters(new Error('IPC_DISCONNECTED'));
    });
    await this.#withTimeout(new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }), 'IPC_CONNECT_TIMEOUT').catch((error: unknown) => {
      socket.destroy();
      throw new Error(`IPC_CONNECT_FAILED: ${safeErrorCode(error)}`);
    });
    this.#write({
      kind: 'bootstrap', credential: this.#options.credential,
      channel: this.#options.channel ?? 'agent', scope: 'root',
      canonical_project_path: this.#options.canonicalProjectPath,
    });
    const challenge = await this.#readFrame() as Record<string, unknown>;
    if (typeof challenge['challenge'] !== 'string') throw new Error('IPC_AUTHENTICATION_FAILED');
    const proof = createHmac('sha256', this.#options.credential)
      .update(`${challenge['challenge']}\0${this.#options.rootSessionId}\0${this.#options.canonicalProjectPath}`)
      .digest('base64url');
    this.#write({
      kind: 'bind_root_session', challenge: challenge['challenge'],
      session_id: this.#options.rootSessionId, proof,
    });
    const authenticated = await this.#readFrame() as Record<string, unknown>;
    if (authenticated['authenticated'] !== true) throw new Error('IPC_AUTHENTICATION_FAILED');
  }

  request(request: unknown): Promise<unknown> {
    const operation = this.#requestTail.then(() => this.#sendRequest(request));
    this.#requestTail = operation.catch(() => undefined);
    return operation;
  }

  async #sendRequest(request: unknown): Promise<unknown> {
    await this.connect();
    let written = false;
    try {
      this.#write(request);
      written = true;
      const response = await this.#readFrame() as Record<string, unknown>;
      if (response['ok'] !== true) throw new Error(safeErrorCode(response['error']));
      return response['result'];
    } catch (error) {
      if (written && /IPC_(DISCONNECTED|TIMEOUT|CONNECT_FAILED)/.test(safeErrorCode(error))) {
        throw new Error('IPC_RESULT_UNKNOWN');
      }
      throw error;
    }
  }

  #write(value: unknown): void {
    const socket = this.#socket;
    if (socket === undefined || socket.destroyed) throw new Error('IPC_DISCONNECTED');
    const frame = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(frame) > this.#options.maxFrameBytes) throw new Error('IPC_FRAME_TOO_LARGE');
    socket.write(frame);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer) > this.#options.maxFrameBytes && !this.#buffer.includes('\n')) {
      this.#socket?.destroy();
      this.#rejectWaiters(new Error('IPC_FRAME_TOO_LARGE'));
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.#options.maxFrameBytes) {
        this.#socket?.destroy();
        this.#rejectWaiters(new Error('IPC_FRAME_TOO_LARGE'));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.#socket?.destroy();
        this.#rejectWaiters(new Error('IPC_INVALID_JSON'));
        return;
      }
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#frames.push(parsed);
      else waiter.resolve(parsed);
    }
  }

  #readFrame(): Promise<unknown> {
    const existing = this.#frames.shift();
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<unknown>((resolve, reject) => {
      const waiter: FrameWaiter = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        const socket = this.#socket;
        this.#socket = undefined;
        this.#frames = [];
        this.#buffer = '';
        socket?.destroy();
        reject(new Error('IPC_TIMEOUT'));
      }, this.#options.timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  #withTimeout<T>(promise: Promise<T>, code: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(code)), this.#options.timeoutMs);
      promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
    });
  }

  #rejectWaiters(error: Error): void {
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket === undefined || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.end();
    });
  }
}
