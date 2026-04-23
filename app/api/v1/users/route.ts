import { NextRequest, NextResponse } from 'next/server'
import {
    ensureUserTableExists,
    getUsers,
    syncUsersFromOpenWebUI,
} from '@/lib/db/users'
import { verifyApiToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
    const authError = verifyApiToken(req)
    if (authError) {
        return authError
    }

    try {
        await ensureUserTableExists()

        const { searchParams } = new URL(req.url)
        const page = Math.max(parseInt(searchParams.get('page') || '1', 10), 1)
        const pageSize = Math.max(
            parseInt(searchParams.get('pageSize') || '20', 10),
            1
        )
        const sortField = searchParams.get('sortField')
        const sortOrder = searchParams.get('sortOrder')
        const search = searchParams.get('search')

        try {
            await syncUsersFromOpenWebUI()
        } catch (error) {
            console.error('Failed to sync users from OpenWebUI:', error)
        }

        const result = await getUsers({
            page,
            pageSize,
            sortField,
            sortOrder,
            search,
        })

        return NextResponse.json({
            users: result.users,
            total: result.total,
            page,
            pageSize,
        })
    } catch (error) {
        console.error('Failed to fetch users:', error)
        return NextResponse.json(
            { error: 'Failed to fetch users' },
            { status: 500 }
        )
    }
}
