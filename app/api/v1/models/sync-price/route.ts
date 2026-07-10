import { NextRequest, NextResponse } from 'next/server'
import { mapModelPriceRow, pool } from '@/lib/db/client'
import { verifyApiToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
    const authError = verifyApiToken(request)
    if (authError) {
        return authError
    }

    try {
        const data = await request.json()
        const { modelId } = data

        if (!modelId) {
            return NextResponse.json(
                { error: 'Model ID is required' },
                { status: 400 }
            )
        }

        const client = await pool.connect()
        try {
            const derivedModelResult = await client.query(
                `SELECT id, name, base_model_id FROM model_prices WHERE id = $1`,
                [modelId]
            )

            if (derivedModelResult.rows.length === 0) {
                return NextResponse.json(
                    { error: 'Model not found' },
                    { status: 404 }
                )
            }

            const derivedModel = derivedModelResult.rows[0]
            let baseModelId = derivedModel.base_model_id

            if (!baseModelId) {
                const idParts = modelId.split('.')
                if (idParts.length > 1) {
                    baseModelId = idParts[idParts.length - 1]

                    await client.query(
                        `UPDATE model_prices SET base_model_id = $2 WHERE id = $1`,
                        [modelId, baseModelId]
                    )
                }
            }

            if (!baseModelId) {
                return NextResponse.json(
                    { error: 'Model does not have a base model' },
                    { status: 400 }
                )
            }

            const baseModelResult = await client.query(
                `SELECT input_price, output_price, per_msg_price,
                        price_multiplier, billing_mode
                 FROM model_prices
                 WHERE id = $1`,
                [baseModelId]
            )

            if (baseModelResult.rows.length === 0) {
                return NextResponse.json(
                    { error: 'Base model not found' },
                    { status: 404 }
                )
            }

            const baseModel = baseModelResult.rows[0]

            const updateResult = await client.query(
                `UPDATE model_prices 
         SET 
           input_price = $2,
           output_price = $3,
           per_msg_price = $4,
           price_multiplier = $5,
           billing_mode = $6,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
                [
                    modelId,
                    baseModel.input_price,
                    baseModel.output_price,
                    baseModel.per_msg_price,
                    baseModel.price_multiplier,
                    baseModel.billing_mode,
                ]
            )

            const updatedModel = updateResult.rows[0]
            const modelPrice = mapModelPriceRow(updatedModel)

            return NextResponse.json({
                success: true,
                message: `Successfully synced prices from ${baseModelId} to ${modelId}`,
                data: {
                    ...modelPrice,
                    base_model_id: baseModelId,
                },
            })
        } finally {
            client.release()
        }
    } catch (error) {
        console.error('Sync price failed:', error)
        return NextResponse.json(
            {
                error: 'Sync price failed',
                message:
                    error instanceof Error ? error.message : 'Unknown error',
            },
            { status: 500 }
        )
    }
}

export async function OPTIONS() {
    return NextResponse.json({}, { status: 200 })
}
