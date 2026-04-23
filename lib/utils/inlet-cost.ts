import { decimalToMicros, microsToNumber } from './money'

interface ModelInletCost {
    [key: string]: bigint
}

function parseInletCostConfig(config: string | undefined): ModelInletCost {
    if (!config) {
        return {}
    }

    try {
        return { default: decimalToMicros(config) }
    } catch (error) {
        try {
            const costs: ModelInletCost = {}
            config.split(',').forEach((pair) => {
                const [model, cost] = pair.trim().split(':')

                if (!model || !cost) {
                    return
                }

                costs[model.trim()] = decimalToMicros(cost)
            })

            return costs
        } catch (innerError) {
            console.error('Error parsing COST_ON_INLET config:', innerError)
            return {}
        }
    }
}

export function getModelInletCostMicros(modelId?: string | null): bigint {
    if (!process.env.COST_ON_INLET) {
        return BigInt(0)
    }

    const costConfig = parseInletCostConfig(process.env.COST_ON_INLET)

    if (modelId) {
        return costConfig[modelId] ?? costConfig.default ?? BigInt(0)
    }

    return costConfig.default ?? BigInt(0)
}

export function getModelInletCost(modelId?: string | null): number {
    return microsToNumber(getModelInletCostMicros(modelId))
}
