/**
 * Strips internal AI framework metadata from the Vercel AI SDK
 * UI Message Stream Protocol before chunks reach the public client.
 *
 * Blocked event types (dropped entirely):
 *   start-step, finish-step       — internal step lifecycle markers
 *   tool-input-start              — leaks toolCallId + thoughtSignature at tool invocation
 *   tool-input-delta              — raw streaming tool arguments
 *   tool-output-available         — raw database/API response payloads
 *
 * Sensitive fields removed from every passing event:
 *   providerMetadata (+ nested thoughtSignature), toolCallId
 *
 * Stream format handled:
 *   data: {"type":"...", ...}\n   — UI Message Stream (toUIMessageStreamResponse)
 *   data: [DONE]                  — SSE terminator, always passed through
 */

const BLOCKED_EVENT_TYPES = new Set([
  'start-step',
  'finish-step',
  'tool-input-start',
  'tool-input-delta',
  'tool-output-available',
]);

// thoughtSignature is always nested inside providerMetadata; listed here as
// an extra guard in case it ever surfaces at the top level.
const STRIPPED_FIELDS = new Set([
  'providerMetadata',
  'thoughtSignature',
  'toolCallId',
]);

export function filterResponseStream(
  inputStream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = inputStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        try {
          const { done, value } = await reader.read();

          if (done) {
            if (buffer) {
              const out = sanitizeLine(buffer);
              if (out !== null) {
                controller.enqueue(encoder.encode(out + '\n'));
              }
            }
            controller.close();
            reader.releaseLock();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const out = sanitizeLine(line);
            if (out !== null) {
              controller.enqueue(encoder.encode(out + '\n'));
            }
          }

          // Yield control after each successful read so the event loop
          // can flush other microtasks — keeps latency low under load.
          if (lines.length > 0) {
            break;
          }
        } catch (err) {
          controller.error(err);
          reader.releaseLock();
          break;
        }
      }
    },
    cancel() {
      void reader.cancel();
      reader.releaseLock();
    },
  });
}

/**
 * Returns the sanitized line, or null if the line must be dropped.
 *
 * Non-data lines (empty SSE separator lines, SSE comments starting with ':')
 * are returned unchanged — they are part of SSE protocol framing.
 */
function sanitizeLine(line: string): string | null {
  if (!line.startsWith('data: ')) {
    return line; // empty separator lines and SSE comments pass through
  }

  const payload = line.slice(6);

  if (payload === '[DONE]') {
    return line; // SSE stream terminator — always keep
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    // Unparseable payload — pass through unchanged to avoid silent data loss
    return line;
  }

  if (typeof event.type === 'string' && BLOCKED_EVENT_TYPES.has(event.type)) {
    return null; // drop entire event
  }

  // Strip sensitive fields; only re-serialize if something was actually removed
  let mutated = false;
  for (const field of STRIPPED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(event, field)) {
      delete event[field];
      mutated = true;
    }
  }

  return mutated ? `data: ${JSON.stringify(event)}` : line;
}
