//===----------------------------------------------------------------------===//
// Copyright (c) 2026, Modular Inc. All rights reserved.
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
import * as vscodelc from 'vscode-languageclient/node';
import { CrashCapObserver } from './crashCapObserver';

/// Build a stub ErrorHandler whose closed() returns the given action.
/// error() is a no-op returning Continue since these tests focus on the
/// crash-cap logic in closed().
function stubHandler(closeAction: vscodelc.CloseAction): vscodelc.ErrorHandler {
  return {
    async error() {
      return { action: vscodelc.ErrorAction.Continue };
    },
    async closed() {
      return { action: closeAction };
    },
  };
}

suite('CrashCapObserver', function () {
  test('fires onCappedOut when inner.closed() returns DoNotRestart', async function () {
    let firedCount = 0;
    const observer = new CrashCapObserver(() => firedCount++);
    observer.setInner(stubHandler(vscodelc.CloseAction.DoNotRestart));

    const result = await observer.closed();

    assert.strictEqual(firedCount, 1);
    assert.strictEqual(result.action, vscodelc.CloseAction.DoNotRestart);
  });

  test('does not fire onCappedOut when inner.closed() returns Restart', async function () {
    let firedCount = 0;
    const observer = new CrashCapObserver(() => firedCount++);
    observer.setInner(stubHandler(vscodelc.CloseAction.Restart));

    const result = await observer.closed();

    assert.strictEqual(firedCount, 0);
    assert.strictEqual(result.action, vscodelc.CloseAction.Restart);
  });

  test('fires onCappedOut once per DoNotRestart response, across multiple calls', async function () {
    let firedCount = 0;
    const observer = new CrashCapObserver(() => firedCount++);
    // Inner behaves like the real cap: Restart the first few times, then
    // DoNotRestart on the Nth close.
    let closeCount = 0;
    observer.setInner({
      async error() {
        return { action: vscodelc.ErrorAction.Continue };
      },
      async closed() {
        closeCount++;
        return {
          action:
            closeCount <= 4
              ? vscodelc.CloseAction.Restart
              : vscodelc.CloseAction.DoNotRestart,
        };
      },
    });

    for (let i = 0; i < 5; i++) {
      await observer.closed();
    }

    // 4 Restarts + 1 DoNotRestart => callback fires exactly once.
    assert.strictEqual(firedCount, 1);
  });

  test('passes through error() to inner and returns its result', async function () {
    const received: Array<{ error: Error; count: number | undefined }> = [];
    const observer = new CrashCapObserver(() => {
      /* not expected to fire from error() */
    });
    observer.setInner({
      async error(e, _m, count) {
        received.push({ error: e, count });
        return { action: vscodelc.ErrorAction.Shutdown };
      },
      async closed() {
        return { action: vscodelc.CloseAction.Restart };
      },
    });

    const err = new Error('boom');
    const result = await observer.error(err, undefined, 7);

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].error, err);
    assert.strictEqual(received[0].count, 7);
    assert.strictEqual(result.action, vscodelc.ErrorAction.Shutdown);
  });

  test('safe defaults when setInner has not been called', async function () {
    // If closed() fires before setInner has run (shouldn't happen in
    // practice, but the safety net matters), default to DoNotRestart so
    // the user still sees the crash-cap UI rather than an infinite
    // restart loop.
    let firedCount = 0;
    const observer = new CrashCapObserver(() => firedCount++);

    const result = await observer.closed();

    assert.strictEqual(result.action, vscodelc.CloseAction.DoNotRestart);
    assert.strictEqual(firedCount, 1);
  });

  test('error() defaults to Continue when setInner has not been called', async function () {
    const observer = new CrashCapObserver(() => {
      /* not expected */
    });

    const result = await observer.error(new Error('boom'), undefined, 1);

    assert.strictEqual(result.action, vscodelc.ErrorAction.Continue);
  });
});
