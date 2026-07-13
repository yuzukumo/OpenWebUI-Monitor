import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { chromium, type Page } from 'playwright'
import { calculateTokenCostMicros } from '../../lib/utils/money'

interface CommandOptions {
    cwd?: string
    env?: NodeJS.ProcessEnv
    logFilePath?: string
    acceptableExitCodes?: number[]
}

interface BackgroundProcess {
    child: ChildProcess
    logFilePath: string
}

interface OpenWebUIUser {
    id: string
    email: string
    name: string
    role: string
}

interface MonitorUser extends OpenWebUIUser {
    balance: number | string
    used_balance: number | string
    exists_in_openwebui?: boolean
}

interface MonitorUsersResponse {
    users: MonitorUser[]
    total: number
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

interface MonitorModelPricing {
    id: string
    imageUrl?: string
    base_model_id?: string
    input_price: number
    output_price: number
    per_msg_price: number
    price_multiplier: number
    billing_mode: 'token' | 'request'
    effective_input_price: number
    effective_output_price: number
    effective_per_msg_price: number
}

interface DatabaseExportPayload {
    data: {
        users: MonitorUser[]
        model_prices: Array<Record<string, unknown>>
        user_usage_records: Array<Record<string, unknown>>
    }
}

interface MockOpenWebUIRequest {
    method: string
    path: string
    authorization: string
    body: unknown
}

interface MockOpenWebUIState {
    users: OpenWebUIUser[]
    requests: MockOpenWebUIRequest[]
}

interface MockOpenWebUIServer {
    server: Server
    state: MockOpenWebUIState
    close: () => Promise<void>
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT_DIR = path.resolve(__dirname, '../..')
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'artifacts/e2e')
const LOGS_DIR = path.join(ARTIFACTS_DIR, 'logs')
const SCREENSHOTS_DIR = path.join(ARTIFACTS_DIR, 'screenshots')

const POSTGRES_IMAGE = process.env.E2E_POSTGRES_IMAGE || 'postgres:18-alpine'
const POSTGRES_CONTAINER_NAME = 'owu-monitor-e2e-postgres'
const MOCK_OPENWEBUI_TOKEN = 'mock-openwebui-admin-token'

let OWU_PORT = parseInt(process.env.E2E_OWU_PORT || '18080', 10)
let MONITOR_PORT = parseInt(process.env.E2E_MONITOR_PORT || '17878', 10)
let POSTGRES_PORT = parseInt(process.env.E2E_POSTGRES_PORT || '55432', 10)

let OWU_BASE_URL = ''
let MONITOR_BASE_URL = ''
let POSTGRES_URL = ''
let DOCKER_BIN = process.env.E2E_DOCKER_BIN || 'docker'

const MONITOR_ACCESS_TOKEN =
    process.env.E2E_MONITOR_ACCESS_TOKEN || 'monitor-access'
const MONITOR_API_KEY = process.env.E2E_MONITOR_API_KEY || 'monitor-api'

const ADMIN_USER: OpenWebUIUser = {
    id: 'owu-admin-user',
    email: 'e2e.admin@example.com',
    name: 'E2E Admin',
    role: 'admin',
}

const SYNC_SUBJECT_USER: OpenWebUIUser = {
    id: 'owu-sync-subject-user',
    email: 'sync.subject@example.com',
    name: 'Sync Subject',
    role: 'user',
}

const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s2R0f8AAAAASUVORK5CYII=',
    'base64'
)

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
                console.error('[monitor-e2e] Cleanup failed:', error)
            }
        }
    }
}

function logStep(message: string) {
    console.log(`[monitor-e2e] ${message}`)
}

function refreshRuntimeUrls() {
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

        server.once('error', () => resolve(false))
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

            server.close(() => resolve(address.port))
        })
    })
}

async function choosePort(preferredPort: number) {
    return (await isPortAvailable(preferredPort))
        ? preferredPort
        : getFreePort()
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
    await fs.mkdir(LOGS_DIR, { recursive: true })

    const child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const logStream = logFilePath ? createWriteStream(logFilePath) : null

    child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk)
        logStream?.write(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk)
        logStream?.write(chunk)
    })

    const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve(code ?? 0))
    })

    await new Promise<void>((resolve) => {
        if (!logStream) {
            resolve()
            return
        }
        logStream.end(resolve)
    })

    const stdout = Buffer.concat(stdoutChunks).toString('utf8')
    const stderr = Buffer.concat(stderrChunks).toString('utf8')

    if (!acceptableExitCodes.includes(exitCode)) {
        throw new Error(
            `${command} ${args.join(
                ' '
            )} exited with ${exitCode}\n${stdout}${stderr}`
        )
    }

    return { stdout, stderr, exitCode }
}

