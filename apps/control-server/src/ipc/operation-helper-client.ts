import { connect } from 'node:net';
import type { OperationHelper, OperationExecutionResult } from '@project-orchestrator/orchestrator-service';

type HelperResponse = OperationExecutionResult | { error: string };

export class OperationHelperClient implements OperationHelper {
  constructor(
    readonly socketPath: string,
    readonly timeoutMs = 30_000,
    readonly maxFrameBytes = 256 * 1024,
  ) {}

  execute(input: {
    actionType: string; targetFingerprint: string; parameters: Record<string, unknown>;
  }): Promise<OperationExecutionResult> {
    return this.request({ kind: 'execute', ...input });
  }

  reconcile(input: {
    actionType: string; targetFingerprint: string; operationId: string; externalReference?: string;
  }): Promise<OperationExecutionResult> {
    return this.request({ kind: 'reconcile', ...input });
  }

  private request(message: unknown): Promise<OperationExecutionResult> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      let buffer = '';
      let settled = false;
      const finish = (error?: Error, response?: OperationExecutionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error !== undefined) reject(error);
        else resolve(response as OperationExecutionResult);
      };
      const timer = setTimeout(() => finish(new Error('OPERATION_HELPER_TIMEOUT')), this.timeoutMs);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > this.maxFrameBytes) {
          finish(new Error('OPERATION_HELPER_FRAME_TOO_LARGE'));
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const parsed = JSON.parse(buffer.slice(0, newline)) as HelperResponse;
          if ('error' in parsed) finish(new Error(parsed.error));
          else finish(undefined, parsed);
        } catch {
          finish(new Error('OPERATION_HELPER_INVALID_RESPONSE'));
        }
      });
      socket.on('error', () => finish(new Error('OPERATION_HELPER_UNAVAILABLE')));
      socket.on('close', () => finish(new Error('OPERATION_HELPER_DISCONNECTED')));
    });
  }
}
