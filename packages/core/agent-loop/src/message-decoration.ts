/**
 * Optional request-message decoration seam (local patch, not part of the
 * released harness).
 *
 * A provider registers itself as `modelMessageDecoration`; the agent loop asks
 * it to transform the exact messages derived from the Session surface
 * immediately before they are frozen and sent. An absent provider leaves the
 * request byte-identical (no-op). Decoration is presentation only: it never
 * writes the Session log, and the decorated text must be a deterministic
 * function of the log plus the provider's own rules.
 *
 * @module dsh-agent-loop/message-decoration
 */

import type { AssistantMessage, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Request-message decoration service, read optionally as
 * `ctx.get('modelMessageDecoration')`.
 */
export interface ModelMessageDecorationService {
  /**
   * Decorate the exact request messages for one model call.
   * @param session - Session whose surface produced the messages.
   * @param messages - derived request messages, in request order; entries are shared frozen objects.
   * @returns replacement messages in the same order; throwing fails the request.
   */
  decorate(session: Session, messages: readonly RequestMessage[]): RequestMessage[]

  /**
   * Estimated request tokens the decoration adds. The token meter adds this
   * only to heuristic baselines, because provider usage already contains the
   * decorated request text.
   * @param session - Session whose current surface is priced.
   * @returns presentation-only tokens, e.g. anchor prefixes and suffixes.
   */
  tokenOverhead?(session: Session): number

  /**
   * Sanitize an assistant message immediately before it is committed.
   * @param session - Session receiving the message.
   * @param message - assistant message about to be appended.
   * @returns replacement message; throwing fails the turn.
   */
  sanitizeAssistantMessage?(session: Session, message: AssistantMessage): AssistantMessage
}
