import { NextResponse } from 'next/server'
import { getOrCreateUser } from '@/lib/db/users'
import { query } from '@/lib/db/client'
import { MAX_BALANCE_MICROS, microsToNumber } from '@/lib/utils/money'
import { getModelInletCostMicros } from '@/lib/utils/inlet-cost'
import { extractBillingUserFromPayload } from '@/lib/utils/openwebui-payload'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
    try {
        let data: {
            body?: {
                model?: string | null
            }
            [key: string]: unknown
        }

        try {
            data = await req.json()
        } catch {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Invalid JSON payload',
                    error_type: 'INVALID_JSON',
                },
                { status: 400 }
            )
        }

        const billingUser = extractBillingUserFromPayload(data)

        if (!billingUser) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Missing OpenWebUI user id',
                    error_type: 'MISSING_USER_ID',
                },
                { status: 400 }
            )
        }

        const user = await getOrCreateUser(billingUser)
        const modelId = data.body?.model

        const inletCostMicros = getModelInletCostMicros(modelId)

        if (inletCostMicros > BigInt(0)) {
            const userResult = await query(
                `UPDATE users 
         SET balance_micros = LEAST(
               COALESCE(balance_micros, ROUND(COALESCE(balance, 0) * 1000000)::BIGINT) - $1::BIGINT,
               $3::BIGINT
             ),
             used_balance_micros = GREATEST(
               COALESCE(used_balance_micros, ROUND(COALESCE(used_balance, 0) * 1000000)::BIGINT) + $1::BIGINT,
               0
             ),
             balance = LEAST(
               COALESCE(balance_micros, ROUND(COALESCE(balance, 0) * 1000000)::BIGINT) - $1::BIGINT,
               $3::BIGINT
             )::NUMERIC / 1000000,
             used_balance = GREATEST(
               COALESCE(used_balance_micros, ROUND(COALESCE(used_balance, 0) * 1000000)::BIGINT) + $1::BIGINT,
               0
             )::NUMERIC / 1000000
         WHERE id = $2
         RETURNING balance, used_balance, balance_micros, used_balance_micros`,
                [
                    inletCostMicros.toString(),
                    user.id,
                    MAX_BALANCE_MICROS.toString(),
                ]
            )

            if (userResult.rows.length === 0) {
                throw new Error('Failed to update user balance')
            }

            return NextResponse.json({
                success: true,
                balance: microsToNumber(userResult.rows[0].balance_micros),
                used_balance: microsToNumber(
                    userResult.rows[0].used_balance_micros
                ),
                inlet_cost: microsToNumber(inletCostMicros),
                message: 'Request successful',
            })
        }

        return NextResponse.json({
            success: true,
            balance: Number(user.balance),
            used_balance: Number(user.used_balance || 0),
            message: 'Request successful',
        })
    } catch (error) {
        console.error('Inlet error:', error)
        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Error dealing with request',
                error_type:
                    error instanceof Error ? error.name : 'UNKNOWN_ERROR',
            },
            { status: 500 }
        )
    }
}
