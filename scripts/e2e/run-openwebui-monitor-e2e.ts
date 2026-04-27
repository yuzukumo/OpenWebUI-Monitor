import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { chromium } from 'playwright'

interface CommandOptions {
    cwd?: string
    env?: NodeJS.ProcessEnv
    logFilePath?: string
    acceptableExitCodes?: number[]
}

interface BackgroundProcess {
    child: ChildProcessWithoutNullStreams
    logFilePath: string
}

interface OpenWebUISession {
    token: string
    token_type: string
    id: string
    email: string
    name: string
    role: string
}

interface OpenWebUIUser {
    id: string
    email: string
    name: string
    role: string
}

interface MonitorUser {
    id: string
    email: string
    name: string
    role: string
    balance: number | string
    used_balance: number | string
    openwebui_order?: number | null
    deleted: boolean
    exists_in_openwebui?: boolean
}

interface MonitorUsersResponse {
    users: MonitorUser[]
    total: number
    page: number
    pageSize: number
}

interface MonitorRecord {
    user_id: string
    nickname: string
    model_name: string
    input_tokens: number
    output_tokens: number
    cost: number | string
    balance_after: number | string
}

interface MonitorRecordsResponse {
    records: MonitorRecord[]
    total: number
    users: string[]
    models: string[]
}

interface DatabaseExportPayload {
    version: string
    timestamp: string
    data: {
        users: MonitorUser[]
        model_prices: Array<Record<string, unknown>>
        user_usage_records: Array<Record<string, unknown>>
    }
}

interface ApiCheckSummary {
    models_page: string
    model_test: { status: number; success: boolean }
    sync_all: { status: number; success: boolean }
    records_export: { status: number }
    database_export: { status: number }
}

interface ChromiumCheckSummary {
    screenshots: Record<string, string>
    users_page: {
        updated_balance: number
        balance_update_without_refetch: boolean
        used_balance_reset_without_refetch: boolean
    }
}

interface CapturedMonitorPayload {
    endpoint: 'inlet' | 'outlet'
    payload: Record<string, unknown> | null
    rawBody: string
}

interface CapturedPayloadSummary {
    endpoint: 'inlet' | 'outlet'
    user_keys: string[]
    user_has_id: boolean
    user_has_email: boolean
    user_has_name: boolean
    metadata_keys: string[]
    metadata_has_user_id: boolean
    body_model_type: string
    body_message_count: number | null
}

interface OpenWebUIPayloadCaptureSummary {
    chat_api: CapturedPayloadSummary[]
    desktop_multi_image_chat_api: CapturedPayloadSummary[]
    desktop_multi_image_chat_api_body_bytes: number[]
    mobile_image_chat_api: CapturedPayloadSummary[]
    mobile_image_chat_api_body_bytes: number[]
    temporary_data_url_image_chat_api: CapturedPayloadSummary[]
    temporary_data_url_image_chat_api_body_bytes: number[]
}

interface OpenWebUIFunctionState {
    id: string
    is_active: boolean
    is_global: boolean
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT_DIR = path.resolve(__dirname, '../..')
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'artifacts/e2e')
const LOGS_DIR = path.join(ARTIFACTS_DIR, 'logs')
const SCREENSHOTS_DIR = path.join(ARTIFACTS_DIR, 'screenshots')

const OWU_IMAGE =
    process.env.OWU_IMAGE || 'ghcr.io/open-webui/open-webui:latest-slim'
const POSTGRES_IMAGE = process.env.E2E_POSTGRES_IMAGE || 'postgres:18-alpine'

let MOCK_PORT = parseInt(process.env.MOCK_OPENAI_PORT || '18001', 10)
let OWU_PORT = parseInt(process.env.E2E_OWU_PORT || '18080', 10)
let MONITOR_PORT = parseInt(process.env.E2E_MONITOR_PORT || '17878', 10)
let POSTGRES_PORT = parseInt(process.env.E2E_POSTGRES_PORT || '55432', 10)

let MOCK_BASE_URL = ''
let OWU_BASE_URL = ''
let MONITOR_BASE_URL = ''
let POSTGRES_URL = ''

const MONITOR_ACCESS_TOKEN =
    process.env.E2E_MONITOR_ACCESS_TOKEN || 'monitor-access'
const MONITOR_API_KEY = process.env.E2E_MONITOR_API_KEY || 'monitor-api'

const ADMIN_USER = {
    email: 'e2e.admin@example.com',
    password: 'Password123!',
    name: 'E2E Admin',
}

const SYNC_SUBJECT_USER = {
    email: 'sync.subject@example.com',
    password: 'Password123!',
    name: 'Sync Subject',
    renamedName: 'Renamed Subject',
}

const OWU_CONTAINER_NAME = 'owu-monitor-e2e-openwebui'
const POSTGRES_CONTAINER_NAME = 'owu-monitor-e2e-postgres'

class CleanupStack {
    private tasks: Array<() => Promise<void>> = []

    push(task: () => Promise<void>) {
        this.tasks.unshift(task)
    }

    async runAll() {
        for (const task of this.tasks) {
            try {
                await task()
            } catch (error) {
                console.error('[owu-e2e] Cleanup failed:', error)
            }
        }
    }
}

function logStep(message: string) {
    console.log(`[owu-e2e] ${message}`)
}

function refreshRuntimeUrls() {
    MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`
    OWU_BASE_URL = `http://127.0.0.1:${OWU_PORT}`
    MONITOR_BASE_URL = `http://127.0.0.1:${MONITOR_PORT}`
    POSTGRES_URL = `postgresql://postgres:openwebui@127.0.0.1:${POSTGRES_PORT}/openwebui_monitor`
}

async function ensureArtifactsDirs() {
    await fs.rm(ARTIFACTS_DIR, { recursive: true, force: true })
    await fs.mkdir(LOGS_DIR, { recursive: true })
    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true })
}

async function isPortAvailable(port: number) {
    return new Promise<boolean>((resolve) => {
        const server = net.createServer()

        server.once('error', () => {
            resolve(false)
        })

        server.once('listening', () => {
            server.close(() => resolve(true))
        })

        server.listen(port, '127.0.0.1')
    })
}

async function getFreePort() {
    return new Promise<number>((resolve, reject) => {
        const server = net.createServer()

        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to allocate a free TCP port'))
                return
            }

            const { port } = address
            server.close(() => resolve(port))
        })
    })
}

async function choosePort(preferredPort: number) {
    if (await isPortAvailable(preferredPort)) {
        return preferredPort
    }

    return getFreePort()
}

async function runCommand(
    command: string,
    args: string[],
    {
        cwd = ROOT_DIR,
        env = process.env,
        logFilePath,
        acceptableExitCodes = [0],
    }: CommandOptions = {}
) {
    const child = spawn(command, args, {
        cwd,
        env,
        stdio: 'pipe',
    })

    let stdout = ''
    let stderr = ''
    const logStream = logFilePath ? createWriteStream(logFilePath) : null

    child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stdout += text
        logStream?.write(text)
    })

    child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stderr += text
        logStream?.write(text)
    })

    const exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code) => resolve(code ?? 0))
    })

    logStream?.end()

    if (!acceptableExitCodes.includes(exitCode)) {
        const combinedOutput = `${stdout}\n${stderr}`.trim()
        const tail = combinedOutput.split('\n').slice(-60).join('\n')
        throw new Error(
            `${command} ${args.join(' ')} exited with ${exitCode}\n${tail}`
        )
    }

    return { stdout, stderr, exitCode }
}

async function startBackgroundProcess(
    name: string,
    command: string,
    args: string[],
    { cwd = ROOT_DIR, env = process.env }: CommandOptions = {}
): Promise<BackgroundProcess> {
    const logFilePath = path.join(LOGS_DIR, `${name}.log`)
    const logStream = createWriteStream(logFilePath)
    const child = spawn(command, args, {
        cwd,
        env,
        stdio: 'pipe',
    })

    child.stdout.on('data', (chunk: Buffer) => {
        logStream.write(chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => {
        logStream.write(chunk)
    })

    child.on('close', () => {
        logStream.end()
    })

    return { child, logFilePath }
}

async function stopBackgroundProcess(process: BackgroundProcess) {
    if (process.child.exitCode !== null || process.child.killed) {
        return
    }

    process.child.kill('SIGTERM')

    const timedOut = await Promise.race([
        new Promise<boolean>((resolve) => {
            process.child.once('close', () => resolve(false))
        }),
        sleep(10_000).then(() => true),
    ])

    if (timedOut) {
        process.child.kill('SIGKILL')
        await new Promise<void>((resolve) => {
            process.child.once('close', () => resolve())
        })
    }
}

async function waitForHttp(
    url: string,
    {
        timeoutMs = 120_000,
        validate,
    }: {
        timeoutMs?: number
        validate?: (response: Response, bodyText: string) => boolean
    } = {}
) {
    const startedAt = Date.now()
    let lastError: unknown = null

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await fetch(url, {
                cache: 'no-store',
            })
            const bodyText = await response.text()

            if (!validate || validate(response, bodyText)) {
                return { response, bodyText }
            }

            lastError = new Error(
                `Unexpected response from ${url}: ${response.status} ${bodyText}`
            )
        } catch (error) {
            lastError = error
        }

        await sleep(1000)
    }

    throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`)
}

async function waitForTcpPort(
    host: string,
    port: number,
    timeoutMs: number = 120_000
) {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
        const isOpen = await new Promise<boolean>((resolve) => {
            const socket = net.createConnection({ host, port })

            socket.once('connect', () => {
                socket.end()
                resolve(true)
            })

            socket.once('error', () => {
                resolve(false)
            })
        })

        if (isOpen) {
            return
        }

        await sleep(1000)
    }

    throw new Error(`Timed out waiting for TCP ${host}:${port}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function getRecordField(
    value: unknown,
    key: string
): Record<string, unknown> | null {
    if (!isRecord(value)) {
        return null
    }

    const fieldValue = value[key]
    return isRecord(fieldValue) ? fieldValue : null
}

function readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = ''

        req.setEncoding('utf8')
        req.on('data', (chunk: string) => {
            body += chunk
        })
        req.on('end', () => resolve(body))
        req.on('error', reject)
    })
}

