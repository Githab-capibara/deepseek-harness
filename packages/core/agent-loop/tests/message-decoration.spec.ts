import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type GenerateOptions, type Message, type RequestMessage } from '@deepseek-ai/dsh-llm'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { type Session, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'

import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

import { MockAdapter, textResponse } from './mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'decoration': { kind: 'decoration' }
  }
}

/**
 * The optional `modelMessageDecoration` seam: a provider decorates each request,
 * may rewrite committed assistant messages, and reports token overhead. A request
 * with no provider registered is unchanged.
 */

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function requestText(request: GenerateOptions): string {
  return request.messages.flatMap(message => message.content)
    .map(block => block.type === 'text' ? block.text : '').join('')
}

function anchor(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'decoration' } })
}

describe('modelMessageDecoration seam', () => {
  it('adds an anchor to the request without touching the session log', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.provide('modelMessageDecoration', {
      decorate: (_session: Session, messages: readonly RequestMessage[]) => [anchor('DUTY TABLE'), ...messages],
    })
    const agent = await ctx.agentLoop.create(brandString<SessionId>('decorate'), { provider: 'mock', model: 'mock' })
    send(agent, 'hello')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(requestText(adapter.requests[0]!)).toContain('DUTY TABLE')
    const durable = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(durable).toHaveLength(1)
  })

  it('leaves the request unchanged when no provider is registered', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(brandString<SessionId>('plain'), { provider: 'mock', model: 'mock' })
    send(agent, 'hello')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    const text = requestText(adapter.requests[0]!)
    expect(text).toContain('hello')
    expect(text).not.toContain('DUTY TABLE')
  })

  it('sanitizes a committed assistant message before the session append', async () => {
    const adapter = new MockAdapter([textResponse('secret payload')])
    const ctx = await harness(adapter)
    const sanitized: string[] = []
    ctx.provide('modelMessageDecoration', {
      decorate: (_session: Session, messages: readonly RequestMessage[]) => messages,
      sanitizeAssistantMessage: (_session: Session, message: Message) => {
        sanitized.push(message.id)
        return {
          ...message,
          content: message.content.map(block => block.type === 'text' ? { ...block, text: '[redacted]' } : block),
        }
      },
    })
    const agent = await ctx.agentLoop.create(brandString<SessionId>('sanitize'), { provider: 'mock', model: 'mock' })
    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(sanitized).toHaveLength(1)
    const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(assistant?.type === 'assistant/message' && assistant.data.message.content).toEqual([{ type: 'text', text: '[redacted]' }])
  })

  it('adds the reported decoration overhead to the token measurement', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.provide('modelMessageDecoration', {
      decorate: (_session: Session, messages: readonly RequestMessage[]) => messages,
      tokenOverhead: (_session: Session) => 128,
    })
    const agent = await ctx.agentLoop.create(brandString<SessionId>('meter'), { provider: 'mock', model: 'mock' })
    send(agent, 'hello')
    await waitForIdle(ctx, agent)
    const service = ctx.get('tokenMeter')
    expect(service).toBeDefined()
    const measurement = service!.measure(agent.session) as { totalTokens: number; decorationOverheadTokens: number }
    expect(measurement.decorationOverheadTokens).toBe(128)
    expect(measurement.totalTokens).toBeGreaterThan(0)
  })
})
