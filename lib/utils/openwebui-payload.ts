import { normalizeBillingUser, type User } from '@/lib/db/users'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

export function extractBillingUserFromPayload(payload: unknown): User | null {
    if (!isRecord(payload)) {
        return null
    }

    const body = isRecord(payload.body) ? payload.body : null
    const metadata = isRecord(payload.metadata) ? payload.metadata : null
    const bodyMetadata = body && isRecord(body.metadata) ? body.metadata : null

    const candidates = [
        payload.user,
        payload.__user__,
        payload.user_info,
        payload.userInfo,
        metadata?.user,
        metadata?.__user__,
        metadata?.user_info,
        metadata?.userInfo,
        metadata,
        body?.user,
        body?.__user__,
        body?.user_info,
        body?.userInfo,
        bodyMetadata?.user,
        bodyMetadata?.__user__,
        bodyMetadata?.user_info,
        bodyMetadata?.userInfo,
        bodyMetadata,
    ]

    for (const candidate of candidates) {
        const user = normalizeBillingUser(candidate)

        if (user) {
            return user
        }
    }

    return null
}