function writeJsonResponse(
    res: ServerResponse,
    statusCode: number,
    body: Record<string, unknown>
) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
    })
    res.end(JSON.stringify(body))
}

async function startMonitorCaptureServer() {
    const payloads: CapturedMonitorPayload[] = []
    const port = await getFreePort()

    const server = createServer(
        async (req: IncomingMessage, res: ServerResponse) => {
            try {
                if (req.method === 'GET' && req.url === '/health') {
                    writeJsonResponse(res, 200, { ok: true })
                    return
                }

                const endpoint = req.url?.includes('/api/v1/outlet')
                    ? 'outlet'
                    : req.url?.includes('/api/v1/inlet')
                      ? 'inlet'
                      : null

                if (req.method !== 'POST' || !endpoint) {
                    writeJsonResponse(res, 404, {
                        success: false,
                        error: 'Not found',
                    })
                    return
                }

                const rawBody = await readRequestBody(req)
                let parsedPayload: unknown = null

                try {
                    parsedPayload = JSON.parse(rawBody)
                } catch {
                    parsedPayload = null
                }

                payloads.push({
                    endpoint,
                    payload: isRecord(parsedPayload) ? parsedPayload : null,
                    rawBody,
                })

                if (endpoint === 'inlet') {
                    writeJsonResponse(res, 200, {
                        success: true,
                        balance: 20,
                        used_balance: 0,
                        message: 'Captured inlet payload',
                    })
                    return
                }

                writeJsonResponse(res, 200, {
                    success: true,
                    inputTokens: 12,
                    outputTokens: 8,
                    totalCost: 0.000001,
                    newBalance: 19.999999,
                })
            } catch (error) {
                writeJsonResponse(res, 500, {
                    success: false,
                    error:
                        error instanceof Error
                            ? error.message
                            : 'Capture server error',
                })
            }
        }
    )

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve())
    })

    return {
        port,
        payloads,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error?: Error) => {
                    if (error) {
                        reject(error)
                        return
                    }
                    resolve()
                })
            }),
    }
}

function summarizeCapturedPayload(
    capture: CapturedMonitorPayload
): CapturedPayloadSummary {
    const payload = capture.payload
    const user = getRecordField(payload, 'user')
    const metadata = getRecordField(payload, 'metadata')
    const metadataUser = getRecordField(metadata, 'user')
    const body = getRecordField(payload, 'body')
    const messages = Array.isArray(body?.messages) ? body.messages : null

    return {
        endpoint: capture.endpoint,
        user_keys: user ? Object.keys(user).sort() : [],
        user_has_id: typeof user?.id === 'string' && user.id.length > 0,
        user_has_email:
            typeof user?.email === 'string' && user.email.length > 0,
        user_has_name: typeof user?.name === 'string' && user.name.length > 0,
        metadata_keys: metadata ? Object.keys(metadata).sort() : [],
        metadata_has_user_id:
            (typeof metadataUser?.id === 'string' &&
                metadataUser.id.length > 0) ||
            (typeof metadata?.user_id === 'string' &&
                metadata.user_id.length > 0),
        body_model_type: typeof body?.model,
        body_message_count: messages ? messages.length : null,
    }
}

async function waitForCapturedMonitorPayloads(
    payloads: CapturedMonitorPayload[]
) {
    const startedAt = Date.now()

    while (Date.now() - startedAt < 30_000) {
        const endpoints = new Set(payloads.map((payload) => payload.endpoint))

        if (endpoints.has('inlet') && endpoints.has('outlet')) {
            return
        }

        await sleep(500)
    }

    throw new Error(
        `Timed out waiting for captured OpenWebUI monitor payloads: ${JSON.stringify(
            payloads.map(summarizeCapturedPayload),
            null,
            2
        )}`
    )
}

async function waitForCapturedMonitorPayloadCount(
    payloads: CapturedMonitorPayload[],
    expectedCount: number,
    description: string
) {
    const startedAt = Date.now()

    while (Date.now() - startedAt < 60_000) {
        if (payloads.length >= expectedCount) {
            return
        }

        await sleep(500)
    }

    throw new Error(
        `Timed out waiting for captured OpenWebUI monitor payload count: ${description}\n${JSON.stringify(
            payloads.map(summarizeCapturedPayload),
            null,
            2
        )}`
    )
}

async function removeDockerContainer(name: string) {
    await runCommand('docker', ['rm', '-f', name], {
        logFilePath: path.join(LOGS_DIR, `docker-rm-${name}.log`),
        acceptableExitCodes: [0, 1],
    })
}