async function startBackgroundProcess(
    name: string,
    command: string,
    args: string[],
    options: Omit<CommandOptions, 'acceptableExitCodes'> = {}
): Promise<BackgroundProcess> {
    const logFilePath = path.join(LOGS_DIR, `${name}.log`)
    const child = spawn(command, args, {
        cwd: options.cwd || ROOT_DIR,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    const logStream = createWriteStream(logFilePath)

    child.stdout.pipe(logStream, { end: false })
    child.stderr.pipe(logStream, { end: false })

    child.once('exit', (code, signal) => {
        logStream.write(`\n[process exited code=${code} signal=${signal}]\n`)
        logStream.end()
    })

    await sleep(500)
    if (child.exitCode !== null) {
        throw new Error(`${name} exited early; see ${logFilePath}`)
    }

    return { child, logFilePath }
}

async function stopBackgroundProcess(process: BackgroundProcess) {
    if (process.child.exitCode !== null) {
        return
    }

    process.child.kill('SIGTERM')

    await Promise.race([
        new Promise<void>((resolve) => {
            process.child.once('exit', () => resolve())
        }),
        sleep(5000).then(() => {
            if (process.child.exitCode === null) {
                process.child.kill('SIGKILL')
            }
        }),
    ])
}

async function waitForTcpPort(host: string, port: number, timeoutMs = 60_000) {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
        const canConnect = await new Promise<boolean>((resolve) => {
            const socket = net.createConnection({ host, port })
            socket.once('connect', () => {
                socket.destroy()
                resolve(true)
            })
            socket.once('error', () => resolve(false))
        })

        if (canConnect) {
            return
        }

        await sleep(500)
    }

    throw new Error(`Timed out waiting for TCP ${host}:${port}`)
}

async function waitForHttp(
    url: string,
    {
        timeoutMs = 60_000,
        validate = (response: Response) => response.ok,
    }: {
        timeoutMs?: number
        validate?: (response: Response, bodyText: string) => boolean
    } = {}
) {
    const startedAt = Date.now()
    let lastError: unknown = null

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await fetch(url, { cache: 'no-store' })
            const bodyText = await response.text()

            if (validate(response, bodyText)) {
                return
            }

            lastError = new Error(`${response.status} ${bodyText}`)
        } catch (error) {
            lastError = error
        }

        await sleep(500)
    }

    throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`)
}

async function resolveDockerCommand() {
    const command = process.env.E2E_DOCKER_BIN || 'docker'

    try {
        await runCommand(command, ['info'], {
            logFilePath: path.join(LOGS_DIR, 'docker-info.log'),
        })
        return command
    } catch (error) {
        throw new Error(
            `Unable to connect to Docker using ${command}. Check the WSL Docker integration and daemon status before retrying.`,
            { cause: error }
        )
    }
}

async function removeDockerContainer(name: string) {
    await runCommand(DOCKER_BIN, ['rm', '-f', name], {
        logFilePath: path.join(LOGS_DIR, `docker-rm-${name}.log`),
        acceptableExitCodes: [0, 1],
    })
}

async function waitForPostgresContainer() {
    const startedAt = Date.now()

    while (Date.now() - startedAt < 60_000) {
        try {
            await runCommand(
                DOCKER_BIN,
                [
                    'exec',
                    POSTGRES_CONTAINER_NAME,
                    'pg_isready',
                    '-U',
                    'postgres',
                    '-d',
                    'openwebui_monitor',
                ],
                {
                    logFilePath: path.join(LOGS_DIR, 'postgres-ready.log'),
                }
            )
            return
        } catch {
            await sleep(500)
        }
    }

    throw new Error('Timed out waiting for PostgreSQL readiness')
}

async function seedLegacyModelPricingSchema() {
    const sql = `
        CREATE TABLE IF NOT EXISTS model_prices (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            base_model_id TEXT,
            input_price NUMERIC(10, 6) DEFAULT 60,
            output_price NUMERIC(10, 6) DEFAULT 60,
            per_msg_price NUMERIC(10, 6) DEFAULT -1,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO model_prices (
            id, name, base_model_id, input_price, output_price, per_msg_price
        ) VALUES
            ('gpt-4o-mini', 'gpt-4o-mini', NULL, 7, 9, -1),
            (
                'custom.gpt-4o-mini',
                'Custom GPT-4o Mini',
                'gpt-4o-mini',
                0.3,
                0.6,
                0.125
            )
        ON CONFLICT (id) DO NOTHING;
    `

    const startedAt = Date.now()
    let lastError: unknown = null

    while (Date.now() - startedAt < 60_000) {
        try {
            await runCommand(
                DOCKER_BIN,
                [
                    'exec',
                    POSTGRES_CONTAINER_NAME,
                    'psql',
                    '-v',
                    'ON_ERROR_STOP=1',
                    '-U',
                    'postgres',
                    '-d',
                    'openwebui_monitor',
                    '-c',
                    sql,
                ],
                {
                    logFilePath: path.join(
                        LOGS_DIR,
                        'postgres-legacy-schema.log'
                    ),
                }
            )
            return
        } catch (error) {
            lastError = error
            await sleep(500)
        }
    }

    throw new Error(
        `Failed to seed legacy pricing schema: ${String(lastError)}`
    )
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
    response.statusCode = status
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(payload))
}

async function readJsonBody(request: IncomingMessage) {
    const chunks: Buffer[] = []

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    const bodyText = Buffer.concat(chunks).toString('utf8')
    return bodyText ? JSON.parse(bodyText) : null
}

async function startMockOpenWebUI(port: number): Promise<MockOpenWebUIServer> {
    const state: MockOpenWebUIState = {
        users: [{ ...ADMIN_USER }, { ...SYNC_SUBJECT_USER }],
        requests: [],
    }

    const server = createServer(async (request, response) => {
        const url = new URL(
            request.url || '/',
            `http://${request.headers.host || '127.0.0.1'}`
        )
        const body =
            request.method === 'POST' || request.method === 'PUT'
                ? await readJsonBody(request)
                : null

        state.requests.push({
            method: request.method || 'GET',
            path: url.pathname,
            authorization: request.headers.authorization || '',
            body,
        })

        if (request.method === 'GET' && url.pathname === '/health') {
            return sendJson(response, 200, { status: 'ok' })
        }

        if (request.method === 'GET' && url.pathname === '/api/models') {
            return sendJson(response, 200, {
                data: [
                    {
                        id: 'gpt-4o-mini',
                        name: 'gpt-4o-mini',
                        updated_at: 1,
                        info: {
                            id: 'gpt-4o-mini',
                            name: 'gpt-4o-mini',
                            updated_at: 1,
                            params: { system: '' },
                        },
                    },
                    {
                        id: 'gpt-image-1',
                        name: 'gpt-image-1',
                        updated_at: 2,
                        info: {
                            id: 'gpt-image-1',
                            name: 'gpt-image-1',
                            updated_at: 2,
                            params: { system: '' },
                        },
                    },
                    {
                        id: 'custom.gpt-4o-mini',
                        name: 'Custom GPT-4o Mini',
                        updated_at: 3,
                        info: {
                            id: 'custom.gpt-4o-mini',
                            name: 'Custom GPT-4o Mini',
                            base_model_id: 'gpt-4o-mini',
                            updated_at: 3,
                            params: { system: 'You are concise.' },
                        },
                    },
                ],
            })
        }

        if (
            request.method === 'GET' &&
            url.pathname === '/api/v1/models/model/profile/image'
        ) {
            response.statusCode = 200
            response.setHeader('Content-Type', 'image/png')
            response.setHeader('ETag', '"mock-model-icon"')
            response.end(PNG_1X1)
            return
        }

        if (request.method === 'GET' && url.pathname === '/api/v1/users') {
            return sendJson(response, 200, {
                users: state.users,
                total: state.users.length,
            })
        }

        if (request.method === 'GET' && url.pathname === '/api/v1/users/all') {
            return sendJson(response, 200, [...state.users].reverse())
        }

        return sendJson(response, 404, {
            error: `Unsupported mock OpenWebUI route: ${request.method} ${url.pathname}`,
        })
    })

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve())
    })

    return {
        server,
        state,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve())
            }),
    }
}

