import { isBrowserRuntime } from './runtime';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export const vscode: { postMessage(msg: unknown): void } = isBrowserRuntime
  ? {
      postMessage: (msg: unknown) => {
        console.log('[vscode.postMessage]', msg);
        void fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg),
        }).catch(() => {
          // Browser mock mode without a standalone backend.
        });
      },
    }
  : (acquireVsCodeApi() as { postMessage(msg: unknown): void });