function jsonHeaders(token?: string) {
    return {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
}

async function requestJson<T>(
    url: string,
    init: RequestInit = {},
    {
        expectOk = true,
    }: {
        expectOk?: boolean
    } = {}
) {
    const response = await fetch(url, {
        ...init,
        cache: 'no-store',
    })

    const responseText = await response.text()
    let data: T | null = null

    if (responseText) {
        try {
            data = JSON.parse(responseText) as T
        } catch {
            data = null
        }
    }

    if (expectOk && !response.ok) {
        throw new Error(
            `Request failed for ${url}: ${response.status} ${responseText}`
        )
    }

    return { status: response.status, data, responseText }
}

async function requestText(url: string, init: RequestInit = {}) {
    const response = await fetch(url, {
        ...init,
        cache: 'no-store',
    })
    const bodyText = await response.text()

    if (!response.ok) {
        throw new Error(
            `Request failed for ${url}: ${response.status} ${bodyText}`
        )
    }

    return { status: response.status, bodyText }
}

async function signUpInitialAdmin(): Promise<OpenWebUISession> {
    const { data } = await requestJson<OpenWebUISession>(
        `${OWU_BASE_URL}/api/v1/auths/signup`,
        {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify(ADMIN_USER),
        }
    )

    assert(data, 'Missing signup response from OpenWebUI')
    return data
}

async function addOpenWebUIUser(
    adminToken: string,
    user: { email: string; password: string; name: string }
): Promise<OpenWebUISession> {
    const { data } = await requestJson<OpenWebUISession>(
        `${OWU_BASE_URL}/api/v1/auths/add`,
        {
            method: 'POST',
            headers: jsonHeaders(adminToken),
            body: JSON.stringify({
                ...user,
                role: 'user',
            }),
        }
    )

    assert(data, 'Missing add-user response from OpenWebUI')
    return data
}

async function updateOpenWebUIUserName(
    adminToken: string,
    userId: string,
    name: string
) {
    await requestJson(`${OWU_BASE_URL}/api/v1/users/${userId}/update`, {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({ name }),
    })
}

async function deleteOpenWebUIUser(adminToken: string, userId: string) {
    await requestJson<boolean>(`${OWU_BASE_URL}/api/v1/users/${userId}`, {
        method: 'DELETE',
        headers: jsonHeaders(adminToken),
    })
}

async function fetchOpenWebUIFunctionState(
    adminToken: string,
    functionId: string
) {
    const { data } = await requestJson<OpenWebUIFunctionState>(
        `${OWU_BASE_URL}/api/v1/functions/id/${functionId}`,
        {
            headers: jsonHeaders(adminToken),
        }
    )

    assert(data, `Missing OpenWebUI function state for ${functionId}`)
    return data
}

async function ensureOpenWebUIFunctionEnabled(
    adminToken: string,
    functionId: string
) {
    let functionState = await fetchOpenWebUIFunctionState(
        adminToken,
        functionId
    )

    if (!functionState.is_active) {
        await requestJson(
            `${OWU_BASE_URL}/api/v1/functions/id/${functionId}/toggle`,
            {
                method: 'POST',
                headers: jsonHeaders(adminToken),
            }
        )
    }

    functionState = await fetchOpenWebUIFunctionState(adminToken, functionId)

    if (!functionState.is_global) {
        await requestJson(
            `${OWU_BASE_URL}/api/v1/functions/id/${functionId}/toggle/global`,
            {
                method: 'POST',
                headers: jsonHeaders(adminToken),
            }
        )
    }

    functionState = await fetchOpenWebUIFunctionState(adminToken, functionId)

    assert(
        functionState.is_active,
        `OpenWebUI function ${functionId} should be active`
    )
    assert(
        functionState.is_global,
        `OpenWebUI function ${functionId} should be global`
    )
}

async function installMonitorFunction(
    adminToken: string,
    {
        apiEndpoint = `http://host.docker.internal:${MONITOR_PORT}`,
    }: {
        apiEndpoint?: string
    } = {}
) {
    const functionId = 'openwebui_monitor_e2e'
    const functionContent = await fs.readFile(
        path.join(ROOT_DIR, 'resources/functions/openwebui_monitor.py'),
        'utf8'
    )

    await requestJson<boolean>(
        `${OWU_BASE_URL}/api/v1/functions/id/${functionId}/delete`,
        {
            method: 'DELETE',
            headers: jsonHeaders(adminToken),
        },
        { expectOk: false }
    )

    await requestJson(`${OWU_BASE_URL}/api/v1/functions/create`, {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({
            id: functionId,
            name: 'OpenWebUI Monitor E2E',
            content: functionContent,
            meta: {},
        }),
    })

    await requestJson(
        `${OWU_BASE_URL}/api/v1/functions/id/${functionId}/valves/update`,
        {
            method: 'POST',
            headers: jsonHeaders(adminToken),
            body: JSON.stringify({
                api_endpoint: apiEndpoint,
                api_key: MONITOR_API_KEY,
                language: 'en',
                show_time_spent: true,
                show_tokens_per_sec: true,
                show_cost: true,
                show_balance: true,
                show_tokens: true,
            }),
        }
    )

    await ensureOpenWebUIFunctionEnabled(adminToken, functionId)
}

function normalizeOpenWebUIUsers(payload: unknown): OpenWebUIUser[] {
    if (Array.isArray(payload)) {
        return payload as OpenWebUIUser[]
    }

    if (payload && typeof payload === 'object') {
        const data = payload as { users?: unknown; data?: unknown }

        if (Array.isArray(data.users)) {
            return data.users as OpenWebUIUser[]
        }

        if (Array.isArray(data.data)) {
            return data.data as OpenWebUIUser[]
        }
    }

    throw new Error(
        `Unexpected OpenWebUI users payload: ${JSON.stringify(payload)}`
    )
}

async function fetchOpenWebUIUsers(
    adminToken: string
): Promise<OpenWebUIUser[]> {
    try {
        const users: OpenWebUIUser[] = []
        let page = 1
        let total: number | null = null

        while (true) {
            const response = await fetch(
                `${OWU_BASE_URL}/api/v1/users?page=${page}&order_by=created_at&direction=asc`,
                {
                    headers: jsonHeaders(adminToken),
                    cache: 'no-store',
                }
            )

            if (!response.ok) {
                throw new Error(
                    `Failed to fetch OpenWebUI users page ${page}: ${response.status} ${await response.text()}`
                )
            }

            const responseText = await response.text()
            let data: { users?: unknown[]; total?: number } | null = null

            try {
                data = JSON.parse(responseText) as {
                    users?: unknown[]
                    total?: number
                }
            } catch {
                throw new Error(
                    `Unexpected OpenWebUI users page payload: ${responseText}`
                )
            }

            const pageUsers = normalizeOpenWebUIUsers(data)

            if (total === null && typeof data.total === 'number') {
                total = data.total
            }

            if (pageUsers.length === 0) {
                break
            }

            users.push(...pageUsers)

            if ((total !== null && users.length >= total) || data.total === 0) {
                break
            }

            page += 1
        }

        if (users.length > 0 || total === 0) {
            return users
        }
    } catch (error) {
        console.warn(
            '[owu-e2e] Falling back to /api/v1/users/all for order verification:',
            error
        )
    }

    const { data } = await requestJson<unknown>(
        `${OWU_BASE_URL}/api/v1/users/all`,
        {
            headers: jsonHeaders(adminToken),
        }
    )

    return normalizeOpenWebUIUsers(data).reverse()
}

async function fetchMonitorUsers(): Promise<MonitorUsersResponse> {
    const { data } = await requestJson<MonitorUsersResponse>(
        `${MONITOR_BASE_URL}/api/v1/users?page=1&pageSize=100`,
        {
            headers: {
                Authorization: `Bearer ${MONITOR_ACCESS_TOKEN}`,
            },
        }
    )

    assert(data, 'Missing users response from monitor')
    return data
}

function findMonitorUser(usersResponse: MonitorUsersResponse, userId: string) {
    return usersResponse.users.find((user) => user.id === userId) || null
}

function assertMonitorOrderMatchesOpenWebUI(
    usersResponse: MonitorUsersResponse,
    openWebUIUsers: OpenWebUIUser[],
    description: string
) {
    const monitorUserIds = usersResponse.users.map((user) => user.id)
    const openWebUIUserIds = openWebUIUsers.map((user) => user.id)

    assert.deepEqual(
        monitorUserIds,
        openWebUIUserIds,
        `${description}\nmonitor=${JSON.stringify(monitorUserIds)}\nowu=${JSON.stringify(openWebUIUserIds)}`
    )
}

async function waitForUserSync(
    predicate: (users: MonitorUsersResponse) => boolean,
    description: string
) {
    const startedAt = Date.now()
    let lastUsersResponse: MonitorUsersResponse | null = null

    while (Date.now() - startedAt < 30_000) {
        lastUsersResponse = await fetchMonitorUsers()
        if (predicate(lastUsersResponse)) {
            return lastUsersResponse
        }

        await sleep(1000)
    }

    throw new Error(
        `Timed out waiting for user sync: ${description}\n${JSON.stringify(lastUsersResponse, null, 2)}`
    )
}

async function runOpenWebUIChat(userToken: string) {
    const prompt = 'Say hello in one sentence.'
    const userMessageId = randomUUID()
    const responseMessageId = randomUUID()
    const sessionId = `e2e-${randomUUID()}`

    const { data, responseText } = await requestJson<Record<string, unknown>>(
        `${OWU_BASE_URL}/api/chat/completions`,
        {
            method: 'POST',
            headers: jsonHeaders(userToken),
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                stream: false,
                messages: [
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                session_id: sessionId,
                id: responseMessageId,
                parent_id: null,
                user_message: {
                    id: userMessageId,
                    parentId: null,
                    childrenIds: [],
                    role: 'user',
                    content: prompt,
                    timestamp: Math.floor(Date.now() / 1000),
                    models: ['gpt-4o-mini'],
                },
            }),
        }
    )

    if (typeof data?.error === 'string' && data.error) {
        throw new Error(`OpenWebUI chat request returned error: ${data.error}`)
    }

    await fs.writeFile(
        path.join(ARTIFACTS_DIR, 'openwebui-chat-response.json'),
        responseText
    )

    assert(responseText.trim(), 'OpenWebUI chat response was empty')
}

const PNG_1X1_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s2R0f8AAAAASUVORK5CYII='

async function writeTinyPngFixture() {
    const imagePath = path.join(ARTIFACTS_DIR, 'mobile-upload.png')
    await fs.writeFile(imagePath, Buffer.from(PNG_1X1_BASE64, 'base64'))
    return imagePath
}

