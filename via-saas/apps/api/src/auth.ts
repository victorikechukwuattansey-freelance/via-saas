import type { FastifyReply, FastifyRequest } from "fastify"
import { resolveSessionContext, type SessionContext } from "@via-saas/core"

declare module "fastify" {
  interface FastifyRequest {
    merchantContext: SessionContext | null
  }
}

/**
 * Resolves the existing merchant session cookie and attaches its verified
 * organization/location context to the request.
 *
 * Public storefront routes must not use this hook. Attach it only to
 * merchant-protected routes.
 */
export async function authenticateMerchant(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const context = await resolveSessionContext(request.cookies.session_token)

  if (!context) {
    return reply.code(401).send({ error: "Unauthenticated" })
  }

  request.merchantContext = context
}
