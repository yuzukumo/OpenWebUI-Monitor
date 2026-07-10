import { NextRequest, NextResponse } from 'next/server'
import {
    updateModelPrice,
    type BillingMode,
    type ModelPriceUpdate,
} from '@/lib/db/client'
import { verifyApiToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function parsePriceUpdate(value: unknown): ModelPriceUpdate | null {
    if (!value || typeof value !== 'object') {
        return null
    }

    const update = value as Record<string, unknown>
    const perMsgPrice = Number(update.per_msg_price ?? -1)
    const billingMode: BillingMode | null =
        update.billing_mode === 'token' || update.billing_mode === 'request'
            ? update.billing_mode
            : update.billing_mode === undefined
              ? perMsgPrice >= 0
                  ? 'request'
                  : 'token'
              : null
    const parsed: ModelPriceUpdate = {
        id: typeof update.id === 'string' ? update.id : '',
        input_price: Number(update.input_price),
        output_price: Number(update.output_price),
        per_msg_price: perMsgPrice,
        price_multiplier: Number(update.price_multiplier ?? 1),
        billing_mode: billingMode ?? 'token',
    }

    if (
        !parsed.id ||
        !Number.isFinite(parsed.input_price) ||
        parsed.input_price < 0 ||
        !Number.isFinite(parsed.output_price) ||
        parsed.output_price < 0 ||
        !Number.isFinite(parsed.per_msg_price) ||
        !Number.isFinite(parsed.price_multiplier) ||
        parsed.price_multiplier < 0 ||
        billingMode === null ||
        (billingMode === 'request' && parsed.per_msg_price < 0)
    ) {
        return null
    }

    return parsed
}

export async function POST(request: NextRequest) {
    const authError = verifyApiToken(request)
    if (authError) {
        return authError
    }

    try {
        const data = await request.json()
        console.log('Raw data received:', data)

        const updates = data.updates || data
        if (!Array.isArray(updates)) {
            console.error('Invalid data format - expected array:', updates)
            return NextResponse.json(
                { error: 'Invalid data format' },
                { status: 400 }
            )
        }

        const parsedUpdates = updates.map(parsePriceUpdate)
        if (parsedUpdates.some((update) => update === null)) {
            return NextResponse.json(
                { error: 'Invalid model pricing update' },
                { status: 400 }
            )
        }
        const validUpdates = parsedUpdates as ModelPriceUpdate[]

        console.log('Update data after processing:', validUpdates)
        console.log(
            `Successfully verified price updating requests of ${validUpdates.length} models`
        )

        const results = await Promise.all(
            validUpdates.map(async (update: ModelPriceUpdate) => {
                try {
                    console.log('Updating model prices:', {
                        id: update.id,
                        input_price: update.input_price,
                        output_price: update.output_price,
                        per_msg_price: update.per_msg_price,
                        price_multiplier: update.price_multiplier,
                        billing_mode: update.billing_mode,
                    })

                    const result = await updateModelPrice(update)

                    console.log('Update results:', {
                        id: update.id,
                        success: !!result,
                        result,
                    })

                    return {
                        id: update.id,
                        success: !!result,
                        data: result,
                    }
                } catch (error) {
                    console.error('Fail to update:', {
                        id: update.id,
                        error:
                            error instanceof Error
                                ? error.message
                                : 'Unknown error',
                    })
                    return {
                        id: update.id,
                        success: false,
                        error:
                            error instanceof Error
                                ? error.message
                                : 'Unknown error',
                    }
                }
            })
        )

        const successCount = results.filter((r) => r.success).length
        console.log(`Successfully updated prices of ${successCount} models`)

        return NextResponse.json({
            success: true,
            message: `Successfully updated prices of ${successCount} models`,
            results,
        })
    } catch (error) {
        console.error('Batch update failed:', error)
        return NextResponse.json(
            { error: 'Batch update failed' },
            { status: 500 }
        )
    }
}

export async function OPTIONS() {
    return NextResponse.json({}, { status: 200 })
}
