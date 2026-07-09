import { NextResponse, type NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const DEFAULT_ICON_PATH = '/static/favicon.png'
const MAX_MODEL_ID_LENGTH = 256

function redirectToDefaultIcon(request: NextRequest) {
    return NextResponse.redirect(new URL(DEFAULT_ICON_PATH, request.url), 302)
}

function isSupportedImageContentType(contentType: string) {
    const normalized = contentType.toLowerCase()

    return normalized.startsWith('image/') && !normalized.includes('svg')
}

export async function GET(request: NextRequest) {
    const modelId = request.nextUrl.searchParams.get('id')?.trim()
    if (!modelId || modelId.length > MAX_MODEL_ID_LENGTH) {
        return redirectToDefaultIcon(request)
    }

    const domain = process.env.OPENWEBUI_DOMAIN?.trim()
    const apiKey = process.env.OPENWEBUI_API_KEY?.trim()

    if (!domain || !apiKey) {
        return redirectToDefaultIcon(request)
    }

    const iconUrl = new URL(
        '/api/v1/models/model/profile/image',
        domain.replace(/\/+$/, '')
    )
    iconUrl.searchParams.set('id', modelId)

    try {
        const response = await fetch(iconUrl, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'image/*,*/*;q=0.8',
            },
            cache: 'no-store',
            redirect: 'follow',
        })

        const contentType = response.headers.get('content-type') || ''
        if (
            !response.ok ||
            !response.body ||
            !isSupportedImageContentType(contentType)
        ) {
            return redirectToDefaultIcon(request)
        }

        const headers = new Headers()
        headers.set('Content-Type', contentType)
        headers.set(
            'Cache-Control',
            'public, max-age=300, stale-while-revalidate=3600'
        )

        const etag = response.headers.get('etag')
        if (etag) {
            headers.set('ETag', etag)
        }

        return new Response(response.body, {
            status: 200,
            headers,
        })
    } catch (error) {
        console.error(
            `Failed to fetch OpenWebUI model icon for ${modelId}:`,
            error
        )
        return redirectToDefaultIcon(request)
    }
}
