/**
 * The agent loop: route each step, call the model, run its tools, and repeat
 * until the model answers without tools or a limit stops the turn.
 */
import type { Message, ModelRef, RoutePreference, StopReason } from '@switchback/protocol';
import { type ChatEvent, type Provider, ProviderError, type ToolSpec } from '@switchback/providers';
import {
  type Difficulty,
  ladderSteps,
  type ModelInfo,
  type Router,
  stepOf,
} from '@switchback/router';
import type { AgentDefinition } from './agents.ts';
import { classifyPrompt } from './classifier.ts';
import { contextOf } from './compaction.ts';
import type { Compactor } from './compactor.ts';
import { estimateEscalationCost } from './estimate.ts';
import type { UsageLedger } from './ledger.ts';
import { type EngineHost, type LiveSession, scope } from './live-session.ts';
import { allowsMcpTool, type McpHub } from './mcp/hub.ts';
import type { ModelDirectory } from './model-directory.ts';
import { redactOutbound } from './privacy.ts';
import { PendingPrompts } from './prompts.ts';
import type { Subagents } from './subagents.ts';
import type { Interaction, ToolRunner } from './tool-runner.ts';
import { toolSpec, toolsFor } from './tools/index.ts';

export interface AgentLoopDeps {
  models: ModelDirectory;
  tools: ToolRunner;
  compactor: Compactor;
  subagents: Subagents;
  ledger: UsageLedger;
  router(s: LiveSession): Router;
  agent(name: string): AgentDefinition | undefined;
  agents(): AgentDefinition[];
  mcp(): McpHub | undefined;
  interaction(): Interaction;
}

type Done = Extract<ChatEvent, { type: 'done' }>;

export class AgentLoop {
  readonly escalations = new PendingPrompts<boolean>('escalation');

  constructor(
    private readonly host: EngineHost,
    private readonly deps: AgentLoopDeps,
  ) {}

