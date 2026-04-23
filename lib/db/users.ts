import { query, withTransaction } from './client'
import {
    MAX_BALANCE,
    MAX_BALANCE_MICROS,
    decimalToMicros,
    microsToDecimalString,
} from '@/lib/utils/money'

export interface User {
    id: string
    email: string
    name: string
    role: string
    balance: number
    used_balance?: number
    openwebui_order?: number | null
    deleted?: boolean
    exists_in_openwebui?: boolean
}

interface OpenWebUIUser {
    id: string
    email: string
    name: string
    role: string
}

interface OpenWebUIUsersPage {
    users: OpenWebUIUser[]
    total: number | null
}

interface SyncUsersOptions {
    force?: boolean
}

interface SyncUsersResult {
    synced: boolean
    skipped: boolean
    userCount: number
    reason?: string
}

let lastUsersSyncAt = 0
let usersSyncPromise: Promise<SyncUsersResult> | null = null

function getUsersSyncIntervalMs() {
    const parsedValue = parseInt(
        process.env.OPENWEBUI_USERS_SYNC_INTERVAL_MS || '30000',
        10
    )

    return Number.isFinite(parsedValue) && parsedValue >= 0
        ? parsedValue
        : 30000
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function normalizeOpenWebUIUser(user: unknown): OpenWebUIUser | null {
    if (!isRecord(user)) {
        return null
    }

    const id = typeof user.id === 'string' ? user.id.trim() : ''
    const email = typeof user.email === 'string' ? user.email.trim() : ''
    const rawName = typeof user.name === 'string' ? user.name.trim() : ''
    const role =
        typeof user.role === 'string' && user.role.trim()
            ? user.role.trim()
            : 'user'

    if (!id || !email) {
        return null
    }

    return {
        id,
        email,
        name: rawName || email || id,
        role,
    }
}

function normalizeOpenWebUIUsers(payload: unknown): OpenWebUIUser[] {
    const candidateUsers = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.users)
          ? payload.users
          : isRecord(payload) && Array.isArray(payload.data)
            ? payload.data
            : null

    if (!candidateUsers) {
        throw new Error('Unexpected OpenWebUI users response structure')
    }

    return candidateUsers
        .map((user) => normalizeOpenWebUIUser(user))
        .filter((user): user is OpenWebUIUser => user !== null)
}

function normalizeOpenWebUIUsersPage(payload: unknown): OpenWebUIUsersPage {
    if (Array.isArray(payload)) {
        return {
            users: normalizeOpenWebUIUsers(payload),
            total: payload.length,
        }
    }

    if (isRecord(payload)) {
        const users = normalizeOpenWebUIUsers(payload)
        const total =
            typeof payload.total === 'number' && Number.isFinite(payload.total)
                ? payload.total
                : null

        return {
            users,
            total,
        }
    }

    throw new Error('Unexpected OpenWebUI users response structure')
}

async function fetchOpenWebUIUsersInAdminOrder(
    openWebUIDomain: string,
    openWebUIApiKey: string
) {
    const headers = {
        Authorization: `Bearer ${openWebUIApiKey}`,
        Accept: 'application/json',
    }

    try {
        const users: OpenWebUIUser[] = []
        let page = 1
        let total: number | null = null

        while (true) {
            const response = await fetch(
                `${openWebUIDomain.replace(
                    /\/+$/,
                    ''
                )}/api/v1/users?page=${page}&order_by=created_at&direction=asc`,
                {
                    headers,
                    cache: 'no-store',
                }
            )

            if (!response.ok) {
                const responseText = await response.text()
                throw new Error(
                    `Failed to fetch OpenWebUI users page ${page}: ${response.status} ${response.statusText} ${responseText}`
                )
            }

            const parsedPage = normalizeOpenWebUIUsersPage(
                await response.json()
            )

            if (total === null) {
                total = parsedPage.total
            }

            if (parsedPage.users.length === 0) {
                break
            }

            users.push(...parsedPage.users)

            if (
                (total !== null && users.length >= total) ||
                parsedPage.total === 0
            ) {
                break
            }

            page += 1
        }

        if (users.length > 0 || total === 0) {
            return users
        }
    } catch (error) {
        console.warn(
            'Falling back to /api/v1/users/all for OpenWebUI user sync order:',
            error
        )
    }

    const response = await fetch(
        `${openWebUIDomain.replace(/\/+$/, '')}/api/v1/users/all`,
        {
            headers,
            cache: 'no-store',
        }
    )

    if (!response.ok) {
        const responseText = await response.text()
        throw new Error(
            `Failed to fetch OpenWebUI users: ${response.status} ${response.statusText} ${responseText}`
        )
    }

    // `/api/v1/users/all` follows the backend default order, which is
    // typically the reverse of the admin UI's default created_at ascending view.
    return normalizeOpenWebUIUsers(await response.json()).reverse()
}

