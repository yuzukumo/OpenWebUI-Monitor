import { ensureTablesExist, query, withTransaction } from '@/lib/db/client'
import { NextResponse } from 'next/server'
import { verifyApiToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
    const authError = verifyApiToken(req)
    if (authError) {
        return authError
    }

    try {
        await ensureTablesExist()

        const data = await req.json()

        if (!data.version || !data.data) {
            throw new Error('Invalid import data format')
        }

        await withTransaction(async (client) => {
            await query('TRUNCATE TABLE user_usage_records CASCADE', [], client)
            await query('TRUNCATE TABLE model_prices CASCADE', [], client)
            await query('TRUNCATE TABLE users CASCADE', [], client)

            if (data.data.users?.length) {
                for (const user of data.data.users) {
                    await query(
                        `INSERT INTO users (
              id, email, name, role, balance, used_balance, created_at, deleted, exists_in_openwebui
            ) VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              COALESCE($6, 0),
              COALESCE($7, CURRENT_TIMESTAMP),
              COALESCE($8, FALSE),
              COALESCE($9, TRUE)
            )`,
                        [
                            user.id,
                            user.email,
                            user.name,
                            user.role,
                            user.balance,
                            user.used_balance ?? 0,
                            user.created_at ?? null,
                            user.deleted ?? false,
                            user.exists_in_openwebui ?? true,
                        ],
                        client
                    )
                }
            }

            if (data.data.model_prices?.length) {
                for (const price of data.data.model_prices) {
                    await query(
                        `INSERT INTO model_prices (
              id, name, base_model_id, input_price, output_price, per_msg_price, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, CURRENT_TIMESTAMP))`,
                        [
                            price.id,
                            price.name,
                            price.base_model_id ?? null,
                            price.input_price,
                            price.output_price,
                            price.per_msg_price ?? -1,
                            price.updated_at ?? null,
                        ],
                        client
                    )
                }
            }

            if (data.data.user_usage_records?.length) {
                for (const record of data.data.user_usage_records) {
                    await query(
                        `INSERT INTO user_usage_records (
              user_id, nickname, use_time, model_name, 
              input_tokens, output_tokens, cost, balance_after
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [
                            record.user_id,
                            record.nickname,
                            record.use_time,
                            record.model_name,
                            record.input_tokens,
                            record.output_tokens,
                            record.cost,
                            record.balance_after,
                        ],
                        client
                    )
                }
            }
        })

        return NextResponse.json({
            success: true,
            message: 'Data import successful',
        })
    } catch (error) {
        console.error('Fail to import database:', error)
        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Fail to import database',
            },
            { status: 500 }
        )
    }
}
