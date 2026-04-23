import { query } from '@/lib/db/client'
import { NextResponse } from 'next/server'
import { verifyApiToken } from '@/lib/auth'
import {
    MAX_BALANCE_MICROS,
    decimalToMicros,
    microsToDecimalString,
} from '@/lib/utils/money'

export const dynamic = 'force-dynamic'

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const authError = verifyApiToken(req)
    if (authError) {
        return authError
    }

    try {
        const { balance } = await req.json()
        const { id: userId } = await params

        console.log(`Updating balance for user ${userId} to ${balance}`)

        if (typeof balance !== 'number') {
            return NextResponse.json(
                { error: 'Balance must be a number' },
                { status: 400 }
            )
        }

        const balanceMicros = decimalToMicros(balance)

        if (balanceMicros > MAX_BALANCE_MICROS) {
            return NextResponse.json(
                { error: 'Balance exceeds maximum allowed value' },
                { status: 400 }
            )
        }

        const result = await query(
            `UPDATE users
       SET balance = CAST($1 AS NUMERIC(16,6)),
           balance_micros = $2::BIGINT
       WHERE id = $3
       RETURNING id, email, balance, used_balance`,
            [
                microsToDecimalString(balanceMicros),
                balanceMicros.toString(),
                userId,
            ]
        )

        console.log(`Update result:`, result)

        if (result.rows.length === 0) {
            return NextResponse.json(
                { error: 'User does not exist' },
                { status: 404 }
            )
        }

        return NextResponse.json(result.rows[0])
    } catch (error) {
        console.error('Fail to update user balance:', error)
        return NextResponse.json(
            { error: 'Fail to update user balance' },
            { status: 500 }
        )
    }
}