  async run(
    s: LiveSession,
    preference: RoutePreference,
    turnId: string,
    signal: AbortSignal,
  ): Promise<StopReason> {
    const { models, ledger } = this.deps;
    const config = () => this.host.config();
    // The first turn waits for MCP servers, so the tool list is complete and stable.
    const mcp = this.deps.mcp();
    if (mcp) await Promise.race([mcp.ready, Bun.sleep(20_000)]);
    const { agent, tools, catalog, specs, specsJson } = this.toolSetup(s);
    let escalationApproved = false;
    let forceLocal = false;
    /** Remote aliases that refused this turn, and whether the next call retries one. */
    const refused: string[] = [];
    let refusalRetry = false;
    /** Used by the first routing decision of the turn only. */
    let difficulty = await this.classify(s, preference, agent, signal);
    let failures = 0;

    for (let step = 0; step < config().maxStepsPerTurn; step++) {
      if (signal.aborted) return 'cancelled';
      await models.refreshHealth(signal);
      this.deps.subagents.drainInbox(s);
      if (config().compaction.enabled) {
        // A failed summary costs context, not the turn: routing still has
        // overflow escalation to fall back on.
        await this.deps.compactor.compact(s, specsJson, signal, false, turnId).catch((err) => {
          if (!signal.aborted)
            this.host.notify('warn', `compaction failed: ${(err as Error).message}`);
        });
      }

      const inputTokens = await models.countPrompt(
        s.header.system,
        contextOf(s.messages),
        specsJson,
        signal,
      );
      const signals = s.signals.snapshot();
      const budget = this.deps.subagents.invocationBudget(s);
      const decision = this.deps.router(s).decide({
        preference,
        escalationDeclined: forceLocal,
        refused,
        refusalRetry,
        ...(difficulty ? { difficulty } : {}),
        ...(await this.privacyOf(s)),
        ...(budget ? { invocationBudget: budget } : {}),
        agent: { name: agent.name, route: agent.route, ...this.pinnedModel(s, agent) },
        estimatedInputTokens: inputTokens,
        signals,
        spend: ledger.spend(),
        escalationApproved,
      });

      if (decision.kind === 'block') {
        const org = this.host.org();
        s.lastError =
          org?.remoteDisabled && preference === 'remote'
            ? `remote models are disabled by ${org.name} policy`
            : `cannot route turn: ${decision.reason}`;
        this.host.emit({ type: 'error', ...scope(s), turnId, message: s.lastError });
        return 'error';
      }
      if (decision.kind === 'ask') {
        const estimate = estimateEscalationCost({
          price: ledger.priceOf(decision.target.ref.model),
          inputTokens,
          outputTokens: ledger.meanOutputTokens(s.header.id),
          calls: 1 + config().routing.escalation.stickyTurns,
        });
        const approved = await this.askEscalation(
          s,
          decision.target.ref,
          decision.reason,
          estimate,
          signal,
        );
        escalationApproved = approved;
        forceLocal = !approved;
        step--;
        continue;
      }

      refusalRetry = false;
      difficulty = undefined;
      const { model, rule, reason, escalated } = decision;
      this.host.emit({
        type: 'route.decided',
        ...scope(s),
        turnId,
        tier: model.tier,
        model: model.ref,
        rule,
        reason,
        inputTokens,
        step: decision.step,
        steps: this.host.rolesOf(s).escalate.length,
        ...(decision.step > 0 && !escalated ? { stickyTurns: signals.stickyTurns } : {}),
        ...(escalated ? { stickyTurns: config().routing.escalation.stickyTurns } : {}),
      });

      const provider = models.provider(model.ref.provider);
      if (!provider) throw new Error(`provider "${model.ref.provider}" is not configured`);
      let done: Done;
      try {
        done = await this.call(s, provider, model, specs, inputTokens, turnId, signal);
      } catch (err) {
        if (signal.aborted) return 'cancelled';
        if (err instanceof ProviderError && err.retryable) models.markDown(model.ref.provider);
        s.signals.recordFailure();
        this.host.notify('warn', `${model.alias} failed: ${(err as Error).message}`);
        if (++failures > 2) throw err;
        continue; // re-route: the router sees the failure and escalates or falls back
      }

      // A provider-side fallback may have answered with a different model; bill that one.
      const servedBy = done.model && done.model !== model.ref.model ? done.model : undefined;
      if (servedBy)
        this.host.notify(
          'info',
          `${model.ref.model} declined; ${model.ref.provider} answered with ${servedBy}`,
        );
      this.host.recordUsage(
        s,
        model.tier,
        servedBy ? { ...model.ref, model: servedBy } : model.ref,
        done.usage,
        { rule, agent: agent.name },
      );
      s.signals.recordTurn(decision.step, escalated);
      escalationApproved = false;

      const toolCalls = done.parts.filter((p) => p.type === 'tool_call');
      const truncatedTools = done.stopReason === 'max_tokens' && toolCalls.length > 0;

      // A remote refusal is retried on another model of the same step or above,
      // if there is one. The refused output is discarded, not added to the transcript.
      if (
        model.tier === 'remote' &&
        done.stopReason === 'refusal' &&
        this.canRetry(s, model, refused)
      ) {
        refused.push(model.alias);
        refusalRetry = true;
        continue;
      }

      // A model that refuses (a local one) or runs out of room mid-tool-call gets
      // another chance one step up instead of ending the user's turn.
      if ((model.tier === 'local' && done.stopReason === 'refusal') || truncatedTools) {
        s.signals.recordFailure();
        if (++failures <= 2) continue;
      }

      const meta = { model: model.ref, tier: model.tier, routeReason: reason };
      if (truncatedTools) {
        // Never run tools whose input was cut off.
        this.host.append(s, {
          role: 'assistant',
          parts: done.parts.filter((p) => p.type !== 'tool_call'),
          meta,
        });
        return 'max_tokens';
      }
      this.host.append(s, { role: 'assistant', parts: done.parts, meta });
      if (toolCalls.length === 0)
        return done.stopReason === 'tool_use' ? 'end_turn' : done.stopReason;

      const results = await this.deps.tools.run(
        s,
        tools,
        catalog,
        toolCalls,
        turnId,
        signal,
        model.alias,
      );
      this.host.append(s, { role: 'user', parts: results });
      if (signal.aborted) return 'cancelled';
    }
    this.host.emit({
      type: 'error',
      ...scope(s),
      turnId,
      message: `stopped after ${config().maxStepsPerTurn} steps`,
    });
    return 'max_tokens';
  }

