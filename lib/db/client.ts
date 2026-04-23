import { attachDatabasePool } from '@vercel/functions'
import { Pool, PoolClient } from 'pg'

const isVercel = process.env.VERCEL === '1'

let pgPool: Pool | null = null
let isPoolAttached = false

function getPoolConfig() {
    const connectionString =
        process.env.POSTGRES_URL || process.env.DATABASE_URL

    const commonConfig = {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 30000,
        statement_timeout: 30000,
    }

    if (connectionString) {
        const isLocalConnection =
            connectionString.includes('localhost') ||
            connectionString.includes('127.0.0.1')

        return {
            ...commonConfig,
            connectionString,
            ssl: isLocalConnection ? false : { rejectUnauthorized: false },
        }
    }

    return {
        ...commonConfig,
        host: process.env.POSTGRES_HOST || 'db',
        user: process.env.POSTGRES_USER || 'postgres',
        password: process.env.POSTGRES_PASSWORD,
        database: process.env.POSTGRES_DATABASE || 'openwebui_monitor',
        port: parseInt(process.env.POSTGRES_PORT || '5432'),
    }
}

function getClient() {
    if (!pgPool) {
        pgPool = new Pool(getPoolConfig())

        if (isVercel && !isPoolAttached) {
            attachDatabasePool(pgPool)
            isPoolAttached = true
        }

        pgPool.on('error', (error) => {
            console.error('Unexpected error on idle client', error)
        })
    }

    return pgPool
}

type CommonQueryResult<T = any> = {
    rows: T[]
    rowCount: number
}

type Queryable = Pool | PoolClient

export async function query<T = any>(
    text: string,
    params?: any[],
    client?: Queryable
): Promise<CommonQueryResult<T>> {
    const queryable = client || getClient()

    try {
        const result = await queryable.query(text, params)
        return {
            rows: result.rows,
            rowCount: result.rowCount || 0,
        }
    } catch (error) {
        console.error('[DB Query Error]', error)
        console.error(`Query text: ${text}`)
        console.error(`Query params:`, params)
        throw error
    }
}

export async function withTransaction<T>(
    callback: (client: PoolClient) => Promise<T>
): Promise<T> {
    const client = await getClient().connect()

    try {
        await client.query('BEGIN')
        const result = await callback(client)
        await client.query('COMMIT')
        return result
    } catch (error) {
        try {
            await client.query('ROLLBACK')
        } catch (rollbackError) {
            console.error('Failed to rollback transaction:', rollbackError)
        }
        throw error
    } finally {
        client.release()
    }
}

if (typeof window === 'undefined') {
    process.on('SIGTERM', async () => {
        console.log('SIGTERM received, closing database connections')
        if (pgPool) {
            await pgPool.end()
            pgPool = null
        }
        isPoolAttached = false
    })
}

export { getClient }

