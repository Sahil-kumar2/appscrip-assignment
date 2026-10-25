import { FastifyRequest, FastifyReply } from 'fastify';
import { safeCompareTokens } from '@aps/shared';

/**
 * Creates an onRequest hook to protect operator-facing endpoints (/api/*)
 * using constant-time bearer token comparison against OPERATOR_TOKEN.
 */
export function createOperatorAuthHook(expectedToken: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const rawPath = req.routeOptions?.url || req.url.split('?')[0];

    // Only protect /api/* routes; /v1/events (device bearer auth), /healthz, /readyz, /metrics are handled separately
    if (!rawPath.startsWith('/api')) {
      return;
    }

    let token: string | null = null;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (rawPath === '/api/stream') {
      // Browser EventSource doesn't support custom headers natively, support token in query params
      const query = req.query as { token?: string; access_token?: string };
      token = query.token || query.access_token || null;
    }

    if (!token || !safeCompareTokens(token, expectedToken)) {
      return reply.code(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid or missing operator bearer token',
      });
    }
  };
}
