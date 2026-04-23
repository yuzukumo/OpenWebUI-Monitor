import { NextRequest, NextResponse } from 'next/server'
import { deleteUser } from '@/lib/db/users'
import { query } from '@/lib/db/client'
import { verifyApiToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const authError = verifyApiToken(req)
    if (authError) {
        return authError
    }

    try {
        const { id } = await params
        await deleteUser(id)
        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('Fail to delete user:', error)
        return NextResponse.json(
            { error: 'Fail to delete user' },
            { status: 500 }
        )
    }
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const authError = verifyApiToken(req)
    if (authError) {
        return authError
    }

    try {
        const { deleted } = await req.json()
        const { id } = await params

        const result = await query(
            `UPDATE users 
       SET deleted = $1 
       WHERE id = $2 
       RETURNING *`,
            [deleted, id]
        )

        if (result.rowCount === 0) {
            return NextResponse.json(
                { error: 'User not found' },
                { status: 404 }
            )
        }

        return NextResponse.json({
            success: true,
            user: result.rows[0],
        })
    } catch (error) {
        console.error('Failed to update user:', error)
        return NextResponse.json(
            { error: 'Failed to update user' },
            { status: 500 }
        )
    }
}
