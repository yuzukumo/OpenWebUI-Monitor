import { getOrCreateModelPrices } from './client'
import type { ModelPrice } from './client'

export { ensureTablesExist } from './client'

export async function getOrCreateModelPrice(
    id: string,
    name: string
): Promise<ModelPrice> {
    const [modelPrice] = await getOrCreateModelPrices([{ id, name }])

    if (!modelPrice) {
        throw new Error(`Failed to create model price for ${id}`)
    }

    return modelPrice
}

export {
    getUsers,
    getOrCreateUser,
    updateUserBalance,
    deleteUser,
} from './users'
