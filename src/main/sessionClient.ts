import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { NeovimClient } from 'neovim';

/**
 * Neovimと通信するクライアント。npmの `neovim` パッケージの NeovimClient を拡張している。
 * request('nvim_◯◯', 引数) で、Neovimの関数を呼んで結果を待てる。
 *
 * 元の NeovimClient は、Neovimが途中で終了すると呼び出しが返らないまま待ち続けてしまう。
 * そこで、待っている呼び出しを覚えておき、終了やエラーのときにまとめて失敗させる。
 */
/** Settle RPC callers when the child disconnects; neovim's transport leaves them pending. */
export class SessionClient extends NeovimClient {
  private failure?: Error;
  private readonly pending = new Set<(error: Error) => void>();

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    onError: (error: Error) => void
  ) {
    super();
    process.stdin.on('error', (error) => {
      const disconnected = !!this.failure;
      this.cancelRequests(error);
      if (!disconnected) {
        onError(error);
      }
      // A failed writer cannot carry further RPCs, even if the child is still alive.
      process.kill();
    });
    process.on('error', (error) => this.cancelRequests(error));
    process.once('exit', () => this.cancelRequests());
    this.once('disconnect', () => this.cancelRequests());
    this.attach({ reader: process.stdout, writer: process.stdin });
  }

  // RPCを1つ送る。返事が来るまで pending に入れておき、Neovimが落ちたら cancelRequests で失敗させる。
  override asyncRequest(name: string, args: unknown[] = []): ReturnType<NeovimClient['request']> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.pending.add(reject);
      const finish = (error: Error | null, result?: unknown): void => {
        this.pending.delete(reject);
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };
      void this._isReady
        .then(() => {
          // Startup readiness is asynchronous: check again immediately before writing.
          if (this.failure) {
            finish(this.failure);
            return;
          }
          this.transport.request(name, args, (error: [number, string] | null, result: unknown) => {
            finish(error ? new Error(`${name}: ${error[1]}`) : null, result);
          });
        })
        .catch((error: Error) => finish(error));
    });
  }

  override notify(name: string, args: unknown[]): void {
    if (this.failure) {
      throw this.failure;
    }
    super.notify(name, args);
  }

  // 待っている呼び出しをすべて失敗させる。これ以降の呼び出しもすぐ失敗するようになる。
  cancelRequests(error = new Error('Neovim session is closed.')): void {
    this.failure ??= error;
    for (const reject of this.pending) {
      reject(this.failure);
    }
    this.pending.clear();
  }

  // Neovimに終了（:qa!）を伝える。
  quit(): void {
    // Shutdown is the sole write allowed after cancelling regular RPC requests.
    if (
      !this.process.stdin.destroyed &&
      this.process.stdin.writable &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    ) {
      super.notify('nvim_command', ['qa!']);
    }
  }
}