async function runOpenWebUIMobileImageChat(userToken: string) {
    const imagePath = await writeTinyPngFixture()
    const imageBuffer = await fs.readFile(imagePath)
    const uploadForm = new FormData()
    const mobileHeaders = {
        Authorization: `Bearer ${userToken}`,
        'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    }

    uploadForm.append(
        'file',
        new Blob([imageBuffer], { type: 'image/png' }),
        'mobile-upload.png'
    )

    const uploadResponse = await fetch(
        `${OWU_BASE_URL}/api/v1/files/?process=false`,
        {
            method: 'POST',
            headers: mobileHeaders,
            body: uploadForm,
        }
    )
    const uploadText = await uploadResponse.text()

    assert(
        uploadResponse.ok,
        `Mobile image upload failed: ${uploadResponse.status} ${uploadText}`
    )

    const uploadedFile = JSON.parse(uploadText) as {
        id: string
        filename?: string
        meta?: {
            content_type?: string
            collection_name?: string
        }
    }
    const imageFileItem = {
        type: 'file',
        file: uploadedFile,
        id: uploadedFile.id,
        url: uploadedFile.id,
        name: uploadedFile.filename || 'mobile-upload.png',
        collection_name: uploadedFile.meta?.collection_name || '',
        status: 'uploaded',
        size: imageBuffer.byteLength,
        content_type: uploadedFile.meta?.content_type || 'image/png',
    }

    const chatResponse = await requestJson<{ id: string }>(
        `${OWU_BASE_URL}/api/v1/chats/new`,
        {
            method: 'POST',
            headers: jsonHeaders(userToken),
            body: JSON.stringify({
                chat: {
                    title: 'Mobile Image E2E',
                    models: ['gpt-4o-mini'],
                    params: {},
                    history: {
                        messages: {},
                        currentId: null,
                    },
                    messages: [],
                    tags: [],
                    timestamp: Date.now(),
                },
                folder_id: null,
            }),
        }
    )
    assert(chatResponse.data?.id, 'Failed to create OpenWebUI chat')

    const chatId = chatResponse.data.id
    const historyMessages: Array<{
        id: string
        parentId: string | null
        childrenIds: string[]
        role: 'user' | 'assistant'
        content: string
        files?: unknown[]
        models?: string[]
        model?: string
        timestamp: number
        usage?: Record<string, unknown>
    }> = []

    const buildRequestMessages = () =>
        historyMessages
            .map((message) => {
                const imageFiles = (message.files || []).filter(
                    (file): file is Record<string, unknown> =>
                        isRecord(file) &&
                        (file.type === 'image' ||
                            (typeof file.content_type === 'string' &&
                                file.content_type.startsWith('image/')))
                )

                return {
                    role: message.role,
                    ...(message.usage ? { usage: message.usage } : {}),
                    content:
                        message.role === 'user' && imageFiles.length > 0
                            ? [
                                  {
                                      type: 'text',
                                      text: message.content,
                                  },
                                  ...imageFiles.map((file) => ({
                                      type: 'image_url',
                                      image_url: {
                                          url:
                                              typeof file.url === 'string'
                                                  ? file.url
                                                  : '',
                                      },
                                  })),
                              ]
                            : message.content,
                }
            })
            .filter((message) => {
                if (message.role === 'user') {
                    return true
                }

                return typeof message.content === 'string'
                    ? message.content.trim()
                    : true
            })

    const sendTurn = async (promptText: string, files?: unknown[]) => {
        const previousMessage = historyMessages.at(-1)
        const userMessageId = randomUUID()
        const responseMessageId = randomUUID()
        const userMessage = {
            id: userMessageId,
            parentId: previousMessage?.id || null,
            childrenIds: [responseMessageId],
            role: 'user' as const,
            content: promptText,
            ...(files && files.length > 0 ? { files } : {}),
            timestamp: Math.floor(Date.now() / 1000),
            models: ['gpt-4o-mini'],
        }

        if (previousMessage) {
            previousMessage.childrenIds.push(userMessageId)
        }

        historyMessages.push(userMessage)

        const { data, responseText, status } = await requestJson<{
            choices?: Array<{
                message?: {
                    content?: string
                }
            }>
            usage?: Record<string, unknown>
        }>(
            `${OWU_BASE_URL}/api/chat/completions`,
            {
                method: 'POST',
                headers: {
                    ...jsonHeaders(userToken),
                    'User-Agent': mobileHeaders['User-Agent'],
                },
                body: JSON.stringify({
                    stream: false,
                    model: 'gpt-4o-mini',
                    messages: buildRequestMessages(),
                    params: {},
                    features: {},
                    variables: {},
                    model_item: {},
                    chat_id: chatId,
                    id: responseMessageId,
                    parent_id: userMessage.id,
                    parent_message: userMessage,
                    background_tasks: {
                        follow_up_generation: false,
                    },
                }),
            },
            { expectOk: false }
        )

        assert.equal(
            status,
            200,
            `OpenWebUI mobile image turn failed: ${status} ${responseText}`
        )

        const assistantContent =
            data?.choices?.[0]?.message?.content ||
            'Hello from the mock OpenAI server.'
        historyMessages.push({
            id: responseMessageId,
            parentId: userMessage.id,
            childrenIds: [],
            role: 'assistant',
            content: assistantContent,
            model: 'gpt-4o-mini',
            timestamp: Math.floor(Date.now() / 1000),
            ...(data?.usage ? { usage: data.usage } : {}),
        })
    }

    await sendTurn('Describe this image in one short sentence.', [
        imageFileItem,
    ])
    await sendTurn('Continue in one sentence.')
    await sendTurn('One more short follow-up.')

    return {
        chat_id: chatId,
        replies: 3,
        uploaded_file_id: uploadedFile.id,
    }
}

async function runOpenWebUIDesktopMultiImageChat(
    userToken: string,
    imageCount = 15
) {
    const chatResponse = await requestJson<{ id: string }>(
        `${OWU_BASE_URL}/api/v1/chats/new`,
        {
            method: 'POST',
            headers: jsonHeaders(userToken),
            body: JSON.stringify({
                chat: {
                    title: 'Desktop Multi Image E2E',
                    models: ['gpt-4o-mini'],
                    params: {},
                    history: {
                        messages: {},
                        currentId: null,
                    },
                    messages: [],
                    tags: [],
                    timestamp: Date.now(),
                },
                folder_id: null,
            }),
        }
    )
    assert(chatResponse.data?.id, 'Failed to create OpenWebUI chat')

    const chatId = chatResponse.data.id
    const imagePayload = `data:image/png;base64,${'A'.repeat(1024 * 1024)}`
    const historyMessages: Array<{
        id: string
        parentId: string | null
        childrenIds: string[]
        role: 'user' | 'assistant'
        content: string
        files?: unknown[]
        models?: string[]
        model?: string
        timestamp: number
        usage?: Record<string, unknown>
    }> = []

    const buildRequestMessages = () =>
        historyMessages
            .map((message) => {
                const imageFiles = (message.files || []).filter(
                    (file): file is Record<string, unknown> =>
                        isRecord(file) &&
                        (file.type === 'image' ||
                            (typeof file.content_type === 'string' &&
                                file.content_type.startsWith('image/')))
                )

                return {
                    role: message.role,
                    ...(message.usage ? { usage: message.usage } : {}),
                    content:
                        message.role === 'user' && imageFiles.length > 0
                            ? [
                                  {
                                      type: 'text',
                                      text: message.content,
                                  },
                                  ...imageFiles.map((file) => ({
                                      type: 'image_url',
                                      image_url: {
                                          url:
                                              typeof file.url === 'string'
                                                  ? file.url
                                                  : '',
                                      },
                                  })),
                              ]
                            : message.content,
                }
            })
            .filter((message) => {
                if (message.role === 'user') {
                    return true
                }

                return typeof message.content === 'string'
                    ? message.content.trim()
                    : true
            })

    const sendTurn = async (promptText: string, files?: unknown[]) => {
        const previousMessage = historyMessages.at(-1)
        const userMessageId = randomUUID()
        const responseMessageId = randomUUID()
        const userMessage = {
            id: userMessageId,
            parentId: previousMessage?.id || null,
            childrenIds: [responseMessageId],
            role: 'user' as const,
            content: promptText,
            ...(files && files.length > 0 ? { files } : {}),
            timestamp: Math.floor(Date.now() / 1000),
            models: ['gpt-4o-mini'],
        }

        if (previousMessage) {
            previousMessage.childrenIds.push(userMessageId)
        }

        historyMessages.push(userMessage)

        const { data, responseText, status } = await requestJson<{
            choices?: Array<{
                message?: {
                    content?: string
                }
            }>
            usage?: Record<string, unknown>
        }>(
            `${OWU_BASE_URL}/api/chat/completions`,
            {
                method: 'POST',
                headers: jsonHeaders(userToken),
                body: JSON.stringify({
                    stream: false,
                    model: 'gpt-4o-mini',
                    messages: buildRequestMessages(),
                    params: {},
                    features: {},
                    variables: {},
                    model_item: {},
                    chat_id: chatId,
                    id: responseMessageId,
                    parent_id: userMessage.id,
                    parent_message: userMessage,
                    background_tasks: {
                        follow_up_generation: false,
                    },
                }),
            },
            { expectOk: false }
        )

        assert.equal(
            status,
            200,
            `OpenWebUI desktop multi-image turn failed: ${status} ${responseText}`
        )

        historyMessages.push({
            id: responseMessageId,
            parentId: userMessage.id,
            childrenIds: [],
            role: 'assistant',
            content:
                data?.choices?.[0]?.message?.content ||
                'Hello from the mock OpenAI server.',
            model: 'gpt-4o-mini',
            timestamp: Math.floor(Date.now() / 1000),
            ...(data?.usage ? { usage: data.usage } : {}),
        })
    }

    await sendTurn('First plain desktop message.')
    await sendTurn(
        'Second desktop message with many images.',
        Array.from({ length: imageCount }, (_, index) => ({
            type: 'image',
            url: imagePayload,
            name: `desktop-image-${index + 1}.png`,
            content_type: 'image/png',
        }))
    )

    return {
        chat_id: chatId,
        replies: 2,
        image_count: imageCount,
        image_data_url_chars: imagePayload.length,
    }
}

async function runOpenWebUITemporaryDataUrlImageChat(userToken: string) {
    const chatId = `local:e2e-${randomUUID()}`
    const dataUrl = `data:image/png;base64,${'A'.repeat(11 * 1024 * 1024)}`
    const historyMessages: Array<{
        id: string
        parentId: string | null
        childrenIds: string[]
        role: 'user' | 'assistant'
        content: string
        files?: unknown[]
        model?: string
        timestamp: number
        usage?: Record<string, unknown>
    }> = []

    const buildRequestMessages = () =>
        historyMessages
            .map((message) => {
                const imageFiles = (message.files || []).filter(
                    (file): file is Record<string, unknown> =>
                        isRecord(file) &&
                        (file.type === 'image' ||
                            (typeof file.content_type === 'string' &&
                                file.content_type.startsWith('image/')))
                )

                return {
                    role: message.role,
                    ...(message.usage ? { usage: message.usage } : {}),
                    content:
                        message.role === 'user' && imageFiles.length > 0
                            ? [
                                  {
                                      type: 'text',
                                      text: message.content,
                                  },
                                  ...imageFiles.map((file) => ({
                                      type: 'image_url',
                                      image_url: {
                                          url:
                                              typeof file.url === 'string'
                                                  ? file.url
                                                  : '',
                                      },
                                  })),
                              ]
                            : message.content,
                }
            })
            .filter((message) => {
                if (message.role === 'user') {
                    return true
                }

                return typeof message.content === 'string'
                    ? message.content.trim()
                    : true
            })

    const sendTurn = async (promptText: string, files?: unknown[]) => {
        const previousMessage = historyMessages.at(-1)
        const userMessageId = randomUUID()
        const responseMessageId = randomUUID()
        const userMessage = {
            id: userMessageId,
            parentId: previousMessage?.id || null,
            childrenIds: [responseMessageId],
            role: 'user' as const,
            content: promptText,
            ...(files && files.length > 0 ? { files } : {}),
            timestamp: Math.floor(Date.now() / 1000),
            models: ['gpt-4o-mini'],
        }

        if (previousMessage) {
            previousMessage.childrenIds.push(userMessageId)
        }

        historyMessages.push(userMessage)

        const { data, responseText, status } = await requestJson<{
            choices?: Array<{
                message?: {
                    content?: string
                }
            }>
            usage?: Record<string, unknown>
        }>(
            `${OWU_BASE_URL}/api/chat/completions`,
            {
                method: 'POST',
                headers: jsonHeaders(userToken),
                body: JSON.stringify({
                    stream: false,
                    model: 'gpt-4o-mini',
                    messages: buildRequestMessages(),
                    params: {},
                    features: {},
                    variables: {},
                    model_item: {},
                    chat_id: chatId,
                    id: responseMessageId,
                    parent_id: userMessage.id,
                    parent_message: userMessage,
                    background_tasks: {
                        follow_up_generation: false,
                    },
                }),
            },
            { expectOk: false }
        )

        assert.equal(
            status,
            200,
            `OpenWebUI temporary data-url image turn failed: ${status} ${responseText}`
        )

        historyMessages.push({
            id: responseMessageId,
            parentId: userMessage.id,
            childrenIds: [],
            role: 'assistant',
            content:
                data?.choices?.[0]?.message?.content ||
                'Hello from the mock OpenAI server.',
            model: 'gpt-4o-mini',
            timestamp: Math.floor(Date.now() / 1000),
            ...(data?.usage ? { usage: data.usage } : {}),
        })
    }

    await sendTurn('Describe this temporary image briefly.', [
        {
            type: 'image',
            url: dataUrl,
        },
    ])
    await sendTurn('Continue from that image.')
    await sendTurn('One more follow-up for the same image.')

    return {
        chat_id: chatId,
        replies: 3,
        data_url_chars: dataUrl.length,
    }
}

async function captureOpenWebUIFunctionPayloads(
    adminToken: string
): Promise<OpenWebUIPayloadCaptureSummary> {
    const captureServer = await startMonitorCaptureServer()

    try {
        await waitForHttp(`http://127.0.0.1:${captureServer.port}/health`, {
            validate: (response) => response.ok,
        })

        await installMonitorFunction(adminToken, {
            apiEndpoint: `http://host.docker.internal:${captureServer.port}`,
        })

        await runOpenWebUIChat(adminToken)
        await waitForCapturedMonitorPayloads(captureServer.payloads)
        const chatApiPayloadCount = captureServer.payloads.length

        await runOpenWebUIDesktopMultiImageChat(adminToken)
        await waitForCapturedMonitorPayloadCount(
            captureServer.payloads,
            chatApiPayloadCount + 4,
            'desktop second-turn 15-image chat should call inlet and outlet for both turns'
        )
        const desktopMultiImagePayloadCount = captureServer.payloads.length

        await runOpenWebUIMobileImageChat(adminToken)
        await waitForCapturedMonitorPayloadCount(
            captureServer.payloads,
            desktopMultiImagePayloadCount + 6,
            'mobile image upload chat should call inlet and outlet for all three turns'
        )
        const mobileImagePayloadCount = captureServer.payloads.length

        await runOpenWebUITemporaryDataUrlImageChat(adminToken)
        await waitForCapturedMonitorPayloadCount(
            captureServer.payloads,
            mobileImagePayloadCount + 6,
            'temporary data-url image chat should call inlet and outlet for all three turns'
        )

        const payloadPath = path.join(
            ARTIFACTS_DIR,
            'openwebui-function-payloads.json'
        )
        await fs.writeFile(
            payloadPath,
            JSON.stringify(captureServer.payloads, null, 4)
        )

        const chatApi = captureServer.payloads.map(summarizeCapturedPayload)

        assert(
            chatApi.every((payload) => payload.user_has_id),
            `OpenWebUI function payloads should include a stable user id\n${JSON.stringify(chatApi, null, 2)}`
        )

        return {
            chat_api: chatApi.slice(0, chatApiPayloadCount),
            desktop_multi_image_chat_api: chatApi.slice(
                chatApiPayloadCount,
                desktopMultiImagePayloadCount
            ),
            desktop_multi_image_chat_api_body_bytes: captureServer.payloads
                .slice(chatApiPayloadCount, desktopMultiImagePayloadCount)
                .map((payload) => Buffer.byteLength(payload.rawBody, 'utf8')),
            mobile_image_chat_api: chatApi.slice(
                desktopMultiImagePayloadCount,
                mobileImagePayloadCount
            ),
            mobile_image_chat_api_body_bytes: captureServer.payloads
                .slice(desktopMultiImagePayloadCount, mobileImagePayloadCount)
                .map((payload) => Buffer.byteLength(payload.rawBody, 'utf8')),
            temporary_data_url_image_chat_api: chatApi.slice(
                mobileImagePayloadCount
            ),
            temporary_data_url_image_chat_api_body_bytes: captureServer.payloads
                .slice(mobileImagePayloadCount)
                .map((payload) => Buffer.byteLength(payload.rawBody, 'utf8')),
        }
    } finally {
        await captureServer.close()
    }
}

async function injectImageUsage(user: {
    id: string
    name: string
    email: string
    role: string
}) {
    const { data } = await requestJson<{
        success: boolean
        inputTokens: number
        outputTokens: number
    }>(`${MONITOR_BASE_URL}/api/v1/outlet`, {
        method: 'POST',
        headers: jsonHeaders(MONITOR_API_KEY),
        body: JSON.stringify({
            user,
            body: {
                model: 'gpt-image-1',
                messages: [
                    {
                        role: 'user',
                        content: 'Generate a tiny placeholder image.',
                    },
                    {
                        role: 'assistant',
                        content: 'Image generated.',
                        info: {
                            usage: {
                                input_tokens: 123,
                                output_tokens: 45,
                                total_tokens: 168,
                            },
                        },
                    },
                ],
            },
        }),
    })

    assert(data?.success, 'Image usage injection failed')
}

async function injectChatUsage(user: {
    id: string
    name: string
    email: string
    role: string
}) {
    const { data } = await requestJson<{
        success: boolean
        inputTokens: number
        outputTokens: number
    }>(`${MONITOR_BASE_URL}/api/v1/outlet`, {
        method: 'POST',
        headers: jsonHeaders(MONITOR_API_KEY),
        body: JSON.stringify({
            user,
            body: {
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'user',
                        content: 'Say hello in one sentence.',
                    },
                    {
                        role: 'assistant',
                        content: 'Hello from the injected chat usage payload.',
                        usage: {
                            prompt_tokens: 1_000_000,
                            completion_tokens: 1,
                            total_tokens: 1_000_001,
                        },
                    },
                ],
            },
        }),
    })

    assert(data?.success, 'Chat usage injection failed')
}

