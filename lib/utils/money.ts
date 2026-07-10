export const MONEY_SCALE = 6
export const MONEY_FACTOR = BigInt(1_000_000)
export const MAX_BALANCE = 999999.999999
export const MAX_BALANCE_MICROS = BigInt(999_999_999_999)
export const TOKENS_PER_PRICING_UNIT = BigInt(1_000_000)

const MONEY_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/
const MICROS_PATTERN = /^([+-]?)(\d+)$/

export function parseMicros(value: unknown): bigint {
    if (typeof value === 'bigint') {
        return value
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error(`Invalid micros value: ${value}`)
        }

        return BigInt(Math.round(value))
    }

    if (typeof value === 'string') {
        const normalized = value.trim()
        const match = normalized.match(MICROS_PATTERN)

        if (!match) {
            throw new Error(`Invalid micros value: ${value}`)
        }

        const [, sign, integerPart] = match
        const parsed = BigInt(integerPart)

        return sign === '-' ? -parsed : parsed
    }

    throw new Error(`Unsupported micros value type: ${typeof value}`)
}

export function decimalToMicros(value: unknown): bigint {
    if (typeof value === 'bigint') {
        return value
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error(`Invalid money value: ${value}`)
        }

        return BigInt(Math.round(value * Number(MONEY_FACTOR)))
    }

    if (typeof value === 'string') {
        const normalized = value.trim()
        const match = normalized.match(MONEY_PATTERN)

        if (!match) {
            throw new Error(`Invalid money value: ${value}`)
        }

        const [, sign, integerPart, fractionalPart = ''] = match
        const roundedFraction = fractionalPart
            .padEnd(MONEY_SCALE + 1, '0')
            .slice(0, MONEY_SCALE + 1)
        const fractionMicros = BigInt(
            roundedFraction.slice(0, MONEY_SCALE).padEnd(MONEY_SCALE, '0')
        )
        const shouldRoundUp = Number(roundedFraction[MONEY_SCALE] || '0') >= 5
        let micros = BigInt(integerPart) * MONEY_FACTOR + fractionMicros

        if (shouldRoundUp) {
            micros += BigInt(1)
        }

        return sign === '-' ? -micros : micros
    }

    throw new Error(`Unsupported money value type: ${typeof value}`)
}

export function microsToNumber(value: unknown): number {
    return Number(parseMicros(value)) / Number(MONEY_FACTOR)
}

export function formatMoney(
    value: unknown,
    fractionDigits: number = MONEY_SCALE
): string {
    try {
        if (typeof value === 'number' || typeof value === 'string') {
            if (typeof value === 'string' && value.trim() === '') {
                return (0).toFixed(fractionDigits)
            }

            const numericValue = Number(value)

            if (!Number.isFinite(numericValue)) {
                return (0).toFixed(fractionDigits)
            }

            return numericValue.toFixed(fractionDigits)
        }
    } catch (error) {
        console.error('Failed to format money value:', error)
    }

    return (0).toFixed(fractionDigits)
}

export function formatCompactDecimal(value: unknown): string {
    const numericValue = Number(value)

    if (!Number.isFinite(numericValue) || Object.is(numericValue, -0)) {
        return '0'
    }

    return numericValue.toString()
}

export function microsToDecimalString(
    value: unknown,
    fractionDigits: number = MONEY_SCALE
) {
    return microsToNumber(value).toFixed(fractionDigits)
}

export function formatMoneyFromMicros(
    value: unknown,
    fractionDigits: number = MONEY_SCALE
) {
    return microsToDecimalString(value, fractionDigits)
}

export function divideAndRound(numerator: bigint, denominator: bigint): bigint {
    if (denominator === BigInt(0)) {
        throw new Error('Division by zero')
    }

    const isNegative = numerator < BigInt(0)
    const absoluteNumerator = isNegative ? -numerator : numerator
    const quotient = absoluteNumerator / denominator
    const remainder = absoluteNumerator % denominator
    const rounded =
        remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient

    return isNegative ? -rounded : rounded
}

export function calculateTokenCostMicros({
    inputTokens,
    outputTokens,
    inputPrice,
    outputPrice,
    priceMultiplier = 1,
}: {
    inputTokens: number
    outputTokens: number
    inputPrice: unknown
    outputPrice: unknown
    priceMultiplier?: unknown
}) {
    const normalizedInputTokens = BigInt(Math.max(Math.round(inputTokens), 0))
    const normalizedOutputTokens = BigInt(Math.max(Math.round(outputTokens), 0))
    const basePriceNumerator =
        normalizedInputTokens * decimalToMicros(inputPrice) +
        normalizedOutputTokens * decimalToMicros(outputPrice)
    const multiplierUnits = decimalToMicros(priceMultiplier)

    if (multiplierUnits < BigInt(0)) {
        throw new Error('Price multiplier cannot be negative')
    }

    return divideAndRound(
        basePriceNumerator * multiplierUnits,
        TOKENS_PER_PRICING_UNIT * MONEY_FACTOR
    )
}

export function applyPriceMultiplierMicros(
    configuredPrice: unknown,
    multiplier: unknown
): bigint {
    const configuredPriceMicros = decimalToMicros(configuredPrice)
    const multiplierUnits = decimalToMicros(multiplier)

    if (configuredPriceMicros < BigInt(0)) {
        throw new Error('Configured price cannot be negative')
    }

    if (multiplierUnits < BigInt(0)) {
        throw new Error('Price multiplier cannot be negative')
    }

    return divideAndRound(configuredPriceMicros * multiplierUnits, MONEY_FACTOR)
}

export function applyPriceMultiplier(
    configuredPrice: unknown,
    multiplier: unknown
): string {
    return microsToDecimalString(
        applyPriceMultiplierMicros(configuredPrice, multiplier)
    )
}

export function getMoneyAndMicros(
    decimalValue: unknown,
    microsValue?: unknown
): { decimal: string; micros: bigint } {
    let micros: bigint

    if (microsValue === undefined || microsValue === null) {
        micros = decimalToMicros(decimalValue ?? 0)
    } else {
        try {
            micros = parseMicros(microsValue)
        } catch (error) {
            console.warn(
                'Falling back to decimal money value while parsing micros:',
                error
            )
            micros = decimalToMicros(decimalValue ?? 0)
        }
    }

    return {
        decimal: microsToDecimalString(micros),
        micros,
    }
}
