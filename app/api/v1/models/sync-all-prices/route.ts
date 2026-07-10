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
        const client = await pool.connect()
        try {
            const derivedModelsResult = await client.query(`
        SELECT d.id, d.name, d.base_model_id 
        FROM model_prices d
        JOIN model_prices b ON d.base_model_id = b.id
        WHERE d.base_model_id IS NOT NULL
      `)

            if (derivedModelsResult.rows.length === 0) {
                return NextResponse.json({
                    success: true,
                    message: 'No derived models found',
                    syncedModels: [],
                })
            }

            const derivedModels = derivedModelsResult.rows
            const syncResults = []

            for (const derivedModel of derivedModels) {
                try {
                    const baseModelResult = await client.query(
                        `SELECT input_price, output_price, per_msg_price,
                                price_multiplier, billing_mode
                         FROM model_prices
                         WHERE id = $1`,
                        [derivedModel.base_model_id]
                    )

                    if (baseModelResult.rows.length === 0) {
                        syncResults.push({
                            id: derivedModel.id,
                            name: derivedModel.name,
                            success: false,
                            error: 'Base model not found',
                        })
                        continue
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
                            derivedModel.id,
                            baseModel.input_price,
                            baseModel.output_price,
                            baseModel.per_msg_price,
                            baseModel.price_multiplier,
                            baseModel.billing_mode,
                        ]
                    )

                    const updatedModel = updateResult.rows[0]
                    const modelPrice = mapModelPriceRow(updatedModel)

                    syncResults.push({
                        ...modelPrice,
                        base_model_id: derivedModel.base_model_id,
                        success: true,
                    })
                } catch (error) {
                    console.error(
                        `Error syncing model ${derivedModel.id}:`,
                        error
                    )
                    syncResults.push({
                        id: derivedModel.id,
                        name: derivedModel.name,
                        success: false,
                        error:
                            error instanceof Error
                                ? error.message
                                : 'Unknown error',
                    })
                }
            }

            const successCount = syncResults.filter((r) => r.success).length

            return NextResponse.json({
                success: true,
                message: `Successfully synced ${successCount} of ${derivedModels.length} derived models`,
                syncedModels: syncResults,
            })
        } finally {
            client.release()
        }
    } catch (error) {
        console.error('Sync all prices failed:', error)
        return NextResponse.json(
            {
                error: 'Sync all prices failed',
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