async function runMonitorPayloadCompatibilityChecks() {
    const partialUserId = `mobile-partial-${randomUUID()}`
    const metadataUserId = `mobile-metadata-${randomUUID()}`
    const metadataUserIdOnly = `mobile-metadata-id-${randomUUID()}`
    const outletUserId = `mobile-outlet-${randomUUID()}`

    const partialUserInlet = await requestJson<{
        success: boolean
        balance: number
    }>(`${MONITOR_BASE_URL}/api/v1/inlet`, {
        method: 'POST',
        headers: jsonHeaders(MONITOR_API_KEY),
        body: JSON.stringify({
            user: {
                id: partialUserId,
                role: 'user',
            },
            body: {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'mobile inlet shape' }],
            },
        }),
    })

    assert(
        partialUserInlet.data?.success,
        'Inlet should accept user payloads that include id but omit email/name'
    )

    const metadataOnlyInlet = await requestJson<{
        success: boolean
    }>(`${MONITOR_BASE_URL}/api/v1/inlet`, {
        method: 'POST',
        headers: jsonHeaders(MONITOR_API_KEY),
        body: JSON.stringify({
            user: {},
            metadata: {
                user: {
                    id: metadataUserId,
                    name: 'Mobile Metadata User',
                },
            },
            body: {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'metadata user shape' }],
            },
        }),
    })

    assert(
        metadataOnlyInlet.data?.success,
        'Inlet should recover the billing user from metadata when user is sparse'
    )

    const metadataUserIdInlet = await requestJson<{
        success: boolean
    }>(`${MONITOR_BASE_URL}/api/v1/inlet`, {
        method: 'POST',
        headers: jsonHeaders(MONITOR_API_KEY),
        body: JSON.stringify({
            user: {},
            metadata: {
                user_id: metadataUserIdOnly,
            },
            body: {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'metadata user id shape' }],
            },
        }),
    })

    assert(
        metadataUserIdInlet.data?.success,
        'Inlet should recover the billing user from OpenWebUI metadata.user_id'
    )

    const missingUserIdInlet = await requestJson<{
        success: boolean
        error_type?: string
    }>(
        `${MONITOR_BASE_URL}/api/v1/inlet`,
        {
            method: 'POST',
            headers: jsonHeaders(MONITOR_API_KEY),
            body: JSON.stringify({
                user: {
                    name: 'No Id User',
                },
                body: {
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: 'missing id' }],
                },
            }),
        },
        { expectOk: false }
    )

    assert.equal(
        missingUserIdInlet.status,
        400,
        'Inlet should return a clear 400 when no user id is available'
    )
    assert.equal(
        missingUserIdInlet.data?.error_type,
        'MISSING_USER_ID',
        'Inlet should expose MISSING_USER_ID for sparse payload debugging'
    )

    const invalidJsonInletResponse = await fetch(
        `${MONITOR_BASE_URL}/api/v1/inlet`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${MONITOR_API_KEY}`,
            },
            body: '{"user":',
        }
    )
    const invalidJsonInlet = await invalidJsonInletResponse.json()

    assert.equal(
        invalidJsonInletResponse.status,
        400,
        'Inlet should return 400 for invalid JSON payloads'
    )
    assert.equal(
        invalidJsonInlet.error_type,
        'INVALID_JSON',
        'Inlet should expose INVALID_JSON for malformed or truncated payloads'
    )

    const partialUserOutlet = await requestJson<{
        success: boolean
    }>(`${MONITOR_BASE_URL}/api/v1/outlet`, {
        method: 'POST',
        headers: jsonHeaders(MONITOR_API_KEY),
        body: JSON.stringify({
            user: {
                id: outletUserId,
            },
            body: {
                model: 'payload-compat-model',
                messages: [
                    {
                        role: 'user',
                        content: 'outlet sparse user',
                    },
                    {
                        role: 'assistant',
                        content: 'ok',
                        usage: {
                            prompt_tokens: 1,
                            completion_tokens: 1,
                            total_tokens: 2,
                        },
                    },
                ],
            },
        }),
    })

    assert(
        partialUserOutlet.data?.success,
        'Outlet should accept user payloads that include id but omit email/name'
    )

    return {
        partial_user_inlet: true,
        metadata_user_inlet: true,
        metadata_user_id_inlet: true,
        missing_user_id_returns_400: true,
        invalid_json_inlet_returns_400: true,
        partial_user_outlet: true,
    }
}

async function fetchMonitorRecords(): Promise<MonitorRecordsResponse> {
    const { data } = await requestJson<MonitorRecordsResponse>(
        `${MONITOR_BASE_URL}/api/v1/panel/records?page=1&pageSize=50`,
        {
            headers: {
                Authorization: `Bearer ${MONITOR_ACCESS_TOKEN}`,
            },
        }
    )

    assert(data, 'Missing records response from monitor')
    return data
}

async function waitForRecords() {
    const startedAt = Date.now()
    let lastRecordsResponse: MonitorRecordsResponse | null = null

    while (Date.now() - startedAt < 30_000) {
        lastRecordsResponse = await fetchMonitorRecords()
        const models = new Set(
            lastRecordsResponse.records.map((record) => record.model_name)
        )

        if (models.has('gpt-4o-mini') && models.has('gpt-image-1')) {
            return lastRecordsResponse
        }

        await sleep(1000)
    }

    throw new Error(
        `Timed out waiting for expected usage records\n${JSON.stringify(lastRecordsResponse, null, 2)}`
    )
}

async function fetchDatabaseExport(): Promise<DatabaseExportPayload> {
    const { data } = await requestJson<DatabaseExportPayload>(
        `${MONITOR_BASE_URL}/api/v1/panel/database/export`,
        {
            headers: {
                Authorization: `Bearer ${MONITOR_ACCESS_TOKEN}`,
            },
        }
    )

    assert(data, 'Missing database export payload')
    return data
}

async function runMonitorApiChecks(): Promise<ApiCheckSummary> {
    const { data: modelsData } = await requestJson<Array<{ id: string }>>(
        `${MONITOR_BASE_URL}/api/v1/models`,
        {
            headers: {
                Authorization: `Bearer ${MONITOR_ACCESS_TOKEN}`,
            },
        }
    )

    assert(
        modelsData?.some((model) => model.id === 'gpt-4o-mini'),
        'Monitor models API did not return gpt-4o-mini'
    )

    const modelTest = await requestJson<{ success: boolean }>(
        `${MONITOR_BASE_URL}/api/v1/models/test`,
        {
            method: 'POST',
            headers: jsonHeaders(MONITOR_ACCESS_TOKEN),
            body: JSON.stringify({ modelId: 'gpt-4o-mini' }),
        }
    )

    const syncAll = await requestJson<{ success: boolean }>(
        `${MONITOR_BASE_URL}/api/v1/models/sync-all-prices`,
        {
            method: 'POST',
            headers: jsonHeaders(MONITOR_ACCESS_TOKEN),
        }
    )

    const recordsExport = await requestText(
        `${MONITOR_BASE_URL}/api/v1/panel/records/export`,
        {
            headers: {
                Authorization: `Bearer ${MONITOR_ACCESS_TOKEN}`,
            },
        }
    )

    const databaseExport = await requestText(
        `${MONITOR_BASE_URL}/api/v1/panel/database/export`,
        {
            headers: {
                Authorization: `Bearer ${MONITOR_ACCESS_TOKEN}`,
            },
        }
    )

    assert(
        recordsExport.bodyText.includes('gpt-4o-mini'),
        'Records export did not include the chat model'
    )
    assert(
        databaseExport.bodyText.includes('user_usage_records'),
        'Database export did not include usage data'
    )

    return {
        models_page: 'ok',
        model_test: {
            status: modelTest.status,
            success: Boolean(modelTest.data?.success),
        },
        sync_all: {
            status: syncAll.status,
            success: Boolean(syncAll.data?.success),
        },
        records_export: {
            status: recordsExport.status,
        },
        database_export: {
            status: databaseExport.status,
        },
    }
}

async function updateMonitorModelPrice(update: {
    id: string
    input_price: number
    output_price: number
    per_msg_price: number
}) {
    await requestJson<Array<{ id: string }>>(
        `${MONITOR_BASE_URL}/api/v1/models`,
        {
            headers: {
                Authorization: `Bearer ${MONITOR_ACCESS_TOKEN}`,
            },
        }
    )

    const { data } = await requestJson<{
        success: boolean
        results?: Array<{ success: boolean }>
    }>(`${MONITOR_BASE_URL}/api/v1/models/price`, {
        method: 'POST',
        headers: jsonHeaders(MONITOR_ACCESS_TOKEN),
        body: JSON.stringify([update]),
    })

    assert(data?.success, `Failed to update model price for ${update.id}`)
    assert(
        data?.results?.[0]?.success,
        `Model price update did not succeed for ${update.id}`
    )
}

async function runChromiumChecks(
    packageVersion: string,
    adminUserId: string
): Promise<ChromiumCheckSummary> {
    const browser = await chromium.launch({
        headless: process.env.E2E_HEADLESS !== '0',
    })

    const screenshots: Record<string, string> = {}
    let usersListRequestCount = 0
    const updatedBalanceValue = '42.424242'

    try {
        const context = await browser.newContext({
            locale: 'en-US',
            viewport: { width: 1440, height: 1100 },
        })

        await context.route(
            'https://api.github.com/repos/variantconst/openwebui-monitor/releases/latest',
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        tag_name: `v${packageVersion}`,
                    }),
                })
            }
        )

        const page = await context.newPage()

        page.on('request', (request) => {
            if (
                request.method() === 'GET' &&
                request
                    .url()
                    .startsWith(`${MONITOR_BASE_URL}/api/v1/users?page=`)
            ) {
                usersListRequestCount += 1
            }
        })

        await page.goto(`${MONITOR_BASE_URL}/token`, {
            waitUntil: 'networkidle',
        })
        await page.waitForSelector('#token')
        screenshots.token = path.join(SCREENSHOTS_DIR, 'token.png')
        await page.screenshot({ path: screenshots.token, fullPage: true })

        await page.fill('#token', MONITOR_ACCESS_TOKEN)
        await page.getByRole('button', { name: 'Confirm' }).click()
        await page.waitForURL(`${MONITOR_BASE_URL}/`, {
            timeout: 30_000,
        })
        await page.waitForLoadState('networkidle')

        screenshots.home = path.join(SCREENSHOTS_DIR, 'home.png')
        await page.screenshot({ path: screenshots.home, fullPage: true })

        await page.goto(`${MONITOR_BASE_URL}/models`, {
            waitUntil: 'networkidle',
        })
        await page.waitForSelector('text=Model Management')
        await page.waitForSelector('text=gpt-4o-mini')
        screenshots.models = path.join(SCREENSHOTS_DIR, 'models.png')
        await page.screenshot({ path: screenshots.models, fullPage: true })

        await page.goto(`${MONITOR_BASE_URL}/users`, {
            waitUntil: 'networkidle',
        })
        await page.waitForSelector('text=User Management')
        await page.waitForSelector('text=Used Balance')
        await page.waitForSelector('text=Remaining Balance')
        await page.waitForSelector(`text=${ADMIN_USER.email}`)

        const adminRow = page
            .locator('tr')
            .filter({ hasText: ADMIN_USER.email })
            .first()
        await adminRow.waitFor()

        const usersListRequestsBeforeBalanceUpdate = usersListRequestCount

        await adminRow.locator('td').nth(2).click()
        await adminRow
            .locator('.editable-cell-input input')
            .fill(updatedBalanceValue)

        const updateBalanceResponse = page.waitForResponse(
            (response) =>
                response
                    .url()
                    .includes(`/api/v1/users/${adminUserId}/balance`) &&
                response.request().method() === 'PUT'
        )

        await adminRow.locator('.editable-cell-input button').click()
        await updateBalanceResponse
        await page.waitForTimeout(750)

        assert.equal(
            usersListRequestCount,
            usersListRequestsBeforeBalanceUpdate,
            'Updating user balance should not refetch the users list'
        )
        assert(
            (await adminRow.locator('td').nth(2).textContent())?.includes(
                updatedBalanceValue
            ),
            'Updated balance was not reflected in the users table'
        )

        const usersListRequestsBeforeReset = usersListRequestCount
        const resetUsedBalanceResponse = page.waitForResponse(
            (response) =>
                response
                    .url()
                    .includes(
                        `/api/v1/users/${adminUserId}/used-balance/reset`
                    ) && response.request().method() === 'POST'
        )

        await page
            .locator(
                `[data-testid="reset-used-balance-${adminUserId}"]:visible`
            )
            .first()
            .click()
        await resetUsedBalanceResponse
        await page.waitForTimeout(750)

        assert.equal(
            usersListRequestCount,
            usersListRequestsBeforeReset,
            'Resetting used balance should not refetch the users list'
        )
        assert(
            (await adminRow.locator('td').nth(1).textContent())?.includes(
                '0.000000'
            ),
            'Reset used balance was not reflected in the users table'
        )

        screenshots.users = path.join(SCREENSHOTS_DIR, 'users.png')
        await page.screenshot({ path: screenshots.users, fullPage: true })

        await page.goto(`${MONITOR_BASE_URL}/records`, {
            waitUntil: 'networkidle',
        })
        await page.waitForSelector('text=Usage Records')
        await page.waitForSelector('text=gpt-4o-mini')
        await page.waitForSelector('text=gpt-image-1')
        screenshots.records = path.join(SCREENSHOTS_DIR, 'records.png')
        await page.screenshot({ path: screenshots.records, fullPage: true })

        await page.goto(`${MONITOR_BASE_URL}/panel`, {
            waitUntil: 'networkidle',
        })
        await page.waitForSelector('text=Usage Statistics')
        screenshots.panel = path.join(SCREENSHOTS_DIR, 'panel.png')
        await page.screenshot({ path: screenshots.panel, fullPage: true })

        await context.close()
    } finally {
        await browser.close()
    }

    return {
        screenshots,
        users_page: {
            updated_balance: Number(updatedBalanceValue),
            balance_update_without_refetch: true,
            used_balance_reset_without_refetch: true,
        },
    }
}

async function main() {
    MOCK_PORT = await choosePort(MOCK_PORT)
    OWU_PORT = await choosePort(OWU_PORT)
    MONITOR_PORT = await choosePort(MONITOR_PORT)
    POSTGRES_PORT = await choosePort(POSTGRES_PORT)
    refreshRuntimeUrls()

    await ensureArtifactsDirs()

    const cleanup = new CleanupStack()

    try {
        logStep(
            `Using ports mock=${MOCK_PORT}, owu=${OWU_PORT}, monitor=${MONITOR_PORT}, postgres=${POSTGRES_PORT}`
        )

        const packageJson = JSON.parse(
            await fs.readFile(path.join(ROOT_DIR, 'package.json'), 'utf8')
        ) as { version: string }

        if (process.env.E2E_SKIP_BROWSER_INSTALL !== '1') {
            logStep('Ensuring Playwright Chromium is installed')
            await runCommand(
                'pnpm',
                ['exec', 'playwright', 'install', 'chromium'],
                {
                    logFilePath: path.join(LOGS_DIR, 'playwright-install.log'),
                }
            )
        }

        logStep('Starting mock OpenAI server')
        const mockServer = await startBackgroundProcess(
            'mock-openai-server',
            'pnpm',
            ['exec', 'tsx', 'scripts/e2e/mock-openai-server.ts'],
            {
                env: {
                    ...process.env,
                    MOCK_OPENAI_PORT: String(MOCK_PORT),
                },
            }
        )
        cleanup.push(() => stopBackgroundProcess(mockServer))
        await waitForHttp(`${MOCK_BASE_URL}/health`, {
            validate: (response) => response.ok,
        })

        logStep('Starting PostgreSQL test container')
        await removeDockerContainer(POSTGRES_CONTAINER_NAME)
        cleanup.push(() => removeDockerContainer(POSTGRES_CONTAINER_NAME))
        await runCommand(
            'docker',
            [
                'run',
                '-d',
                '--rm',
                '--name',
                POSTGRES_CONTAINER_NAME,
                '-e',
                'POSTGRES_PASSWORD=openwebui',
                '-e',
                'POSTGRES_DB=openwebui_monitor',
                '-p',
                `${POSTGRES_PORT}:5432`,
                POSTGRES_IMAGE,
            ],
            {
                logFilePath: path.join(LOGS_DIR, 'postgres-run.log'),
            }
        )
        await waitForTcpPort('127.0.0.1', POSTGRES_PORT)

        logStep(`Starting OpenWebUI test container (${OWU_IMAGE})`)
        await removeDockerContainer(OWU_CONTAINER_NAME)
        cleanup.push(() => removeDockerContainer(OWU_CONTAINER_NAME))
        await runCommand(
            'docker',
            [
                'run',
                '-d',
                '--rm',
                '--add-host',
                'host.docker.internal:host-gateway',
                '--name',
                OWU_CONTAINER_NAME,
                '-p',
                `${OWU_PORT}:8080`,
                '-e',
                'WEBUI_AUTH=true',
                '-e',
                'ENABLE_SIGNUP=true',
                '-e',
                'ENABLE_INITIAL_ADMIN_SIGNUP=true',
                '-e',
                'ENABLE_OPENAI_API=true',
                '-e',
                `OPENAI_API_BASE_URL=http://host.docker.internal:${MOCK_PORT}/v1`,
                '-e',
                'OPENAI_API_KEY=sk-mock',
                '-e',
                'BYPASS_EMBEDDING_AND_RETRIEVAL=true',
                '-e',
                'RAG_EMBEDDING_ENGINE=openai',
                '-e',
                'RAG_EMBEDDING_MODEL=text-embedding-3-small',
                '-e',
                `RAG_OPENAI_API_BASE_URL=http://host.docker.internal:${MOCK_PORT}/v1`,
                '-e',
                'RAG_OPENAI_API_KEY=sk-mock',
                OWU_IMAGE,
            ],
            {
                logFilePath: path.join(LOGS_DIR, 'openwebui-run.log'),
            }
        )
        await waitForHttp(`${OWU_BASE_URL}/ready`, {
            timeoutMs: 180_000,
            validate: (response, bodyText) =>
                response.ok && bodyText.includes('"status":true'),
        })

        logStep('Creating OpenWebUI admin and sync-subject users')
        const adminSession = await signUpInitialAdmin()
        const syncSubjectSession = await addOpenWebUIUser(
            adminSession.token,
            SYNC_SUBJECT_USER
        )

        if (process.env.E2E_SKIP_BUILD !== '1') {
            logStep('Building monitor application')
            await runCommand('pnpm', ['build'], {
                logFilePath: path.join(LOGS_DIR, 'monitor-build.log'),
            })
        }

        logStep('Starting monitor application')
        const monitorApp = await startBackgroundProcess(
            'monitor-app',
            'pnpm',
            ['exec', 'next', 'start', '--port', String(MONITOR_PORT)],
            {
                env: {
                    ...process.env,
                    ACCESS_TOKEN: MONITOR_ACCESS_TOKEN,
                    API_KEY: MONITOR_API_KEY,
                    OPENWEBUI_DOMAIN: OWU_BASE_URL,
                    OPENWEBUI_API_KEY: adminSession.token,
                    POSTGRES_URL,
                    INIT_BALANCE: '20',
                    OPENWEBUI_USERS_SYNC_INTERVAL_MS: '0',
                },
            }
        )
        cleanup.push(() => stopBackgroundProcess(monitorApp))
        await waitForHttp(`${MONITOR_BASE_URL}/token`, {
            validate: (response) => response.ok,
        })

        logStep('Capturing real OpenWebUI function payload shape')
        const openWebUIPayloadCapture = await captureOpenWebUIFunctionPayloads(
            adminSession.token
        )

        logStep('Verifying sparse mobile-style monitor payloads')
        const payloadCompatibilityChecks =
            await runMonitorPayloadCompatibilityChecks()

        logStep('Installing and enabling the OpenWebUI Monitor filter')
        await installMonitorFunction(adminSession.token)

        logStep('Verifying initial monitor user sync')
        const initialUsers = await waitForUserSync(
            (usersResponse) =>
                usersResponse.users.some(
                    (user) =>
                        user.id === syncSubjectSession.id &&
                        user.name === SYNC_SUBJECT_USER.name
                ),
            'sync subject user should appear with original name'
        )

        assert(
            initialUsers.users.filter(
                (user) => user.id === syncSubjectSession.id
            ).length === 1,
            'Expected exactly one synced subject user before rename'
        )

        const openWebUIUsersAfterInitialSync = await fetchOpenWebUIUsers(
            adminSession.token
        )
        assertMonitorOrderMatchesOpenWebUI(
            initialUsers,
            openWebUIUsersAfterInitialSync,
            'Monitor default user order should match OpenWebUI user order after initial sync'
        )

        logStep('Verifying rename sync by stable OpenWebUI user id')
        await updateOpenWebUIUserName(
            adminSession.token,
            syncSubjectSession.id,
            SYNC_SUBJECT_USER.renamedName
        )

        const renamedUsers = await waitForUserSync(
            (usersResponse) =>
                usersResponse.users.some(
                    (user) =>
                        user.id === syncSubjectSession.id &&
                        user.name === SYNC_SUBJECT_USER.renamedName
                ) &&
                !usersResponse.users.some(
                    (user) =>
                        user.id !== syncSubjectSession.id &&
                        user.name === SYNC_SUBJECT_USER.name
                ),
            'renamed user should update in place without duplicates'
        )

        assert(
            renamedUsers.users.filter(
                (user) => user.id === syncSubjectSession.id
            ).length === 1,
            'Rename sync produced duplicate user rows'
        )

        logStep('Verifying removal of users deleted in OpenWebUI')
        await deleteOpenWebUIUser(adminSession.token, syncSubjectSession.id)

        const startedAt = Date.now()
        let activeUsersAfterDelete: MonitorUsersResponse | null = null

        while (Date.now() - startedAt < 30_000) {
            activeUsersAfterDelete = await fetchMonitorUsers()

            const existsInActive = activeUsersAfterDelete.users.some(
                (user) => user.id === syncSubjectSession.id
            )

            if (!existsInActive) {
                break
            }

            await sleep(1000)
        }

        assert(
            activeUsersAfterDelete,
            'Missing active users response after delete'
        )
        assert(
            !activeUsersAfterDelete.users.some(
                (user) => user.id === syncSubjectSession.id
            ),
            'Deleted OpenWebUI user still appears in active monitor users'
        )

        const openWebUIUsersAfterDelete = await fetchOpenWebUIUsers(
            adminSession.token
        )
        assertMonitorOrderMatchesOpenWebUI(
            activeUsersAfterDelete,
            openWebUIUsersAfterDelete,
            'Monitor default user order should match OpenWebUI user order after deletions'
        )

        const databaseExport = await fetchDatabaseExport()
        const hiddenUser = databaseExport.data.users.find(
            (user) => user.id === syncSubjectSession.id
        )
        assert(
            hiddenUser,
            'Deleted OpenWebUI user was unexpectedly removed from local history'
        )
        assert(
            hiddenUser.exists_in_openwebui === false,
            'Deleted OpenWebUI user was not marked as absent from OpenWebUI'
        )

        logStep('Smoke-testing the OpenWebUI chat completion API')
        await runOpenWebUIChat(adminSession.token)

        logStep('Reproducing desktop second-turn chat with 15 images')
        const desktopMultiImageChat = await runOpenWebUIDesktopMultiImageChat(
            adminSession.token
        )

        logStep('Reproducing mobile image upload chat across three messages')
        const mobileImageChat = await runOpenWebUIMobileImageChat(
            adminSession.token
        )

        logStep(
            'Injecting chat-style and image-style usage payloads into the monitor outlet'
        )
        await updateMonitorModelPrice({
            id: 'gpt-4o-mini',
            input_price: 0.000001,
            output_price: 0.000001,
            per_msg_price: -1,
        })
        await injectChatUsage({
            id: adminSession.id,
            name: adminSession.name,
            email: adminSession.email,
            role: adminSession.role,
        })
        await injectImageUsage({
            id: adminSession.id,
            name: adminSession.name,
            email: adminSession.email,
            role: adminSession.role,
        })

        logStep('Waiting for chat and image usage records to land')
        const recordsResponse = await waitForRecords()

        const chatRecord = recordsResponse.records.find(
            (record) => record.model_name === 'gpt-4o-mini'
        )
        const imageRecord = recordsResponse.records.find(
            (record) => record.model_name === 'gpt-image-1'
        )

        assert(chatRecord, 'Missing chat usage record for gpt-4o-mini')
        assert(imageRecord, 'Missing image usage record for gpt-image-1')
        assert(
            Math.abs(Number(chatRecord.cost) - 0.000001) < 0.0000005,
            `Expected low-cost chat record to retain micro precision, got ${chatRecord.cost}`
        )

        const usersAfterUsage = await fetchMonitorUsers()
        const adminUserBeforeReset = findMonitorUser(
            usersAfterUsage,
            adminSession.id
        )

        assert(
            adminUserBeforeReset,
            'Admin user not found in monitor users list'
        )

        const expectedUsedBalance =
            Number(chatRecord.cost) + Number(imageRecord.cost)
        const actualUsedBalanceBeforeReset = Number(
            adminUserBeforeReset.used_balance
        )

        assert(
            Math.abs(actualUsedBalanceBeforeReset - expectedUsedBalance) <
                0.0002,
            `Unexpected used balance before reset: expected ${expectedUsedBalance}, got ${actualUsedBalanceBeforeReset}`
        )

        const apiChecks = await runMonitorApiChecks()
        const chromiumChecks = await runChromiumChecks(
            packageJson.version,
            adminSession.id
        )

        const usersAfterReset = await fetchMonitorUsers()
        const adminUserAfterReset = findMonitorUser(
            usersAfterReset,
            adminSession.id
        )

        assert(
            adminUserAfterReset,
            'Admin user not found in monitor users list after reset'
        )
        assert(
            Number(adminUserAfterReset.used_balance) === 0,
            `Used balance was not reset to zero: ${adminUserAfterReset.used_balance}`
        )
        assert(
            Number(adminUserAfterReset.balance) ===
                chromiumChecks.users_page.updated_balance,
            'Resetting used balance should not change remaining balance'
        )

        const summary = {
            date: new Date().toISOString(),
            owu_image: OWU_IMAGE,
            postgres_image: POSTGRES_IMAGE,
            urls: {
                mock_openai: MOCK_BASE_URL,
                openwebui: OWU_BASE_URL,
                monitor: MONITOR_BASE_URL,
            },
            user_sync: {
                renamed_user_id: syncSubjectSession.id,
                rename_verified: true,
                removal_verified: true,
                default_order_matches_openwebui: true,
                hidden_locally_after_delete:
                    hiddenUser.exists_in_openwebui === false,
                used_balance_before_reset: actualUsedBalanceBeforeReset,
                used_balance_reset_verified: true,
            },
            records: {
                chat: {
                    model: chatRecord.model_name,
                    input_tokens: chatRecord.input_tokens,
                    output_tokens: chatRecord.output_tokens,
                    cost: Number(chatRecord.cost),
                },
                image: {
                    model: imageRecord.model_name,
                    input_tokens: imageRecord.input_tokens,
                    output_tokens: imageRecord.output_tokens,
                    cost: Number(imageRecord.cost),
                },
            },
            api_checks: apiChecks,
            openwebui_payload_capture: openWebUIPayloadCapture,
            payload_compatibility: payloadCompatibilityChecks,
            desktop_multi_image_chat: desktopMultiImageChat,
            mobile_image_chat: mobileImageChat,
            ui_checks: chromiumChecks.users_page,
            screenshots: chromiumChecks.screenshots,
        }

        const summaryPath = path.join(ARTIFACTS_DIR, 'summary.json')
        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 4))

        logStep(`E2E summary written to ${summaryPath}`)
        console.log(JSON.stringify(summary, null, 4))
    } finally {
        await cleanup.runAll()
    }
}

main().catch((error) => {
    console.error('[owu-e2e] Test run failed:', error)
    process.exit(1)
})
