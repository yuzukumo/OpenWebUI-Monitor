import { NextResponse } from 'next/server'
import { verifyApiToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function buildOpenWebUIModelTestPayload(modelId: string) {
    const prompt = 'test, just say hi'
    const userMessageId = crypto.randomUUID()

    return {
        model: modelId,
        messages: [
            {
                role: 'user',
                content: prompt,
            },
        ],
        session_id: `monitor-model-test-${crypto.randomUUID()}`,
        id: crypto.randomUUID(),
        parent_id: null,
        user_message: {
            id: userMessageId,
            parentId: null,
            childrenIds: [],
            role: 'user',
            content: prompt,
            timestamp: Math.floor(Date.now() / 1000),
            models: [modelId],
        },
    }
}

export async function POST(req: Request) {
    const authError = verifyApiToken(req)
    if (authError) {
        return authError
    }

    try {
        const { modelId } = await req.json()

        if (!modelId) {
            return NextResponse.json({
                success: false,
                message: 'Model ID cannot be empty',
            })
        }

        const domain = process.env.OPENWEBUI_DOMAIN
        const apiKey = process.env.OPENWEBUI_API_KEY

        if (!domain || !apiKey) {
            return NextResponse.json({
                success: false,
                message: 'Environment variables not configured correctly',
            })
        }

        const apiUrl = domain.replace(/\/+$/, '') + '/api/chat/completions'

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(buildOpenWebUIModelTestPayload(modelId)),
        })

        const responseText = await response.text()
        let data

        try {
            data = JSON.parse(responseText)
        } catch (e) {
            return NextResponse.json({
                success: false,
                message: `Fail to resolve response: ${responseText}`,
            })
        }

        if (!response.ok) {
            return NextResponse.json({
                success: false,
                message:
                    data.error ||
                    `API request failed: ${response.status} ${response.statusText}`,
            })
        }

        const responseMessage =
            data?.choices?.[0]?.message?.content ||
            (data?.status === true && Array.isArray(data?.task_ids)
                ? `Task accepted by OpenWebUI (${data.task_ids[0]})`
                : null)

        if (!responseMessage) {
            return NextResponse.json({
                success: false,
                message: `Unexpected response format: ${responseText}`,
            })
        }

        return NextResponse.json({
            success: true,
            message: 'Test successful',
            response: responseMessage,
        })
    } catch (error) {
        return NextResponse.json({
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error',
        })
    }
}
