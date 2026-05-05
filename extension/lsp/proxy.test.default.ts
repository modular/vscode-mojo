//===----------------------------------------------------------------------===//
// Copyright (c) 2025, Modular Inc. All rights reserved.
//
// Licensed under the Apache License v2.0 with LLVM Exceptions:
// https://llvm.org/LICENSE.txt
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//===----------------------------------------------------------------------===//

import * as assert from 'assert';
import * as path from 'path';

// We load the compiled proxy implementation because the extension test build
// cannot import the proxy sources directly from the referenced TS project.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MojoLSPServer } = require('../../lsp-proxy/out/MojoLSPServer') as {
  MojoLSPServer: new (args: {
    initializationOptions: {
      serverArgs: string[];
      serverEnv: NodeJS.ProcessEnv;
      serverPath: string;
    };
    logger: (message: string) => void;
    onExit: (status: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
    onNotification: (method: string, params: unknown) => void;
    onOutgoingRequest: (id: unknown, method: string, params: unknown) => void;
  }) => {
    dispose(): void;
    sendNotification(params: unknown, method: string): void;
    sendRequest(params: unknown, method: string): Promise<unknown>;
  };
};

async function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function createServer() {
  const fakeServerScript = path.join(
    __dirname,
    '..',
    '..',
    'extension',
    'test',
    'fake-lsp-server.js',
  );

  return new MojoLSPServer({
    initializationOptions: {
      serverArgs: [fakeServerScript],
      serverEnv: process.env,
      serverPath: process.execPath,
    },
    logger: () => {},
    onExit: () => {},
    onNotification: () => {},
    onOutgoingRequest: () => {},
  }) as any;
}

suite('LSP Proxy', function () {
  test('sendRequest should handle immediate responses', async function () {
    const server = createServer();

    try {
      const result = (await withTimeout(
        server.sendRequest({ value: 1 }, 'test/immediate'),
        5000,
        'immediate response request',
      )) as { method: string; params: { value: number } };

      assert.strictEqual(result.method, 'test/immediate');
      assert.deepStrictEqual(result.params, { value: 1 });
    } finally {
      server.dispose();
    }
  });

  test('sendNotification should block later writes until its write callback finishes', async function () {
    const server = createServer();
    const stdin = server.serverProcess.stdin;
    const originalWrite = stdin.write.bind(stdin);
    const queuedWrites: Array<{
      chunk: string | Uint8Array;
      callback?: () => void;
    }> = [];

    let writeCount = 0;
    let secondWriteBeforeRelease = false;
    let firstWriteReleased = false;
    let releaseFirstWrite!: () => void;

    stdin.write = (
      chunk: string | Uint8Array,
      callback?: (() => void) | BufferEncoding,
      maybeCallback?: () => void,
    ) => {
      const resolvedCallback =
        typeof callback === 'function' ? callback : maybeCallback;

      writeCount += 1;
      if (writeCount === 1) {
        releaseFirstWrite = () => {
          firstWriteReleased = true;
          originalWrite(chunk, () => {
            resolvedCallback?.();
            for (const queuedWrite of queuedWrites) {
              originalWrite(queuedWrite.chunk, queuedWrite.callback);
            }
            queuedWrites.length = 0;
          });
        };
        return true;
      }

      if (firstWriteReleased) {
        return originalWrite(chunk, resolvedCallback);
      }

      secondWriteBeforeRelease = true;
      queuedWrites.push({ chunk, callback: resolvedCallback });
      return true;
    };

    try {
      server.sendNotification(
        {
          textDocument: { uri: 'file:///test.mojo', version: 1 },
          contentChanges: [],
        },
        'textDocument/didChange',
      );

      const pendingCompletion = withTimeout(
        server.sendRequest(
          {
            textDocument: { uri: 'file:///test.mojo' },
            position: { line: 0, character: 0 },
          },
          'textDocument/completion',
        ),
        5000,
        'completion request',
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.strictEqual(
        secondWriteBeforeRelease,
        false,
        'request write started before the earlier notification write finished',
      );

      releaseFirstWrite();
      await pendingCompletion;
    } finally {
      stdin.write = originalWrite;
      server.dispose();
    }
  });
});
