import { NextRequest, NextResponse } from 'next/server'
import { resetUserUsedBalance } from '@/lib/db/users'
import { verifyApiToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const authError = verifyApiToken(req)
    if (authError) {
        return authError
    }

    try {
        const { id } = await params
        const user = await resetUserUsedBalance(id)

        return NextResponse.json({
            success: true,
            user,
        })
    } catch (error) {
        console.error('Failed to reset user used balance:', error)
        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Failed to reset used balance',
            },
            { status: 500 }
        )
    }
}
