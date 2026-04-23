import { ensureTablesExist, query, withTransaction } from '@/lib/db/client'
import { NextResponse } from 'next/server'
import { verifyApiToken } from '@/lib/auth'
import { getMoneyAndMicros } from '@/lib/utils/money'

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
                    const balance = getMoneyAndMicros(
                        user.balance,
                        user.balance_micros
                    )
                    const usedBalance = getMoneyAndMicros(
                        user.used_balance ?? 0,
                        user.used_balance_micros
                    )

                    await query(
                        `INSERT INTO users (
              id, email, name, role, balance, balance_micros, used_balance, used_balance_micros, openwebui_order, created_at, deleted, exists_in_openwebui
            ) VALUES (
              $1,
              $2,
              $3,
              $4,
              CAST($5 AS NUMERIC(16,6)),
              COALESCE($6::BIGINT, 0),
              CAST($7 AS NUMERIC(16,6)),
              COALESCE($8::BIGINT, 0),
              $9,
              COALESCE($10, CURRENT_TIMESTAMP),
              COALESCE($11, FALSE),
              COALESCE($12, TRUE)
            )`,
                        [
                            user.id,
                            user.email,
                            user.name,
                            user.role,
                            balance.decimal,
                            balance.micros.toString(),
                            usedBalance.decimal,
                            usedBalance.micros.toString(),
                            user.openwebui_order ?? null,
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
                    const cost = getMoneyAndMicros(
                        record.cost,
                        record.cost_micros
                    )
                    const balanceAfter = getMoneyAndMicros(
                        record.balance_after,
                        record.balance_after_micros
                    )

                    await query(
                        `INSERT INTO user_usage_records (
              user_id, nickname, use_time, model_name, 
              input_tokens, output_tokens, cost, cost_micros, balance_after, balance_after_micros
            ) VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              CAST($7 AS NUMERIC(16,6)),
              $8::BIGINT,
              CAST($9 AS NUMERIC(16,6)),
              $10::BIGINT
            )`,
                        [
                            record.user_id,
                            record.nickname,
                            record.use_time,
                            record.model_name,
                            record.input_tokens,
                            record.output_tokens,
                            cost.decimal,
                            cost.micros.toString(),
                            balanceAfter.decimal,
                            balanceAfter.micros.toString(),
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
