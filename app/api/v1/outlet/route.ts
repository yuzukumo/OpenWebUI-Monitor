import { NextResponse } from 'next/server'
import { encode } from 'gpt-tokenizer/model/gpt-4'
import type { PoolClient } from 'pg'
import { query, withTransaction } from '@/lib/db/client'
import { getModelInletCost } from '@/lib/utils/inlet-cost'

export const dynamic = 'force-dynamic'

interface Message {
    role: string
    content: string | MessageContent[]
    usage?: UsagePayload
    info?: UsagePayload & {
        usage?: UsagePayload
    }
}

interface MessageContent {
    type?: string
    text?: string
}

interface UsagePayload {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    input_tokens?: number
    output_tokens?: number
    prompt_eval_count?: number
    eval_count?: number
    prompt_n?: number
    predicted_n?: number
    [key: string]: unknown
}

interface ModelPrice {
    id: string
    name: string
    input_price: number
    output_price: number
    per_msg_price: number
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

function getFirstFiniteNumber(...values: unknown[]): number | undefined {
    return values.find(isFiniteNumber)
}

function getUsagePayload(message: Message): UsagePayload | null {
    if (message.usage && typeof message.usage === 'object') {
        return message.usage
    }

    if (message.info?.usage && typeof message.info.usage === 'object') {
        return message.info.usage
    }

    if (message.info && typeof message.info === 'object') {
        return message.info
    }

    return null
}

function getTokenCountsFromUsage(
    usage: UsagePayload
): { inputTokens: number; outputTokens: number } | null {
    const inputTokens = getFirstFiniteNumber(
        usage.input_tokens,
        usage.prompt_tokens,
        usage.prompt_eval_count,
        usage.prompt_n
    )

    const outputTokens = getFirstFiniteNumber(
        usage.output_tokens,
        usage.completion_tokens,
        usage.eval_count,
        usage.predicted_n
    )

    if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
        return { inputTokens, outputTokens }
    }

    const totalTokens = isFiniteNumber(usage.total_tokens)
        ? usage.total_tokens
        : undefined

    if (typeof inputTokens === 'number' && typeof totalTokens === 'number') {
        return {
            inputTokens,
            outputTokens: Math.max(totalTokens - inputTokens, 0),
        }
    }

    if (typeof outputTokens === 'number' && typeof totalTokens === 'number') {
        return {
            inputTokens: Math.max(totalTokens - outputTokens, 0),
            outputTokens,
        }
    }

    return null
}

function getMessageTextContent(content: Message['content']): string {
    if (typeof content === 'string') {
        return content
    }

    if (!Array.isArray(content)) {
        return ''
    }

    return content
        .map((item) =>
            item?.type === 'text' && typeof item.text === 'string'
                ? item.text
                : ''
        )
        .filter(Boolean)
        .join('\n')
}

function estimateMessageTokens(message: Message): number {
    return encode(getMessageTextContent(message.content)).length
}

async function getModelPrice(
    modelId: string,
    client?: PoolClient
): Promise<ModelPrice | null> {
    const result = await query(
        `SELECT id, name, input_price, output_price, per_msg_price 
     FROM model_prices 
     WHERE id = $1`,
        [modelId],
        client
    )

    if (result.rows[0]) {
        return result.rows[0]
    }

    const defaultInputPrice = parseFloat(
        process.env.DEFAULT_MODEL_INPUT_PRICE || '60'
    )
    const defaultOutputPrice = parseFloat(
        process.env.DEFAULT_MODEL_OUTPUT_PRICE || '60'
    )

    if (
        isNaN(defaultInputPrice) ||
        defaultInputPrice < 0 ||
        isNaN(defaultOutputPrice) ||
        defaultOutputPrice < 0
    ) {
        return null
    }

    return {
        id: modelId,
        name: modelId,
        input_price: defaultInputPrice,
        output_price: defaultOutputPrice,
        per_msg_price: -1,
    }
}

export async function POST(req: Request) {
    try {
        const data = await req.json()
        const modelId = data.body.model
        const userId = data.user.id
        const userName = data.user.name || 'Unknown User'

        const lastMessage = data.body.messages[data.body.messages.length - 1]

        let inputTokens: number
        let outputTokens: number
        const usage = getUsagePayload(lastMessage)
        const usageTokenCounts = usage ? getTokenCountsFromUsage(usage) : null

        if (usageTokenCounts) {
            inputTokens = usageTokenCounts.inputTokens
            outputTokens = usageTokenCounts.outputTokens
        } else {
            outputTokens = estimateMessageTokens(lastMessage)
            const totalTokens = data.body.messages.reduce(
                (sum: number, msg: Message) => sum + estimateMessageTokens(msg),
                0
            )
            inputTokens = totalTokens - outputTokens
        }

        const result = await withTransaction(async (client) => {
            const modelPrice = await getModelPrice(modelId, client)
            if (!modelPrice) {
                throw new Error(`Fail to fetch price info of model ${modelId}`)
            }

            let totalCost: number
            if (outputTokens === 0) {
                totalCost = 0
                console.log('No charge for zero output tokens')
            } else if (modelPrice.per_msg_price >= 0) {
                totalCost = Number(modelPrice.per_msg_price)
                console.log(
                    `Using fixed pricing: ${totalCost} (${modelPrice.per_msg_price} per message)`
                )
            } else {
                const inputCost =
                    (inputTokens / 1_000_000) * modelPrice.input_price
                const outputCost =
                    (outputTokens / 1_000_000) * modelPrice.output_price
                totalCost = inputCost + outputCost
            }

            const inletCost = getModelInletCost(modelId)
            const actualCost = totalCost - inletCost

            const userResult = await query(
                `UPDATE users 
           SET balance = LEAST(
             balance - CAST($1 AS DECIMAL(16,4)),
             999999.9999
           ),
               used_balance = GREATEST(
                 COALESCE(used_balance, 0) + CAST($1 AS DECIMAL(16,4)),
                 0
               )
           WHERE id = $2
           RETURNING balance, used_balance`,
                [actualCost, userId],
                client
            )

            if (userResult.rows.length === 0) {
                throw new Error('User does not exist')
            }

            const newBalance = Number(userResult.rows[0].balance)
            const usedBalance = Number(userResult.rows[0].used_balance)

            if (newBalance > 999999.9999) {
                throw new Error('Balance exceeds maximum allowed value')
            }

            await query(
                `INSERT INTO user_usage_records (
            user_id, nickname, model_name, 
            input_tokens, output_tokens, 
            cost, balance_after
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    userId,
                    userName,
                    modelId,
                    inputTokens,
                    outputTokens,
                    totalCost,
                    newBalance,
                ],
                client
            )

            return {
                inputTokens,
                outputTokens,
                totalCost,
                newBalance,
                usedBalance,
            }
        })

        console.log(
            JSON.stringify({
                success: true,
                ...result,
                message: 'Request successful',
            })
        )

        return NextResponse.json({
            success: true,
            ...result,
            message: 'Request successful',
        })
    } catch (error) {
        console.error('Outlet error:', error)
        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Error processing request',
                error_type:
                    error instanceof Error ? error.name : 'UNKNOWN_ERROR',
            },
            { status: 500 }
        )
    }
}
