/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { addReaction, sendMessage } from './core.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('add_reaction MCP tool — platform message id resolution', () => {
  /** Seed a messages_in row the way the router writes it: row id is
   *  `<platform message id>:<agent group id>` (messageIdForAgent). */
  function seedInbound(seq: number, id: string, content: Record<string, unknown>): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES (?, ?, 'chat-sdk', ?, 'completed', 'telegram:12345', 'telegram', 'telegram:12345', ?)`,
      )
      .run(id, seq, new Date().toISOString(), JSON.stringify(content));
  }

  it('reacts to an inbound user message with the platform id from its content', async () => {
    seedInbound(4, '88:ag-main', { id: '88', text: 'please deploy', author: { userId: 'u1' } });

    const result = await addReaction.handler({ messageId: 4, emoji: 'eyes' });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toEqual({ operation: 'reaction', messageId: '88', emoji: 'eyes' });
    // Routing copied from the inbound row so the reaction lands in the same chat.
    expect(out[0].channel_type).toBe('telegram');
    expect(out[0].platform_id).toBe('telegram:12345');
    expect(out[0].thread_id).toBe('telegram:12345');
  });

  it('falls back to stripping the router suffix when content carries no platform id', async () => {
    seedInbound(4, '88:ag-main', { text: 'please deploy' });

    await addReaction.handler({ messageId: 4, emoji: 'thumbs_up' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toEqual({ operation: 'reaction', messageId: '88', emoji: 'thumbs_up' });
  });

  it('still resolves its own sent messages through the delivered table', async () => {
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
         VALUES ('out-1', 3, ?, 'chat', 'telegram:12345', 'telegram', NULL, '{"text":"done"}')`,
      )
      .run(new Date().toISOString());
    getInboundDb()
      .prepare(`INSERT INTO delivered (message_out_id, platform_message_id, delivered_at) VALUES ('out-1', '999', ?)`)
      .run(new Date().toISOString());

    await addReaction.handler({ messageId: 3, emoji: 'white_check_mark' });

    const out = getUndeliveredMessages().filter((m) => m.id !== 'out-1');
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toEqual({ operation: 'reaction', messageId: '999', emoji: 'white_check_mark' });
  });
});