export async function ensureTablesExist() {
    try {
        const usersTableExists = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'users'
      );
    `)
        let didAddUsedBalanceColumn = false

        if (!usersTableExists.rows[0].exists) {
            await query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          balance DECIMAL(16, 6) NOT NULL DEFAULT 0,
          used_balance DECIMAL(16, 4) NOT NULL DEFAULT 0,
          openwebui_order INTEGER,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          deleted BOOLEAN DEFAULT FALSE,
          exists_in_openwebui BOOLEAN DEFAULT TRUE
        );
      `)
        } else {
            try {
                await query(`
          DO $$ 
          BEGIN 
            BEGIN
              ALTER TABLE users 
              ADD COLUMN deleted BOOLEAN DEFAULT FALSE;
            EXCEPTION 
              WHEN duplicate_column THEN NULL;
            END;
          END $$;
        `)
            } catch (error) {
                console.error(
                    'Error adding deleted column to users table:',
                    error
                )
            }

            try {
                const usedBalanceColumnExists = await query(`
          SELECT EXISTS (
            SELECT FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'used_balance'
          );
        `)

                if (!usedBalanceColumnExists.rows[0].exists) {
                    didAddUsedBalanceColumn = true
                }

                await query(`
          DO $$ 
          BEGIN 
            BEGIN
              ALTER TABLE users 
              ADD COLUMN used_balance DECIMAL(16, 4) DEFAULT 0;
            EXCEPTION 
              WHEN duplicate_column THEN NULL;
            END;
          END $$;
        `)
            } catch (error) {
                console.error(
                    'Error adding used_balance column to users table:',
                    error
                )
            }

            try {
                await query(`
          DO $$ 
          BEGIN 
            BEGIN
              ALTER TABLE users 
              ADD COLUMN exists_in_openwebui BOOLEAN DEFAULT TRUE;
            EXCEPTION 
              WHEN duplicate_column THEN NULL;
            END;
          END $$;
        `)
            } catch (error) {
                console.error(
                    'Error adding exists_in_openwebui column to users table:',
                    error
                )
            }

            try {
                await query(`
          DO $$ 
          BEGIN 
            BEGIN
              ALTER TABLE users 
              ADD COLUMN openwebui_order INTEGER;
            EXCEPTION 
              WHEN duplicate_column THEN NULL;
            END;
          END $$;
        `)
            } catch (error) {
                console.error(
                    'Error adding openwebui_order column to users table:',
                    error
                )
            }
        }

        const modelPricesTableExists = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'model_prices'
      );
    `)

        const defaultInputPrice = parseFloat(
            process.env.DEFAULT_MODEL_INPUT_PRICE || '60'
        )
        const defaultOutputPrice = parseFloat(
            process.env.DEFAULT_MODEL_OUTPUT_PRICE || '60'
        )
        const defaultPerMsgPrice = parseFloat(
            process.env.DEFAULT_MODEL_PER_MSG_PRICE || '-1'
        )

        if (!modelPricesTableExists.rows[0].exists) {
            await query(`
        CREATE TABLE IF NOT EXISTS model_prices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_model_id TEXT,
          input_price NUMERIC(10, 6) DEFAULT ${defaultInputPrice},
          output_price NUMERIC(10, 6) DEFAULT ${defaultOutputPrice},
          per_msg_price NUMERIC(10, 6) DEFAULT ${defaultPerMsgPrice},
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `)
        } else {
            try {
                await query(`
          DO $$ 
          BEGIN 
            BEGIN
              ALTER TABLE model_prices 
              ADD COLUMN per_msg_price NUMERIC(10, 6) DEFAULT ${defaultPerMsgPrice};
            EXCEPTION 
              WHEN duplicate_column THEN NULL;
            END;
          END $$;
        `)
            } catch (error) {
                console.error('Error adding per_msg_price column:', error)
            }

            try {
                await query(`
          DO $$ 
          BEGIN 
            BEGIN
              ALTER TABLE model_prices 
              ADD COLUMN base_model_id TEXT;
            EXCEPTION 
              WHEN duplicate_column THEN NULL;
            END;
          END $$;
        `)
            } catch (error) {
                console.error('Error adding base_model_id column:', error)
            }
        }

        const userUsageRecordsTableExists = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'user_usage_records'
      );
    `)

        if (!userUsageRecordsTableExists.rows[0].exists) {
            await query(`
        CREATE TABLE IF NOT EXISTS user_usage_records (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          nickname VARCHAR(255) NOT NULL,
          use_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          model_name VARCHAR(255) NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cost DECIMAL(10, 4) NOT NULL,
          balance_after DECIMAL(10, 4) NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `)
        }

        if (didAddUsedBalanceColumn) {
            await query(`
        WITH usage_totals AS (
          SELECT
            user_id,
            CAST(COALESCE(SUM(cost), 0) AS DECIMAL(16,4)) AS total_used_balance
          FROM user_usage_records
          GROUP BY user_id
        )
        UPDATE users AS u
           SET used_balance = usage_totals.total_used_balance
          FROM usage_totals
         WHERE u.id = usage_totals.user_id;
      `)
        }

        console.log('Database tables initialized successfully')
    } catch (error) {
        console.error('Failed to initialize database tables:', error)
        throw error
    }
}

export async function initDatabase() {
    try {
        await ensureTablesExist()
        console.log('Database initialized successfully')
    } catch (error) {
        console.error('Failed to initialize database:', error)
        throw error
    }
}

export interface ModelPrice {
    id: string
    name: string
    input_price: number
    output_price: number
    per_msg_price: number
    updated_at: Date
}

export interface UserUsageRecord {
    id: number
    userId: number
    nickname: string
    useTime: Date
    modelName: string
    inputTokens: number
    outputTokens: number
    cost: number
    balanceAfter: number
}

