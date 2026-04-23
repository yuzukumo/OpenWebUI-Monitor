import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

const port = parseInt(process.env.MOCK_OPENAI_PORT || '18001', 10)

const PNG_1X1_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s2R0f8AAAAASUVORK5CYII='

function sendJson(response: ServerResponse, status: number, payload: unknown) {
    response.statusCode = status
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(payload))
}

async function readBody(request: IncomingMessage) {
    const chunks: Buffer[] = []

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    const body = Buffer.concat(chunks).toString('utf8')
    return body ? JSON.parse(body) : {}
}

const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`)

    if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { status: 'ok' })
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
        return sendJson(response, 200, {
            object: 'list',
            data: [
                {
                    id: 'gpt-4o-mini',
                    object: 'model',
                    created: 0,
                    owned_by: 'openai',
                },
                {
                    id: 'gpt-image-1',
                    object: 'model',
                    created: 0,
                    owned_by: 'openai',
                },
                {
                    id: 'text-embedding-3-small',
                    object: 'model',
                    created: 0,
                    owned_by: 'openai',
                },
            ],
        })
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readBody(request)
        const model =
            typeof body.model === 'string' && body.model.trim()
                ? body.model
                : 'gpt-4o-mini'

        return sendJson(response, 200, {
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    finish_reason: 'stop',
                    message: {
                        role: 'assistant',
                        content: 'Hello from the mock OpenAI server.',
                    },
                },
            ],
            usage: {
                prompt_tokens: 12,
                completion_tokens: 15,
                total_tokens: 27,
            },
        })
    }

    if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
        const body = await readBody(request)
        const model =
            typeof body.model === 'string' && body.model.trim()
                ? body.model
                : 'text-embedding-3-small'

        return sendJson(response, 200, {
            object: 'list',
            model,
            data: [
                {
                    object: 'embedding',
                    index: 0,
                    embedding: Array.from(
                        { length: 16 },
                        (_, index) => index / 100
                    ),
                },
            ],
            usage: {
                prompt_tokens: 8,
                total_tokens: 8,
            },
        })
    }

    if (
        request.method === 'POST' &&
        url.pathname === '/v1/images/generations'
    ) {
        return sendJson(response, 200, {
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: PNG_1X1_BASE64 }],
            usage: {
                input_tokens: 123,
                output_tokens: 45,
                total_tokens: 168,
            },
        })
    }

    return sendJson(response, 404, {
        error: {
            message: `Unsupported route: ${request.method} ${url.pathname}`,
            type: 'not_found_error',
        },
    })
})

server.listen(port, '127.0.0.1', () => {
    console.log(`Mock OpenAI server listening on http://127.0.0.1:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        server.close(() => {
            process.exit(0)
        })
    })
}
