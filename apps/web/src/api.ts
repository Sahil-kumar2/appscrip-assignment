export const OPERATOR_TOKEN = 'operator-secret-token';

/**
 * Wrapper around standard fetch that automatically attaches the
 * Operator Bearer Token for authenticated /api/* endpoints.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${OPERATOR_TOKEN}`);
  }
  return fetch(input, {
    ...init,
    headers,
  });
}