export async function getOrCreateModelPrices(
    models: Array<{ id: string; name: string; base_model_id?: string }>
): Promise<ModelPrice[]> {
    try {
        const defaultInputPrice = parseFloat(
            process.env.DEFAULT_MODEL_INPUT_PRICE || '60'
        )
        const defaultOutputPrice = parseFloat(
            process.env.DEFAULT_MODEL_OUTPUT_PRICE || '60'
        )
        const defaultPerMsgPrice = parseFloat(
            process.env.DEFAULT_MODEL_PER_MSG_PRICE || '-1'
        )

        const modelIds = models.map((m) => m.id)
        const baseModelIds = models
            .map((m) => m.base_model_id)
            .filter((id) => id)

        const existingModelsResult = await query(
            `SELECT * FROM model_prices WHERE id = ANY($1::text[])`,
            [modelIds]
        )

        const baseModelsResult = await query(
            `SELECT * FROM model_prices WHERE id = ANY($1::text[])`,
            [baseModelIds]
        )

        const existingModels = new Map(
            existingModelsResult.rows.map((row) => [row.id, row])
        )
        const baseModels = new Map(
            baseModelsResult.rows.map((row) => [row.id, row])
        )

        const modelsToUpdate = models.filter((m) => existingModels.has(m.id))
        const missingModels = models.filter((m) => !existingModels.has(m.id))

        if (modelsToUpdate.length > 0) {
            for (const model of modelsToUpdate) {
                await query(`UPDATE model_prices SET name = $2 WHERE id = $1`, [
                    model.id,
                    model.name,
                ])
            }
        }

        if (missingModels.length > 0) {
            for (const model of missingModels) {
                const baseModel = model.base_model_id
                    ? baseModels.get(model.base_model_id)
                    : null

                await query(
                    `INSERT INTO model_prices (id, name, input_price, output_price, per_msg_price)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
                    [
                        model.id,
                        model.name,
                        baseModel?.input_price ?? defaultInputPrice,
                        baseModel?.output_price ?? defaultOutputPrice,
                        baseModel?.per_msg_price ?? defaultPerMsgPrice,
                    ]
                )
            }
        }

        const updatedModelsResult = await query(
            `SELECT * FROM model_prices WHERE id = ANY($1::text[])`,
            [modelIds]
        )

        return updatedModelsResult.rows.map((row) => ({
            id: row.id,
            name: row.name,
            input_price: Number(row.input_price),
            output_price: Number(row.output_price),
            per_msg_price: Number(row.per_msg_price),
            updated_at: row.updated_at,
        }))
    } catch (error) {
        console.error('Error in getOrCreateModelPrices:', error)
        throw error
    }
}

export async function updateModelPrice(
    id: string,
    input_price: number,
    output_price: number,
    per_msg_price: number
): Promise<ModelPrice | null> {
    try {
        const result = await query(
            `UPDATE model_prices 
       SET 
         input_price = CAST($2 AS NUMERIC(10,6)),
         output_price = CAST($3 AS NUMERIC(10,6)),
         per_msg_price = CAST($4 AS NUMERIC(10,6)),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
            [id, input_price, output_price, per_msg_price]
        )

        if (result.rows[0]) {
            return {
                id: result.rows[0].id,
                name: result.rows[0].model_name,
                input_price: Number(result.rows[0].input_price),
                output_price: Number(result.rows[0].output_price),
                per_msg_price: Number(result.rows[0].per_msg_price),
                updated_at: result.rows[0].updated_at,
            }
        }
        return null
    } catch (error) {
        console.error('Error updating model price:', error)
        throw error
    }
}

export async function updateUserBalance(userId: string, balance: number) {
    try {
        const result = await query(
            `UPDATE users
       SET balance = $2
       WHERE id = $1
       RETURNING id, email, balance, used_balance`,
            [userId, balance]
        )

        return result.rows[0]
    } catch (error) {
        console.error('Error in updateUserBalance:', error)
        throw error
    }
}

export const pool = {
    connect: async () => getClient().connect(),
    query: async (text: string, params?: any[]) =>
        getClient().query(text, params),
    end: async () => {
        if (pgPool) {
            await pgPool.end()
            pgPool = null
        }
        isPoolAttached = false
    },
}