function authHeaders(token = MONITOR_ACCESS_TOKEN) {
    return {
        Authorization: `Bearer ${token}`,
    }
}

function jsonHeaders(token = MONITOR_ACCESS_TOKEN) {
    return {
        ...authHeaders(token),
        'Content-Type': 'application/json',
    }
}

async function requestJson<T>(
    url: string,
    init: RequestInit = {},
    { expectOk = true }: { expectOk?: boolean } = {}
) {
    const response = await fetch(url, { ...init, cache: 'no-store' })
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

    return { response, data, responseText }
}

async function fetchMonitorUsers() {
    const { data } = await requestJson<MonitorUsersResponse>(
        `${MONITOR_BASE_URL}/api/v1/users?page=1&pageSize=100`,
        {
            headers: authHeaders(),
        }
    )

    assert(data, 'Missing monitor users response')
    return data
}

async function fetchDatabaseExport() {
    const { data } = await requestJson<DatabaseExportPayload>(
        `${MONITOR_BASE_URL}/api/v1/panel/database/export`,
        {
            headers: authHeaders(),
        }
    )

    assert(data, 'Missing database export response')
    return data
}

async function waitForRecords(
    predicate: (record: MonitorRecord) => boolean = (record) =>
        record.model_name === 'gpt-4o-mini'
) {
    const startedAt = Date.now()
    let lastRecords: MonitorRecordsResponse | null = null

    while (Date.now() - startedAt < 30_000) {
        const { data } = await requestJson<MonitorRecordsResponse>(
            `${MONITOR_BASE_URL}/api/v1/panel/records?page=1&pageSize=20`,
            {
                headers: authHeaders(),
            }
        )

        assert(data, 'Missing usage records response')
        lastRecords = data

        if (data.records.some(predicate)) {
            return data
        }

        await sleep(500)
    }

    throw new Error(
        `Timed out waiting for usage records: ${JSON.stringify(lastRecords)}`
    )
}

function findOpenWebUIRequest(
    state: MockOpenWebUIState,
    method: string,
    path: string
) {
    return state.requests.find(
        (request) => request.method === method && request.path === path
    )
}

function assertAuthorizedOpenWebUIRequest(
    state: MockOpenWebUIState,
    method: string,
    path: string
) {
    const request = findOpenWebUIRequest(state, method, path)

    assert(request, `Missing mock OpenWebUI request: ${method} ${path}`)
    assert.equal(
        request.authorization,
        `Bearer ${MOCK_OPENWEBUI_TOKEN}`,
        `Unexpected auth header for ${method} ${path}`
    )

    return request
}

async function waitForVisibleText(
    page: Page,
    text: string,
    timeoutMs = 30_000
) {
    await page.waitForFunction(
        (expectedText) =>
            Array.from(document.querySelectorAll('body *')).some((element) => {
                if (!(element instanceof HTMLElement)) {
                    return false
                }

                const rect = element.getBoundingClientRect()
                let current: HTMLElement | null = element

                while (current) {
                    const style = window.getComputedStyle(current)

                    if (
                        style.display === 'none' ||
                        style.visibility === 'hidden' ||
                        style.opacity === '0'
                    ) {
                        return false
                    }

                    current = current.parentElement
                }

                return (
                    element.innerText.includes(expectedText) &&
                    rect.width > 0 &&
                    rect.height > 0
                )
            }),
        text,
        { timeout: timeoutMs }
    )
}

async function assertTailwindStylesApplied(page: Page) {
    const radius = await page
        .locator('.rounded-xl')
        .first()
        .evaluate((node) => {
            return window.getComputedStyle(node).borderRadius
        })

    assert(
        parseFloat(radius) > 0,
        `Tailwind styles do not appear to be applied; rounded-xl radius=${radius}`
    )
}

async function waitForLoadedImageAlt(
    page: Page,
    altText: string,
    timeoutMs = 30_000
) {
    await page.waitForFunction(
        (expectedAltText) =>
            Array.from(document.querySelectorAll('img')).some((image) => {
                return (
                    image instanceof HTMLImageElement &&
                    image.alt === expectedAltText &&
                    image.complete &&
                    image.naturalWidth > 0 &&
                    image.naturalHeight > 0
                )
            }),
        altText,
        { timeout: timeoutMs }
    )
}

