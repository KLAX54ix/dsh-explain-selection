/**
 * Host half of the explain-selection bundle.
 *
 * One authenticated Fetch route streams a plain-language explanation of a
 * user-selected fragment. The call goes straight to `ctx.llm`, so it never
 * becomes a Turn, a Message, or a Session event: the main conversation context
 * is untouched, which is the whole point of the plugin.
 *
 * Contract mirrors the shipped `/api/session.export` owner
 * (`@deepseek-ai/dsh-session-log-export`): `ctx.connection.fetch.register`
 * takes the absolute pathname, while the browser addresses the
 * document-relative form (leading slash stripped).
 */

/** Absolute pathname the Host registers; the browser fetches `api/explain.selection`. */
const ROUTE_PATH = '/api/explain.selection';

/**
 * Guard rails. This is an inline, instant-learning lookup: both the input we
 * accept and the output we allow are deliberately small, because latency and
 * token spend are the product here.
 */
const MAX_INPUT_CHARS = 400;
const MAX_OUTPUT_TOKENS = 256;
/** Surrounding prose sent for disambiguation, and the enclosing term of a nested lookup. */
const MAX_CONTEXT_CHARS = 400;
const MAX_PARENT_CHARS = 120;

/**
 * Explanation policy, kept short on purpose: every token here is input cost on
 * every single lookup. The bracket marker gives the Client half a
 * machine-readable hook for turning unavoidable jargon into clickable terms.
 *
 * Rule order is load-bearing:
 *
 * - The "is this even a word" check comes first. An earlier version opened with
 *   "先判断这个词在【原文片段】里指什么", which *presupposes* that the selection
 *   is a word. Selecting 动工 out of 浮动工具条 — two characters straddling a word
 *   boundary — then produced a fluent, confident, entirely invented meaning
 *   lifted from the surrounding code talk. Refusing is the correct answer there.
 * - The contextual reading comes next, and no rule asks for "what it is" in the
 *   abstract: an earlier wording said "先说它是什么", which is a dictionary
 *   instruction, and it overrode the context rule.
 */
const SYSTEM_PROMPT = [
  '你在给中文读者做即时讲解。硬性要求：',
  '1. 先判断选中的文字是不是一个独立的中文词或术语。若它只是跨词边界的片段、代码标识符或不成词，直接说明它不是一个词，并指出它原本属于哪个词；严禁为它编造含义。',
  '2. 是词时，有【原文片段】就按它判断它在这里指什么，只讲这个意思，不要罗列别的含义。',
  '3. 两句话以内，最多 80 字，宁短勿长。',
  '4. 只用日常汉语；必须用到新术语时写成 [[术语]]。',
  '5. 线索不足就直说，不要假装确定。',
].join('\n');

export const name = 'explain-selection';

/**
 * `connection` owns the authenticated Fetch carrier; `llm` performs the call.
 * `agentDefaultModel` is read optionally so the plugin still activates (and can
 * report a precise error) in a profile that has no default model service.
 */
export const inject = ['connection', 'llm'];

/**
 * Register the streaming explanation route.
 * @param ctx - Host context carrying the Connection and LLM services.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => respond(ctx, request),
    });
    return () => {
      void dispose();
    };
  }, 'explain-selection: route');
}

/**
 * Answer one explanation request as an NDJSON stream of `{type:'delta'|'error'}` lines.
 * @param ctx - Host context.
 * @param request - admitted WHATWG Request; its signal aborts with the browser fetch.
 * @returns a streaming Response, or a plain JSON error Response before streaming starts.
 */
async function respond(ctx, request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonError(400, '请求体必须是 JSON。');
  }

  const raw = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (raw.length === 0) return jsonError(400, '没有收到要解释的文本。');
  // Bound input cost: a lookup of a term or a clause never needs the paragraph.
  const text = clip(raw, MAX_INPUT_CHARS);

  // Disambiguation inputs. `context` is the prose around a top-level selection;
  // `parent` is the term of the card a nested lookup came from. Both are
  // caller-supplied, so both are capped no matter what the client sends.
  const context = payload?.context === undefined ? '' : clip(asText(payload.context), MAX_CONTEXT_CHARS);
  const parent = payload?.parent === undefined ? '' : clip(asText(payload.parent), MAX_PARENT_CHARS);

  const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
  const provider = selection?.provider;
  const model = selection?.model;
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
    return jsonError(400, '当前没有可用的默认模型，请先在设置里选择一个模型。');
  }

  const prompt = buildPrompt({ text, context, parent });

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      // A closed card aborts the browser fetch; drop out of the model stream
      // instead of draining tokens the user will never see.
      let disconnected = false;
      const send = (event) => {
        if (disconnected) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          disconnected = true;
        }
      };

      try {
        // Echo what this Host half actually received and put in the prompt.
        // The Client shows it, which is the only way to tell "the model ignored
        // the context" apart from "the context never arrived" — a distinction
        // that decides whether the prompt or the deployment is at fault.
        send({ type: 'meta', contextChars: context.length, parentChars: parent.length });

        const stream = ctx.llm.stream({
          provider,
          model,
          // The DeepSeek adapter defaults to reasoning effort `high` whenever
          // `purpose` is not 'session-title'. That is wrong for a lookup: the
          // reasoning budget is billed against `max_tokens`, so at 512 the
          // answer was truncated on every call and the call was slow and
          // expensive. `off` sends `thinking: disabled` and costs nothing.
          reasoningEffort: 'off',
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: MAX_OUTPUT_TOKENS,
          signal: request.signal,
        });

        for await (const chunk of stream) {
          if (disconnected) break;
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
            send({ type: 'delta', text: chunk.text });
            continue;
          }
          if (chunk?.type === 'finish') {
            const reason = chunk.reason;
            if (reason?.kind === 'error' || reason?.kind === 'aborted') {
              send({ type: 'error', message: reason.failure?.message ?? '模型调用失败。' });
            } else if (reason?.kind === 'max-tokens') {
              send({ type: 'error', message: '已达到长度上限，内容被截断。' });
            }
          }
        }
      } catch (error) {
        send({ type: 'error', message: errorMessage(error) });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed or cancelled */
        }
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Build a non-streaming JSON error response.
 * @param status - HTTP status code.
 * @param message - human-readable reason shown inside the card.
 * @returns the Response to return from the route.
 */
function jsonError(status, message) {
  return new Response(`${JSON.stringify({ error: message })}\n`, {
    status,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Build the user turn: optional disambiguating context, then the fragment.
 *
 * The labels are part of the prompt contract — rule 5 tells the model to read
 * the sense of the term out of 【原文片段】 rather than reciting a dictionary entry.
 * @param input - the fragment plus whatever context the Client could supply.
 * @returns the single user message text.
 */
function buildPrompt(input) {
  const lines = [];
  if (input.context.length > 0) lines.push(`【原文片段】${input.context}`);
  if (input.parent.length > 0) lines.push(`【你正在读的解释】${input.parent}`);
  lines.push(`【要解释的】${input.text}`);
  return lines.join('\n');
}

/**
 * Coerce a caller-supplied value to text.
 * @param value - anything the request body carried.
 * @returns a string, never a non-string.
 */
function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Bound one caller-supplied field.
 * @param value - the text to clip.
 * @param limit - maximum characters to keep.
 * @returns the text, clipped.
 */
function clip(value, limit) {
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Render an unknown thrown value as text.
 * @param error - the thrown value.
 * @returns its message when it has one.
 */
function errorMessage(error) {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}
