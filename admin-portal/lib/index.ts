/**
 * Shared libraries for the Admin & Reseller Portal.
 *
 * This directory contains:
 * - validation: Pure validators/sanitizers
 * - rbac: Role-based access control (role→permission matrix)
 * - dynamo: DynamoDB document-client wrappers
 * - audit: Append-only audit log writer
 * - auth: Firebase ID-token verification, MFA, session management
 * - ratelimit: Reseller API rate limiting and quota enforcement
 * - email: Pluggable email sender (Resend-backed)
 * - signing: ECDSA manifest signing (server-only)
 * - release: Release_Metadata store + signed-manifest publisher
 */
export {};
