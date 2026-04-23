import { NextResponse } from 'next/server'
import { verifyApiToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
    const authError = verifyApiToken(req)
    if (authError) {
        return authError
    }

    return NextResponse.json({
        apiKey: process.env.API_KEY || 'Unconfigured',
        status: 200,
    })
}