  /** The agent's tools and their specs for a session; fixed order keeps the cache prefix stable. */
  toolSetup(s: LiveSession) {
    const agent = this.deps.agent(s.header.agent);
    if (!agent) throw new Error(`agent "${s.header.agent}" no longer exists`);
    const config = this.host.config();
    const canDelegate = s.depth < config.subagents.maxDepth;
    const mcpTools = (this.deps.mcp()?.tools() ?? []).filter(
      (t) => !agent.tools || allowsMcpTool(agent.tools, t.name),
    );
    // Built-ins first in their fixed order, then MCP tools by name: a stable cache prefix.
    const tools = [...toolsFor(agent.tools), ...mcpTools].filter(
      (t) => t.name !== 'task' || canDelegate,
    );
    const catalog = this.deps
      .agents()
      .filter((a) => a.name !== s.header.agent || s.depth === 0)
      .map((a) => ({ name: a.name, description: a.description }));
    const specs = tools.map((t) => toolSpec(t, { agentCatalog: catalog }));
    return { agent, tools, catalog, specs, specsJson: JSON.stringify(specs) };
  }

  /** One streamed model call; deltas go out as events, the result comes back. */
  private async call(
    s: LiveSession,
    provider: Provider,
    model: ModelInfo,
    specs: ToolSpec[],
    inputTokens: number,
    turnId: string,
    signal: AbortSignal,
  ): Promise<Done> {
    const effort = this.host.config().models[model.alias]?.effort;
    // A fresh array (so providers never observe later appends), built from
    // the latest compaction marker; for remote models, with secrets redacted.
    const outbound = await this.outbound(s, model, s.header.system, contextOf(s.messages));
    let done: Done | undefined;
    for await (const ev of provider.stream({
      model: model.ref.model,
      system: outbound.system,
      messages: outbound.messages,
      tools: specs,
      maxTokens: this.deps.models.outputBudget(model.alias, inputTokens),
      ...(effort ? { effort } : {}),
      signal,
    })) {
      if (ev.type === 'text.delta')
        this.host.emit({ type: 'text.delta', ...scope(s), turnId, text: ev.text });
      else if (ev.type === 'reasoning.delta')
        this.host.emit({ type: 'reasoning.delta', ...scope(s), turnId, text: ev.text });
      else done = ev;
    }
    if (!done) throw new Error(`${provider.id} ended the stream without a result`);
    return done;
  }

  /** Another configured model at this step or above that hasn't refused this turn. */
  private canRetry(s: LiveSession, model: ModelInfo, refused: string[]): boolean {
    const { models } = this.host.config();
    const roles = this.host.rolesOf(s);
    return ladderSteps(roles)
      .slice(stepOf(roles, model.alias))
      .flat()
      .some((a) => a !== model.alias && !refused.includes(a) && models[a]);
  }

  /** The agent's own model pin; for a subagent without one, the subagent model. */
  private pinnedModel(s: LiveSession, agent: AgentDefinition): { model?: string } {
    if (agent.model) return { model: agent.model };
    const fallback = this.host.rolesOf(s).subagents;
    return s.depth > 0 && agent.route === 'auto' && fallback ? { model: fallback } : {};
  }

