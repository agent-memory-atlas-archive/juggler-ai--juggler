//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { extractErrorMessage } from '../../../sdk/lib/error-utils.js';

/**
 * Duplicate Conversation command — clone the current conversation into a new
 * conversation placed directly after the source, then switch to the clone. The source
 * is left intact.
 *
 * Duplication is refused while a turn is active (see
 * `Session.duplicateConversation`): a mid-turn clone can't be flushed without
 * hanging on the worker, and silently cancelling the turn to allow it would
 * discard the user's in-flight work. The session surfaces the refusal as a
 * warning, so this command only adds its own message for genuine failures.
 *
 * Tab management is a Session concern, so the command reaches the session
 * through `messageThread.conversation.session`. "Duplicate then compact" is
 * `/duplicate` followed by `/compact`; there is no combined command.
 */
class DuplicateConversationCommandType extends CommandType {
  static MANIFEST = {
    id: 'duplicate',
    name: 'Duplicate Conversation',
    version: '1.0.0',
    description: 'Clone this conversation into a new one',
    icon: 'icon-box'
  };

  /**
   * Execute the duplicate command
   * @param {string[]} _args - Command arguments (unused)
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(_args) {
    const sourceConversation = this.messageThread?.conversation;
    const session = sourceConversation?.session;
    if (!session) {
      return { handled: true, message: 'No session available', error: true };
    }

    try {
      const newId = await session.duplicateConversation(sourceConversation.id);
      if (!newId) {
        // A null clone means the source vanished (plain duplicate forks even a
        // running conversation, so there's no mid-turn refusal here). Treat as
        // handled (not an error) so the slash handler stays quiet.
        return { handled: true };
      }
      session.switchConversation(newId);
      return { handled: true };
    } catch (error) {
      return {
        handled: true,
        message: `Duplication failed: ${extractErrorMessage(error)}`,
        error: true
      };
    }
  }
}

export default DuplicateConversationCommandType;
