import { requireAuthorization } from '../../../../../lib/authorization';
import { portfolioResponse } from '../../../../../lib/portfolio-http';
import { chatBody, startChatRun } from '../../../../../lib/chat';
export const runtime = 'nodejs';
/** Creates a streamed run and returns 202 with its ID and a pre-run SSE replay cursor. */
export function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  return portfolioResponse(request, async () => {
    // Submissions have their own per-user window; admission also caps active runs per user.
    const auth = await requireAuthorization(request, { rateLimit: 'agent_submit' });
    const { run, userMessage, replayCursor } = await startChatRun({ ownerId: auth.user.id, conversationId: (await context.params).conversationId, body: await chatBody(request), chat: auth.chat });
    return { run, userMessage, replayCursor };
  }, 202);
}