function colorBrightness(color: string) {
    const labLightness = color.match(/lab\(\s*([\d.]+)%?/i)?.[1]

    if (labLightness) {
        return (Number(labLightness) / 100) * 255
    }

    const channels = color
        .match(/rgba?\(([^)]+)\)/i)?.[1]
        .split(',')
        .slice(0, 3)
        .map((channel) => Number(channel.trim()))

    assert(channels?.length === 3, `Unsupported CSS color value: ${color}`)

    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

async function assertDarkActionButtonIsReadable(page: Page, name: string) {
    const styles = await page.getByRole('button', { name }).evaluate((node) => {
        const style = window.getComputedStyle(node)

        return {
            backgroundColor: style.backgroundColor,
            color: style.color,
        }
    })

    const backgroundBrightness = colorBrightness(styles.backgroundColor)
    const textBrightness = colorBrightness(styles.color)

    assert(
        backgroundBrightness < 80,
        `${name} should keep a dark action background; got ${styles.backgroundColor}`
    )
    assert(
        textBrightness > 200,
        `${name} should keep readable light text; got ${styles.color}`
    )
}

async function runChromiumChecks() {
    const browser = await chromium.launch({
        headless: process.env.E2E_HEADLESS !== '0',
    })
    const screenshots: Record<string, string> = {}

    try {
        const context = await browser.newContext({
            locale: 'en-US',
            viewport: { width: 1440, height: 1100 },
        })

        const page = await context.newPage()

        await page.goto(`${MONITOR_BASE_URL}/token`, {
            waitUntil: 'networkidle',
        })
        await page.fill('#token', MONITOR_ACCESS_TOKEN)
        await page.getByRole('button', { name: 'Confirm' }).click()
        await page.waitForURL(`${MONITOR_BASE_URL}/`, { timeout: 30_000 })
        await page.waitForLoadState('networkidle')
        screenshots.home = path.join(SCREENSHOTS_DIR, 'home.png')
        await page.screenshot({ path: screenshots.home, fullPage: true })
        await assertTailwindStylesApplied(page)

        await page.goto(`${MONITOR_BASE_URL}/models`, {
            waitUntil: 'networkidle',
        })
        await waitForVisibleText(page, 'Model Management')
        await waitForVisibleText(page, 'gpt-4o-mini')
        await waitForVisibleText(page, 'Billing Method')
        await waitForVisibleText(page, 'Price Configuration')
        await waitForVisibleText(page, 'Input Price')
        assert.equal(
            await page.getByText('Test All Models', { exact: true }).count(),
            0,
            'Removed model testing action is still visible'
        )
        await assertDarkActionButtonIsReadable(page, 'Sync All Derived Models')
        await waitForLoadedImageAlt(page, 'gpt-4o-mini')

        const tokenRow = page.locator('tr[data-row-key="gpt-4o-mini"]')
        const requestRow = page.locator('tr[data-row-key="custom.gpt-4o-mini"]')
        assert.equal(await tokenRow.count(), 1, 'Missing token billing row')
        assert.equal(await requestRow.count(), 1, 'Missing request billing row')
        assert(
            (await tokenRow.innerText()).includes('Token Based'),
            'Token billing mode is not selected'
        )
        assert(
            (await requestRow.innerText()).includes('Per Request'),
            'Per-request billing mode is not selected'
        )
        assert.equal(
            await tokenRow.locator('[data-price-field="input_price"]').count(),
            1
        )
        assert.equal(
            await tokenRow.locator('[data-price-field="output_price"]').count(),
            1
        )
        assert.equal(
            await tokenRow
                .locator('[data-price-field="price_multiplier"]')
                .count(),
            1
        )
        assert.equal(
            await tokenRow
                .locator('[data-price-field="per_msg_price"]')
                .count(),
            0
        )
        assert.equal(
            await requestRow
                .locator('[data-price-field="per_msg_price"]')
                .count(),
            1
        )
        assert.equal(
            await requestRow
                .locator('[data-price-field="input_price"]')
                .count(),
            0
        )
        assert.equal(
            await requestRow
                .locator('[data-price-field="price_multiplier"]')
                .count(),
            0
        )

        const inputPriceField = tokenRow.locator(
            '[data-price-field="input_price"]'
        )
        assert.equal(
            await inputPriceField
                .locator('[data-effective-price="input_price"]')
                .innerText(),
            '1.500000',
            'Token price does not show its multiplied price'
        )
        const effectivePriceStyles = await inputPriceField
            .locator('[data-effective-price="input_price"] .group span')
            .first()
            .evaluate((node) => {
                const style = window.getComputedStyle(node)
                return {
                    color: style.color,
                    fontSize: style.fontSize,
                    textDecoration: style.textDecorationLine,
                }
            })
        const configuredPrice = inputPriceField.locator(
            '[data-configured-price="input_price"]'
        )
        assert.equal(await configuredPrice.innerText(), '1.000000')
        const configuredPriceStyles = await configuredPrice.evaluate((node) => {
            const style = window.getComputedStyle(node)
            return {
                color: style.color,
                fontSize: style.fontSize,
                textDecoration: style.textDecorationLine,
            }
        })
        assert(
            !effectivePriceStyles.textDecoration.includes('line-through'),
            'Effective token price should not be struck through'
        )
        assert(
            configuredPriceStyles.textDecoration.includes('line-through'),
            'Configured token price should be struck through'
        )
        assert(
            parseFloat(effectivePriceStyles.fontSize) >
                parseFloat(configuredPriceStyles.fontSize),
            'Effective token price should be larger than configured price'
        )
        assert(
            colorBrightness(configuredPriceStyles.color) >
                colorBrightness(effectivePriceStyles.color),
            'Configured token price should be lighter than effective price'
        )

        const modelsUrl = page.url()
        const multiplierField = tokenRow.locator(
            '[data-price-field="price_multiplier"]'
        )
        await multiplierField.locator('.group').click()
        const multiplierInput = multiplierField.locator('input')
        await multiplierInput.fill('1.25')
        const updateResponsePromise = page.waitForResponse(
            (response) =>
                response.url().endsWith('/api/v1/models/price') &&
                response.request().method() === 'POST'
        )
        await multiplierInput.press('Enter')
        const updateResponse = await updateResponsePromise
        assert(updateResponse.ok(), 'Multiplier UI update failed')
        await page.waitForFunction(() => {
            const effectivePrice = document.querySelector(
                'tr[data-row-key="gpt-4o-mini"] [data-effective-price="input_price"]'
            )
            return effectivePrice?.textContent?.trim() === '1.250000'
        })
        assert.equal(
            (await multiplierField.locator('.group').innerText()).replace(
                /\s/g,
                ''
            ),
            '1.25x',
            'Multiplier should not show padded decimal places'
        )
        assert.equal(
            page.url(),
            modelsUrl,
            'Multiplier update reloaded the page'
        )

        const imageModelRow = page.locator('tr[data-row-key="gpt-image-1"]')
        assert.equal(await imageModelRow.count(), 1, 'Missing image model row')
        await imageModelRow.getByText('Per Request', { exact: true }).click()
        const draftRequestPrice = imageModelRow.locator(
            '[data-price-field="per_msg_price"] input'
        )
        await draftRequestPrice.waitFor({ state: 'visible' })
        await draftRequestPrice.fill('0.03')
        const requestModeResponsePromise = page.waitForResponse(
            (response) =>
                response.url().endsWith('/api/v1/models/price') &&
                response.request().method() === 'POST'
        )
        await draftRequestPrice.press('Enter')
        const requestModeResponse = await requestModeResponsePromise
        assert(requestModeResponse.ok(), 'Per-request mode update failed')
        await imageModelRow
            .locator('[data-price-field="per_msg_price"]')
            .waitFor({ state: 'visible' })
        assert.equal(
            await imageModelRow
                .locator('[data-price-field="price_multiplier"]')
                .count(),
            0,
            'Per-request mode should hide multiplier controls'
        )

        const tokenModeResponsePromise = page.waitForResponse(
            (response) =>
                response.url().endsWith('/api/v1/models/price') &&
                response.request().method() === 'POST'
        )
        await imageModelRow.getByText('Token Based', { exact: true }).click()
        const tokenModeResponse = await tokenModeResponsePromise
        assert(tokenModeResponse.ok(), 'Token billing mode update failed')
        await imageModelRow
            .locator('[data-price-field="price_multiplier"]')
            .waitFor({ state: 'visible' })
        assert.equal(
            await imageModelRow
                .locator('[data-price-field="per_msg_price"]')
                .count(),
            0,
            'Token mode should hide the per-request price control'
        )
        assert.equal(
            page.url(),
            modelsUrl,
            'Billing mode update reloaded the page'
        )

        screenshots.models = path.join(SCREENSHOTS_DIR, 'models.png')
        await page.screenshot({ path: screenshots.models, fullPage: true })
        await assertTailwindStylesApplied(page)

        const mobilePage = await context.newPage()
        await mobilePage.setViewportSize({ width: 390, height: 844 })
        await mobilePage.goto(`${MONITOR_BASE_URL}/models`, {
            waitUntil: 'networkidle',
        })
        await waitForVisibleText(mobilePage, 'Model Management')
        await waitForLoadedImageAlt(mobilePage, 'gpt-4o-mini')
        const tokenCard = mobilePage.locator('[data-model-id="gpt-4o-mini"]')
        const requestCard = mobilePage.locator(
            '[data-model-id="custom.gpt-4o-mini"]'
        )
        assert.equal(await tokenCard.count(), 1, 'Missing mobile token card')
        assert.equal(
            await requestCard.count(),
            1,
            'Missing mobile request card'
        )
        assert.equal(
            await tokenCard
                .locator('[data-price-field="price_multiplier"]')
                .count(),
            1
        )
        assert.equal(
            await requestCard
                .locator('[data-price-field="per_msg_price"]')
                .count(),
            1
        )
        assert.equal(
            await requestCard
                .locator('[data-price-field="price_multiplier"]')
                .count(),
            0
        )
        screenshots.models_mobile = path.join(
            SCREENSHOTS_DIR,
            'models-mobile.png'
        )
        await mobilePage.screenshot({
            path: screenshots.models_mobile,
            fullPage: true,
        })

        const initialMobileUsersRequest = mobilePage.waitForRequest(
            (request) => {
                const url = new URL(request.url())
                return (
                    url.pathname === '/api/v1/users' &&
                    url.searchParams.get('pageSize') === '50'
                )
            }
        )
        await mobilePage.goto(`${MONITOR_BASE_URL}/users`, {
            waitUntil: 'networkidle',
        })
        await initialMobileUsersRequest
        await waitForVisibleText(mobilePage, 'User Management')

        const mobileSearchForm = mobilePage.getByTestId('user-search')
        const mobileSearchInput = mobileSearchForm.getByRole('searchbox')
        const mobileSearchButton = mobileSearchForm.getByRole('button', {
            name: 'Search',
            exact: true,
        })
        const mobileSearchInputBox = await mobileSearchInput.boundingBox()
        const mobileSearchButtonBox = await mobileSearchButton.boundingBox()
        assert(mobileSearchInputBox, 'Missing mobile search input bounds')
        assert(mobileSearchButtonBox, 'Missing mobile search button bounds')
        assert(
            mobileSearchInputBox.x + mobileSearchInputBox.width <=
                mobileSearchButtonBox.x,
            'Mobile search input overlaps the search button'
        )

        await mobileSearchInput.fill(ADMIN_USER.email)
        const mobileClearButton = mobileSearchForm.getByRole('button', {
            name: 'Close',
        })
        const filledMobileSearchInputBox = await mobileSearchInput.boundingBox()
        const mobileClearButtonBox = await mobileClearButton.boundingBox()
        assert(
            filledMobileSearchInputBox,
            'Missing filled mobile search input bounds'
        )
        assert(mobileClearButtonBox, 'Missing mobile clear button bounds')
        assert(
            filledMobileSearchInputBox.x + filledMobileSearchInputBox.width <=
                mobileClearButtonBox.x,
            'Mobile search input overlaps the clear button'
        )
        assert(
            mobileClearButtonBox.x + mobileClearButtonBox.width <=
                mobileSearchButtonBox.x,
            'Mobile clear button overlaps the search button'
        )

        screenshots.users_mobile = path.join(
            SCREENSHOTS_DIR,
            'users-mobile.png'
        )
        await mobilePage.screenshot({
            path: screenshots.users_mobile,
            fullPage: true,
        })
        await mobilePage.close()

        const initialUsersRequest = page.waitForRequest((request) => {
            const url = new URL(request.url())
            return (
                url.pathname === '/api/v1/users' &&
                url.searchParams.get('pageSize') === '50'
            )
        })
        await page.goto(`${MONITOR_BASE_URL}/users`, {
            waitUntil: 'networkidle',
        })
        await initialUsersRequest
        await waitForVisibleText(page, 'User Management')
        await waitForVisibleText(page, ADMIN_USER.email)

        const searchForm = page.getByTestId('user-search')
        const searchInput = searchForm.getByRole('searchbox')
        const searchButton = searchForm.getByRole('button', {
            name: 'Search',
            exact: true,
        })
        const initialSearchInputBox = await searchInput.boundingBox()
        const searchButtonBox = await searchButton.boundingBox()
        assert(initialSearchInputBox, 'Missing user search input bounds')
        assert(searchButtonBox, 'Missing user search button bounds')
        assert(
            initialSearchInputBox.x + initialSearchInputBox.width <=
                searchButtonBox.x,
            'User search input overlaps the search button'
        )

        await searchInput.fill(ADMIN_USER.email)
        const clearButton = searchForm.getByRole('button', { name: 'Close' })
        const filledSearchInputBox = await searchInput.boundingBox()
        const clearButtonBox = await clearButton.boundingBox()
        assert(filledSearchInputBox, 'Missing filled search input bounds')
        assert(clearButtonBox, 'Missing user search clear button bounds')
        assert(
            filledSearchInputBox.x + filledSearchInputBox.width <=
                clearButtonBox.x,
            'User search input overlaps the clear button'
        )

        const filteredUsersRequest = page.waitForResponse((response) => {
            const url = new URL(response.url())
            return (
                url.pathname === '/api/v1/users' &&
                url.searchParams.get('pageSize') === '50' &&
                url.searchParams.get('search') === ADMIN_USER.email
            )
        })
        await searchButton.click()
        assert((await filteredUsersRequest).ok(), 'User search request failed')
        await waitForVisibleText(page, ADMIN_USER.email)

        const clearedUsersRequest = page.waitForResponse((response) => {
            const url = new URL(response.url())
            return (
                url.pathname === '/api/v1/users' &&
                url.searchParams.get('pageSize') === '50' &&
                !url.searchParams.has('search')
            )
        })
        await clearButton.click()
        assert((await clearedUsersRequest).ok(), 'Clearing user search failed')

        const userRow = page.locator(`tr[data-row-key="${ADMIN_USER.id}"]`)
        const userRowBox = await userRow.boundingBox()
        assert(userRowBox, 'Missing user row bounds')
        assert(userRowBox.height <= 80, 'User table row is not compact')
        const resetButton = userRow.getByTestId(
            `reset-used-balance-${ADMIN_USER.id}`
        )
        assert.equal(
            await resetButton.evaluate(
                (element) => window.getComputedStyle(element).whiteSpace
            ),
            'nowrap',
            'Reset used balance action can wrap onto multiple lines'
        )
        assert(
            await resetButton.isEnabled(),
            'Reset used balance action should be enabled for used balance'
        )
        await resetButton.click()
        const resetDialog = page.getByRole('dialog')
        await resetDialog.waitFor({ state: 'visible' })
        await waitForVisibleText(page, 'Reset used balance?')
        const resetResponsePromise = page.waitForResponse(
            (response) =>
                response
                    .url()
                    .includes(
                        `/api/v1/users/${ADMIN_USER.id}/used-balance/reset`
                    ) && response.request().method() === 'POST'
        )
        await resetDialog
            .getByRole('button', { name: 'Confirm', exact: true })
            .click()
        assert(
            (await resetResponsePromise).ok(),
            'Confirmed used balance reset failed'
        )
        await page.waitForFunction((userId) => {
            const row = document.querySelector(`tr[data-row-key="${userId}"]`)
            return row?.children[1]?.textContent?.includes('0.000000')
        }, ADMIN_USER.id)
        assert(
            (
                await page
                    .locator('.ant-pagination-options')
                    .first()
                    .innerText()
            ).includes('50'),
            'User page size selector does not default to 50'
        )
        screenshots.users = path.join(SCREENSHOTS_DIR, 'users.png')
        await page.screenshot({ path: screenshots.users, fullPage: true })
        await assertTailwindStylesApplied(page)

        await page.goto(`${MONITOR_BASE_URL}/records`, {
            waitUntil: 'networkidle',
        })
        await waitForVisibleText(page, 'Usage Records')
        await waitForVisibleText(page, 'gpt-4o-mini')
        screenshots.records = path.join(SCREENSHOTS_DIR, 'records.png')
        await page.screenshot({ path: screenshots.records, fullPage: true })
        await assertTailwindStylesApplied(page)

        await page.goto(`${MONITOR_BASE_URL}/panel`, {
            waitUntil: 'networkidle',
        })
        await waitForVisibleText(page, 'Usage Statistics')
        const usageTable = page.locator('.ant-table-wrapper').last()
        const usagePagination = usageTable.locator('.ant-pagination')
        await usagePagination.waitFor({ state: 'visible' })
        assert(
            (
                await usagePagination
                    .locator('.ant-pagination-options')
                    .innerText()
            ).includes('50'),
            'Usage details page size selector does not default to 50'
        )
        assert.equal(
            await usagePagination.evaluate(
                (element) => window.getComputedStyle(element).borderTopWidth
            ),
            '0px',
            'Usage details pagination has an extra top border'
        )
        const totalBox = await usagePagination
            .locator('.ant-pagination-total-text')
            .boundingBox()
        const previousBox = await usagePagination
            .locator('.ant-pagination-prev')
            .boundingBox()
        const nextBox = await usagePagination
            .locator('.ant-pagination-next')
            .boundingBox()
        const optionsBox = await usagePagination
            .locator('.ant-pagination-options')
            .boundingBox()
        const paginationBox = await usagePagination.boundingBox()
        assert(totalBox, 'Missing usage total bounds')
        assert(previousBox, 'Missing usage previous-page bounds')
        assert(nextBox, 'Missing usage next-page bounds')
        assert(optionsBox, 'Missing usage page-size bounds')
        assert(paginationBox, 'Missing usage pagination bounds')
        assert(
            Math.abs(
                totalBox.y +
                    totalBox.height / 2 -
                    (previousBox.y + previousBox.height / 2)
            ) <= 2,
            'Usage total is not vertically aligned with pagination controls'
        )
        assert(
            Math.abs(
                (previousBox.x + nextBox.x + nextBox.width) / 2 -
                    (paginationBox.x + paginationBox.width / 2)
            ) <=
                paginationBox.width * 0.2,
            'Usage pagination controls are not centered'
        )
        assert(
            optionsBox.x + optionsBox.width >=
                paginationBox.x + paginationBox.width * 0.75,
            'Usage page-size selector is not aligned to the right'
        )
        screenshots.panel = path.join(SCREENSHOTS_DIR, 'panel.png')
        await page.screenshot({ path: screenshots.panel, fullPage: true })
        await assertTailwindStylesApplied(page)

        await context.close()
    } finally {
        await browser.close()
    }

    return { screenshots }
}

async function main() {
    OWU_PORT = await choosePort(OWU_PORT)
    MONITOR_PORT = await choosePort(MONITOR_PORT)
    POSTGRES_PORT = await choosePort(POSTGRES_PORT)
    refreshRuntimeUrls()

    await ensureArtifactsDirs()

    const cleanup = new CleanupStack()

    try {
        assert.equal(
            calculateTokenCostMicros({
                inputTokens: 0,
                outputTokens: 2_000_000,
                inputPrice: 0,
                outputPrice: '0.000001',
                priceMultiplier: '0.5',
            }),
            BigInt(1),
            'Multiplier billing should round only the final cost'
        )

        DOCKER_BIN = await resolveDockerCommand()
        logStep(
            `Using ports mock_owu=${OWU_PORT}, monitor=${MONITOR_PORT}, postgres=${POSTGRES_PORT}`
        )
        logStep(`Using Docker command: ${DOCKER_BIN}`)

        logStep('Starting mock OpenWebUI server')
        const mockOpenWebUI = await startMockOpenWebUI(OWU_PORT)
        cleanup.push(() => mockOpenWebUI.close())
        await waitForHttp(`${OWU_BASE_URL}/health`)

        logStep('Starting PostgreSQL test container')
        await removeDockerContainer(POSTGRES_CONTAINER_NAME)
        cleanup.push(() => removeDockerContainer(POSTGRES_CONTAINER_NAME))
        await runCommand(
            DOCKER_BIN,
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
        await waitForPostgresContainer()
        logStep('Seeding legacy model pricing schema')
        await seedLegacyModelPricingSchema()

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
                    OPENWEBUI_API_KEY: MOCK_OPENWEBUI_TOKEN,
                    POSTGRES_URL,
                    INIT_BALANCE: '20',
                    OPENWEBUI_USERS_SYNC_INTERVAL_MS: '0',
                },
            }
        )
        cleanup.push(() => stopBackgroundProcess(monitorApp))
        await waitForHttp(`${MONITOR_BASE_URL}/token`)

        logStep('Checking monitor -> OpenWebUI model interfaces')
        const { data: models } = await requestJson<MonitorModelPricing[]>(
            `${MONITOR_BASE_URL}/api/v1/models`,
            {
                headers: authHeaders(),
            }
        )

        assert(models, 'Missing models response')
        assert(
            models.some((model) => model.id === 'gpt-4o-mini'),
            'Missing gpt-4o-mini from monitor models response'
        )
        assert(
            models.some(
                (model) =>
                    model.id === 'custom.gpt-4o-mini' &&
                    model.base_model_id === 'gpt-4o-mini'
            ),
            'Missing derived model base_model_id mapping'
        )
        const initialBaseModel = models.find(
            (model) => model.id === 'gpt-4o-mini'
        )
        const initialDerivedModel = models.find(
            (model) => model.id === 'custom.gpt-4o-mini'
        )
        assert(initialBaseModel, 'Missing base model pricing data')
        assert(initialDerivedModel, 'Missing derived model pricing data')
        assert.equal(initialBaseModel.billing_mode, 'token')
        assert.equal(Number(initialBaseModel.price_multiplier), 1)
        assert.equal(Number(initialBaseModel.input_price), 7)
        assert.equal(Number(initialBaseModel.output_price), 9)
        assert.equal(
            Number(initialBaseModel.effective_input_price),
            Number(initialBaseModel.input_price)
        )
        assert.equal(initialDerivedModel.billing_mode, 'request')
        assert.equal(Number(initialDerivedModel.price_multiplier), 1)
        assert.equal(Number(initialDerivedModel.per_msg_price), 0.125)
        assert.equal(Number(initialDerivedModel.effective_per_msg_price), 0.125)
        assertAuthorizedOpenWebUIRequest(
            mockOpenWebUI.state,
            'GET',
            '/api/models'
        )

        const iconResponse = await fetch(
            `${MONITOR_BASE_URL}/api/v1/models/icon?id=gpt-4o-mini`,
            {
                headers: authHeaders(),
                cache: 'no-store',
                redirect: 'manual',
            }
        )
        assert.equal(iconResponse.status, 200, 'Model icon proxy failed')
        assert(
            iconResponse.headers
                .get('content-type')
                ?.toLowerCase()
                .startsWith('image/png'),
            'Model icon proxy did not return PNG content'
        )
        assertAuthorizedOpenWebUIRequest(
            mockOpenWebUI.state,
            'GET',
            '/api/v1/models/model/profile/image'
        )

        logStep('Checking user sync against mock OpenWebUI users API')
        const initialUsers = await fetchMonitorUsers()
        assert.deepEqual(
            initialUsers.users.map((user) => user.id),
            [ADMIN_USER.id, SYNC_SUBJECT_USER.id],
            'Monitor user order should match OpenWebUI admin order'
        )
        assertAuthorizedOpenWebUIRequest(
            mockOpenWebUI.state,
            'GET',
            '/api/v1/users'
        )

        mockOpenWebUI.state.users = mockOpenWebUI.state.users.map((user) =>
            user.id === SYNC_SUBJECT_USER.id
                ? { ...user, name: 'Renamed Subject' }
                : user
        )
        const renamedUsers = await fetchMonitorUsers()
        assert(
            renamedUsers.users.some(
                (user) =>
                    user.id === SYNC_SUBJECT_USER.id &&
                    user.name === 'Renamed Subject'
            ),
            'Renamed OpenWebUI user did not update in place'
        )
        assert.equal(
            renamedUsers.users.filter(
                (user) => user.id === SYNC_SUBJECT_USER.id
            ).length,
            1,
            'Rename sync produced duplicate monitor users'
        )

        mockOpenWebUI.state.users = mockOpenWebUI.state.users.filter(
            (user) => user.id !== SYNC_SUBJECT_USER.id
        )
        const activeUsersAfterDelete = await fetchMonitorUsers()
        assert(
            !activeUsersAfterDelete.users.some(
                (user) => user.id === SYNC_SUBJECT_USER.id
            ),
            'Deleted OpenWebUI user still appears in active monitor users'
        )
        const databaseExport = await fetchDatabaseExport()
        const hiddenUser = databaseExport.data.users.find(
            (user) => user.id === SYNC_SUBJECT_USER.id
        )
        assert(hiddenUser, 'Deleted user should remain in local history')
        assert.equal(
            hiddenUser.exists_in_openwebui,
            false,
            'Deleted user should be marked absent from OpenWebUI'
        )

        logStep('Checking billing inlet/outlet and monitor records')
        const priceUpdate = await requestJson<{
            success: boolean
            results: Array<{
                success: boolean
                data?: MonitorModelPricing
            }>
        }>(`${MONITOR_BASE_URL}/api/v1/models/price`, {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({
                updates: [
                    {
                        id: 'gpt-4o-mini',
                        input_price: 1,
                        output_price: 2,
                        per_msg_price: -1,
                        price_multiplier: 1.5,
                        billing_mode: 'token',
                    },
                ],
            }),
        })
        assert(priceUpdate.data?.success, 'Model price update failed')
        assert(
            priceUpdate.data.results[0]?.success,
            'Model price update result failed'
        )
        const updatedBaseModel = priceUpdate.data.results[0].data
        assert(updatedBaseModel, 'Missing updated model pricing data')
        assert.equal(updatedBaseModel.billing_mode, 'token')
        assert.equal(Number(updatedBaseModel.price_multiplier), 1.5)
        assert.equal(Number(updatedBaseModel.effective_input_price), 1.5)
        assert.equal(Number(updatedBaseModel.effective_output_price), 3)

        const syncPrices = await requestJson<{
            success: boolean
            syncedModels: Array<MonitorModelPricing & { success: boolean }>
        }>(`${MONITOR_BASE_URL}/api/v1/models/sync-all-prices`, {
            method: 'POST',
            headers: jsonHeaders(),
        })
        assert(syncPrices.data?.success, 'Derived model price sync failed')
        const syncedDerivedModel = syncPrices.data.syncedModels.find(
            (model) => model.id === 'custom.gpt-4o-mini'
        )
        assert(syncedDerivedModel?.success, 'Derived model was not synced')
        assert.equal(syncedDerivedModel.billing_mode, 'token')
        assert.equal(Number(syncedDerivedModel.price_multiplier), 1.5)
        assert.equal(Number(syncedDerivedModel.effective_output_price), 3)

        const sparseInlet = await requestJson<{ success: boolean }>(
            `${MONITOR_BASE_URL}/api/v1/inlet`,
            {
                method: 'POST',
                headers: jsonHeaders(MONITOR_API_KEY),
                body: JSON.stringify({
                    user: {
                        id: ADMIN_USER.id,
                        name: ADMIN_USER.name,
                        role: ADMIN_USER.role,
                    },
                    metadata: {
                        user_id: ADMIN_USER.id,
                    },
                    body: {
                        model: 'gpt-4o-mini',
                    },
                }),
            }
        )
        assert(
            sparseInlet.data?.success,
            'Sparse OpenWebUI inlet payload failed'
        )

        const outlet = await requestJson<{
            success: boolean
            inputTokens: number
            outputTokens: number
            totalCost: number
        }>(`${MONITOR_BASE_URL}/api/v1/outlet`, {
            method: 'POST',
            headers: jsonHeaders(MONITOR_API_KEY),
            body: JSON.stringify({
                user: ADMIN_USER,
                metadata: {
                    user_id: ADMIN_USER.id,
                },
                body: {
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'user',
                            content: 'Hello',
                        },
                        {
                            role: 'assistant',
                            content: 'Hi',
                            usage: {
                                input_tokens: 10,
                                output_tokens: 5,
                                total_tokens: 15,
                            },
                        },
                    ],
                },
            }),
        })
        assert(outlet.data?.success, 'Outlet payload failed')
        assert.equal(outlet.data.inputTokens, 10)
        assert.equal(outlet.data.outputTokens, 5)
        assert(
            Math.abs(outlet.data.totalCost - 0.00003) < 0.0000000001,
            `Unexpected token billing cost: ${outlet.data.totalCost}`
        )

        const records = await waitForRecords()
        const chatRecord = records.records.find(
            (record) => record.model_name === 'gpt-4o-mini'
        )
        assert(chatRecord, 'Missing usage record for gpt-4o-mini')
        assert.equal(chatRecord.input_tokens, 10)
        assert.equal(chatRecord.output_tokens, 5)
        assert.equal(
            Number(chatRecord.cost),
            0.00003,
            `Unexpected token billing record cost: ${chatRecord.cost}`
        )

        const requestPriceUpdate = await requestJson<{
            success: boolean
            results: Array<{
                success: boolean
                data?: MonitorModelPricing
            }>
        }>(`${MONITOR_BASE_URL}/api/v1/models/price`, {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({
                updates: [
                    {
                        id: 'custom.gpt-4o-mini',
                        input_price: 1,
                        output_price: 2,
                        per_msg_price: 0.02,
                        price_multiplier: 10,
                        billing_mode: 'request',
                    },
                ],
            }),
        })
        const requestPricedModel = requestPriceUpdate.data?.results[0]?.data
        assert(requestPricedModel, 'Per-request model price update failed')
        assert.equal(requestPricedModel.billing_mode, 'request')
        assert.equal(Number(requestPricedModel.effective_per_msg_price), 0.02)

        const requestOutlet = await requestJson<{
            success: boolean
            inputTokens: number
            outputTokens: number
            totalCost: number
        }>(`${MONITOR_BASE_URL}/api/v1/outlet`, {
            method: 'POST',
            headers: jsonHeaders(MONITOR_API_KEY),
            body: JSON.stringify({
                user: ADMIN_USER,
                metadata: {
                    user_id: ADMIN_USER.id,
                },
                body: {
                    model: 'custom.gpt-4o-mini',
                    messages: [
                        {
                            role: 'user',
                            content: 'Fixed price request',
                        },
                        {
                            role: 'assistant',
                            content: '',
                            output: [
                                {
                                    type: 'message',
                                    status: 'completed',
                                    content: [
                                        {
                                            type: 'output_image',
                                            image_url:
                                                'https://example.com/image',
                                        },
                                    ],
                                },
                            ],
                            usage: {
                                input_tokens: 123,
                                output_tokens: 0,
                                total_tokens: 123,
                            },
                        },
                    ],
                },
            }),
        })
        assert(requestOutlet.data?.success, 'Per-request outlet failed')
        assert.equal(
            requestOutlet.data.totalCost,
            0.02,
            'Per-request billing must ignore the token multiplier'
        )

        const recordsWithRequestBilling = await waitForRecords(
            (record) =>
                record.model_name === 'custom.gpt-4o-mini' &&
                record.input_tokens === 123 &&
                record.output_tokens === 0
        )
        const requestRecord = recordsWithRequestBilling.records.find(
            (record) =>
                record.model_name === 'custom.gpt-4o-mini' &&
                record.input_tokens === 123 &&
                record.output_tokens === 0
        )
        assert(
            requestRecord,
            'Missing per-request usage record for a zero-token completion'
        )
        assert.equal(
            Number(requestRecord.cost),
            0.02,
            'A successful per-request response must be charged even when output tokens are zero'
        )

        const balanceUpdate = await requestJson<MonitorUser>(
            `${MONITOR_BASE_URL}/api/v1/users/${ADMIN_USER.id}/balance`,
            {
                method: 'PUT',
                headers: jsonHeaders(),
                body: JSON.stringify({ balance: 42.424242 }),
            }
        )
        assert.equal(
            Number(balanceUpdate.data?.balance),
            42.424242,
            'Balance update API failed'
        )

        logStep('Checking monitor pages in Chromium')
        const chromiumChecks = await runChromiumChecks()

        const summary = {
            date: new Date().toISOString(),
            urls: {
                mock_openwebui: OWU_BASE_URL,
                monitor: MONITOR_BASE_URL,
            },
            openwebui_interface_checks: {
                models: true,
                model_icon: true,
                users: true,
            },
            user_sync: {
                rename_verified: true,
                removal_verified: true,
                default_order_matches_openwebui: true,
                hidden_locally_after_delete:
                    hiddenUser.exists_in_openwebui === false,
            },
            records: {
                chat: {
                    model: chatRecord.model_name,
                    input_tokens: chatRecord.input_tokens,
                    output_tokens: chatRecord.output_tokens,
                    cost: Number(chatRecord.cost),
                },
                per_request: {
                    model: requestRecord.model_name,
                    input_tokens: requestRecord.input_tokens,
                    output_tokens: requestRecord.output_tokens,
                    cost: Number(requestRecord.cost),
                },
            },
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
    console.error('[monitor-e2e] Test run failed:', error)
    process.exit(1)
})