async function ensureUserColumnsExist() {
    let didAddUsedBalanceColumn = false
    const requiredColumns = [
        {
            name: 'created_at',
            sql: `
        ALTER TABLE users 
          ADD COLUMN created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      `,
        },
        {
            name: 'deleted',
            sql: `
        ALTER TABLE users 
          ADD COLUMN deleted BOOLEAN DEFAULT FALSE;
      `,
        },
        {
            name: 'exists_in_openwebui',
            sql: `
        ALTER TABLE users 
          ADD COLUMN exists_in_openwebui BOOLEAN DEFAULT TRUE;
      `,
        },
        {
            name: 'used_balance',
            sql: `
        ALTER TABLE users
          ADD COLUMN used_balance NUMERIC(16,6) DEFAULT 0;
      `,
        },
        {
            name: 'balance_micros',
            sql: `
        ALTER TABLE users
          ADD COLUMN balance_micros BIGINT DEFAULT 0;
      `,
        },
        {
            name: 'used_balance_micros',
            sql: `
        ALTER TABLE users
          ADD COLUMN used_balance_micros BIGINT DEFAULT 0;
      `,
        },
        {
            name: 'openwebui_order',
            sql: `
        ALTER TABLE users
          ADD COLUMN openwebui_order INTEGER;
      `,
        },
    ]

    for (const column of requiredColumns) {
        const columnExists = await query(
            `
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = $1
        );
      `,
            [column.name]
        )

        if (!columnExists.rows[0].exists) {
            await query(column.sql)
            if (column.name === 'used_balance') {
                didAddUsedBalanceColumn = true
            }
        }
    }

    if (didAddUsedBalanceColumn) {
        const usageTableExists = await query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'user_usage_records'
        );
      `)

        if (usageTableExists.rows[0].exists) {
            await query(`
          WITH usage_totals AS (
            SELECT
              user_id,
              CAST(COALESCE(SUM(cost), 0) AS NUMERIC(16,6)) AS total_used_balance
            FROM user_usage_records
            GROUP BY user_id
          )
          UPDATE users AS u
             SET used_balance = usage_totals.total_used_balance
            FROM usage_totals
           WHERE u.id = usage_totals.user_id;
        `)
        }
    }
}

export async function ensureUserTableExists() {
    const tableExists = await query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'users'
    );
  `)

    if (tableExists.rows[0].exists) {
        await query(`
      ALTER TABLE users 
        ALTER COLUMN balance TYPE NUMERIC(16,6);
    `)

        await query(`
      ALTER TABLE users
        ALTER COLUMN used_balance TYPE NUMERIC(16,6);
    `).catch(() => null)

        await ensureUserColumnsExist()
    } else {
        await query(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        balance NUMERIC(16,6) NOT NULL,
        used_balance NUMERIC(16,6) NOT NULL DEFAULT 0,
        balance_micros BIGINT NOT NULL DEFAULT 0,
        used_balance_micros BIGINT NOT NULL DEFAULT 0,
        openwebui_order INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        deleted BOOLEAN DEFAULT FALSE,
        exists_in_openwebui BOOLEAN DEFAULT TRUE
      );
    `)

        await query(`
      CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
    `)
    }

    await query(`
    CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
  `)

    await query(`
    UPDATE users
       SET balance_micros = ROUND(COALESCE(balance, 0) * 1000000)::BIGINT,
           used_balance_micros = ROUND(COALESCE(used_balance, 0) * 1000000)::BIGINT,
           balance = ROUND(COALESCE(balance, 0)::NUMERIC, 6),
           used_balance = ROUND(COALESCE(used_balance, 0)::NUMERIC, 6);
  `)
}

export async function getOrCreateUser(userData: User) {
    await ensureUserTableExists()
    const initBalanceMicros = decimalToMicros(process.env.INIT_BALANCE || '0')

    const result = await query(
        `
    INSERT INTO users (
      id,
      email,
      name,
      role,
      balance,
      balance_micros,
      used_balance,
      used_balance_micros,
      exists_in_openwebui
    )
      VALUES ($1, $2, $3, $4, $5, $6, 0, 0, TRUE)
      ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email,
          name = EXCLUDED.name,
          role = EXCLUDED.role,
          exists_in_openwebui = TRUE
      RETURNING *`,
        [
            userData.id,
            userData.email,
            userData.name,
            userData.role || 'user',
            microsToDecimalString(initBalanceMicros),
            initBalanceMicros.toString(),
        ]
    )

    return result.rows[0]
}

export async function syncUsersFromOpenWebUI({
    force = false,
}: SyncUsersOptions = {}): Promise<SyncUsersResult> {
    await ensureUserTableExists()

    const openWebUIDomain = process.env.OPENWEBUI_DOMAIN?.trim()
    const openWebUIApiKey = process.env.OPENWEBUI_API_KEY?.trim()

    if (!openWebUIDomain || !openWebUIApiKey) {
        return {
            synced: false,
            skipped: true,
            userCount: 0,
            reason: 'missing_config',
        }
    }

    const syncIntervalMs = getUsersSyncIntervalMs()
    if (
        !force &&
        syncIntervalMs > 0 &&
        Date.now() - lastUsersSyncAt < syncIntervalMs
    ) {
        return {
            synced: false,
            skipped: true,
            userCount: 0,
            reason: 'cooldown',
        }
    }

    if (usersSyncPromise) {
        return usersSyncPromise
    }

    usersSyncPromise = (async () => {
        const remoteUsers = await fetchOpenWebUIUsersInAdminOrder(
            openWebUIDomain,
            openWebUIApiKey
        )
        const remoteUserIds = remoteUsers.map((user) => user.id)
        const initBalance = process.env.INIT_BALANCE || '0'
        const initBalanceMicros = decimalToMicros(initBalance)

        await withTransaction(async (client) => {
            for (const [index, user] of remoteUsers.entries()) {
                await query(
                    `
              INSERT INTO users (
                id,
                email,
                name,
                role,
                balance,
                balance_micros,
                used_balance,
                used_balance_micros,
                exists_in_openwebui,
                openwebui_order
              )
              VALUES ($1, $2, $3, $4, $5, $6, 0, 0, TRUE, $7)
              ON CONFLICT (id) DO UPDATE
              SET email = EXCLUDED.email,
                  name = EXCLUDED.name,
                  role = EXCLUDED.role,
                  exists_in_openwebui = TRUE,
                  openwebui_order = EXCLUDED.openwebui_order
            `,
                    [
                        user.id,
                        user.email,
                        user.name,
                        user.role,
                        microsToDecimalString(initBalanceMicros),
                        initBalanceMicros.toString(),
                        index,
                    ],
                    client
                )
            }

            await query(
                `
            UPDATE users
               SET exists_in_openwebui = FALSE,
                   openwebui_order = NULL
             WHERE NOT (id = ANY($1::text[]))
          `,
                [remoteUserIds],
                client
            )
        })

        lastUsersSyncAt = Date.now()

        return {
            synced: true,
            skipped: false,
            userCount: remoteUsers.length,
        }
    })()

    try {
        return await usersSyncPromise
    } finally {
        usersSyncPromise = null
    }
}

export async function updateUserBalance(
    userId: string,
    balance: number
): Promise<number> {
    await ensureUserTableExists()
    const balanceMicros = decimalToMicros(balance)

    if (balanceMicros > MAX_BALANCE_MICROS) {
        throw new Error('Balance exceeds maximum allowed value')
    }

    const result = await query(
        `
    UPDATE users 
      SET balance = LEAST(
        CAST($2 AS NUMERIC(16,6)),
        CAST($3 AS NUMERIC(16,6))
      ),
          balance_micros = LEAST(
            $4::BIGINT,
            $5::BIGINT
          )
      WHERE id = $1
      RETURNING balance`,
        [
            userId,
            microsToDecimalString(balanceMicros),
            MAX_BALANCE.toFixed(6),
            balanceMicros.toString(),
            MAX_BALANCE_MICROS.toString(),
        ]
    )

    if (result.rows.length === 0) {
        throw new Error('User not found')
    }

    return Number(result.rows[0].balance)
}

export async function resetUserUsedBalance(userId: string) {
    await ensureUserTableExists()

    const result = await query(
        `
    UPDATE users
       SET used_balance = 0,
           used_balance_micros = 0
     WHERE id = $1
     RETURNING id, email, name, role, balance, used_balance
  `,
        [userId]
    )

    if (result.rows.length === 0) {
        throw new Error('User not found')
    }

    return result.rows[0]
}

export async function deleteUser(userId: string) {
    await ensureUserTableExists()

    const updateResult = await query(
        `
    UPDATE users 
      SET deleted = TRUE 
      WHERE id = $1`,
        [userId]
    )

    console.log(`User with ID ${userId} marked as deleted.`, updateResult)
}

interface GetUsersOptions {
    page?: number
    pageSize?: number
    sortField?: string | null
    sortOrder?: string | null
    search?: string | null
    includeMissingFromOpenWebUI?: boolean
}

export async function getUsers({
    page = 1,
    pageSize = 20,
    sortField = null,
    sortOrder = null,
    search = null,
    includeMissingFromOpenWebUI = false,
}: GetUsersOptions = {}) {
    await ensureUserTableExists()

    const offset = (page - 1) * pageSize
    const conditions = []
    const queryParams: any[] = []

    if (!includeMissingFromOpenWebUI) {
        conditions.push('COALESCE(exists_in_openwebui, TRUE) = TRUE')
    }

    if (search) {
        const loweredSearch = search.trim()
        const nameSearchIndex = queryParams.length + 1
        const emailSearchIndex = queryParams.length + 2

        queryParams.push(`%${loweredSearch}%`, `%${loweredSearch}%`)
        conditions.push(
            `(name ILIKE $${nameSearchIndex} OR email ILIKE $${emailSearchIndex})`
        )
    }

    const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await query(
        `SELECT COUNT(*) FROM users ${whereClause}`,
        queryParams
    )
    const total = parseInt(countResult.rows[0].count)

    let orderClause = 'openwebui_order ASC NULLS LAST, created_at DESC'
    if (search) {
        const searchStartsWithIndex = queryParams.length + 1
        const searchContainsNameIndex = queryParams.length + 2
        const searchContainsEmailIndex = queryParams.length + 3

        orderClause = `
      CASE 
        WHEN name ILIKE $${searchStartsWithIndex} THEN 1
        WHEN name ILIKE $${searchContainsNameIndex} THEN 2
        WHEN email ILIKE $${searchContainsEmailIndex} THEN 3
        ELSE 4
      END,
      openwebui_order ASC NULLS LAST,
      created_at DESC`
        queryParams.push(
            `${search.trim()}%`,
            `%${search.trim()}%`,
            `%${search.trim()}%`
        )
    } else if (sortField && sortOrder) {
        const allowedFields = [
            'balance',
            'used_balance',
            'name',
            'email',
            'role',
            'created_at',
        ]
        if (allowedFields.includes(sortField)) {
            orderClause = `${sortField} ${
                sortOrder === 'ascend' ? 'ASC' : 'DESC'
            }, openwebui_order ASC NULLS LAST, created_at DESC`
        }
    }

    queryParams.push(pageSize, offset)
    const result = await query(
        `
    SELECT id, email, name, role, balance, used_balance, openwebui_order, deleted, exists_in_openwebui
      FROM users
      ${whereClause}
      ORDER BY ${orderClause}
      LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
        queryParams
    )

    return {
        users: result.rows,
        total,
    }
}

export async function getAllUsers(
    includeMissingFromOpenWebUI: boolean = false
) {
    await ensureUserTableExists()

    const conditions = []

    if (!includeMissingFromOpenWebUI) {
        conditions.push('COALESCE(exists_in_openwebui, TRUE) = TRUE')
    }

    const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const result = await query(`
    SELECT id, email, name, role, balance, used_balance, openwebui_order, deleted, exists_in_openwebui
      FROM users
      ${whereClause}
      ORDER BY openwebui_order ASC NULLS LAST, created_at DESC
  `)

    return result.rows
}
