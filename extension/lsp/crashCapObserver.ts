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

import * as vscodelc from 'vscode-languageclient/node';
import { Message } from 'vscode-languageserver-protocol';

/// Wraps the language client's default error handler so we can observe when
/// the library's crash cap fires (i.e. `closed()` returns `DoNotRestart`).
/// The library's cap policy is a private decision otherwise — no event
/// surfaces it — so intercepting the handler is the only way to distinguish
/// "stopped after crash cap" from "stopped for another reason" in the UI.
export class CrashCapObserver implements vscodelc.ErrorHandler {
  private inner?: vscodelc.ErrorHandler;

  constructor(private readonly onCappedOut: () => void) {}

  /// Called after the client is constructed to install the real handler
  /// (the default handler is a method on the client, which doesn't exist
  /// at the time clientOptions.errorHandler must be set).
  setInner(handler: vscodelc.ErrorHandler) {
    this.inner = handler;
  }

  async error(
    error: Error,
    message: Message | undefined,
    count: number | undefined,
  ): Promise<vscodelc.ErrorHandlerResult> {
    return (
      (await this.inner?.error(error, message, count)) ?? {
        action: vscodelc.ErrorAction.Continue,
      }
    );
  }

  async closed(): Promise<vscodelc.CloseHandlerResult> {
    const result = (await this.inner?.closed()) ?? {
      action: vscodelc.CloseAction.DoNotRestart,
    };
    if (result.action === vscodelc.CloseAction.DoNotRestart) {
      this.onCappedOut();
    }
    return result;
  }
}