  /**
   * Rate the new prompt with the configured classifier, when its answer could
   * change anything: automatic routing, no pins, not already sticky, and a
   * step to escalate to. A remote classifier follows the remote rules.
   */
  private async classify(
    s: LiveSession,
    preference: RoutePreference,
    agent: AgentDefinition,
    signal: AbortSignal,
  ): Promise<Difficulty | undefined> {
    const config = this.host.config();
    const c = config.routing.classifier;
    if (!c || preference !== 'auto') return undefined;
    if (agent.model || agent.route !== 'auto' || s.signals.snapshot().stickyTurns > 0)
      return undefined;
    // Nothing to escalate to.
    const ladder = this.host.rolesOf(s).escalate.flat();
    if (!ladder.some((a) => config.models[a])) return undefined;
    const model = this.deps.models.info(c.model);
    if (!model) {
      this.host.notify('warn', `routing.classifier.model "${c.model}" is not a configured model`);
      return undefined;
    }
    // A remote classifier reads the prompt, so the remote rules apply to it.
    if (model.tier === 'remote' && this.host.remoteBlocked(s)) return undefined;
    if (!model.available) return undefined;
    const provider = this.deps.models.provider(model.ref.provider);
    const prompt = s.messages.findLast(
      (m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && !p.attachment),
    );
    if (!provider || !prompt) return undefined;
    const text = prompt.parts
      .flatMap((p) => (p.type === 'text' && !p.attachment ? [p.text] : []))
      .join('\n');
    const r = await classifyPrompt(provider, model.ref.model, text, {
      signal,
      timeoutMs: c.timeoutMs,
    });
    if (r.usage)
      this.host.recordUsage(s, model.tier, model.ref, r.usage, {
        rule: 'classify',
        agent: agent.name,
      });
    this.host.notify(
      'debug',
      r.difficulty
        ? `classifier: ${r.difficulty.level} in ${Math.round(r.ms)}ms (${r.difficulty.reason})`
        : `classifier: no rating in ${Math.round(r.ms)}ms`,
    );
    return r.difficulty;
  }

  private async askEscalation(
    s: LiveSession,
    target: ModelRef,
    reason: string,
    estimatedCostUsd: number | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    // Headless runs never spend money they were not told they could spend.
    if (this.deps.interaction() !== 'prompt') return false;
    const requestId = `esc_${crypto.randomUUID().slice(0, 8)}`;
    const approved = await this.escalations.ask(requestId, signal, false, () =>
      this.host.emit({
        type: 'escalation.requested',
        ...scope(s),
        requestId,
        reason,
        target,
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
      }),
    );
    this.host.emit({ type: 'escalation.resolved', ...scope(s), requestId, approved });
    return approved;
  }

  /**
   * Why this session must stay local: private content in it, or (with
   * `privacy.secrets: block`) a secret in what would be sent.
   */
  private async privacyOf(s: LiveSession): Promise<{ privacy?: { reason: string } }> {
    if (s.private) return { privacy: { reason: s.private } };
    if (this.host.config().privacy.secrets !== 'block') return {};
    const { found } = await redactOutbound(s.header.system, contextOf(s.messages));
    return found.length
      ? { privacy: { reason: `the conversation contains a secret (${found[0]})` } }
      : {};
  }

  /** What a model is sent: for remote models, with secrets redacted (`privacy.secrets`). */
  private async outbound(
    s: LiveSession,
    model: ModelInfo,
    system: string,
    messages: Message[],
  ): Promise<{ system: string; messages: Message[] }> {
    if (model.tier !== 'remote' || this.host.config().privacy.secrets !== 'redact')
      return { system, messages };
    const r = await redactOutbound(system, messages);
    // Each request resends the conversation; report only when more are found.
    if (r.found.length > (s.redacted ?? 0))
      this.host.emit({ type: 'secrets.redacted', ...scope(s), kinds: r.found, model: model.ref });
    s.redacted = r.found.length;
    return r;
  }
}
