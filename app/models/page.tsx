'use client'

import { useState, useEffect } from 'react'
import { Progress, Segmented, Table, message, Tooltip } from 'antd'
import {
    ExperimentOutlined,
    CheckOutlined,
    CloseOutlined,
    InfoCircleOutlined,
    UpOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { motion, AnimatePresence } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { toast, Toaster } from 'sonner'
import { EditableCell } from '@/components/editable-cell'
import { applyPriceMultiplier, formatMoney } from '@/lib/utils/money'

type PriceField =
    'input_price' | 'output_price' | 'per_msg_price' | 'price_multiplier'

type BillingMode = 'token' | 'request'
type TokenGuidePriceField = 'input_price' | 'output_price'

interface ModelPricing {
    input_price: number
    output_price: number
    per_msg_price: number
    price_multiplier: number
    billing_mode: BillingMode
    effective_input_price: number
    effective_output_price: number
    effective_per_msg_price: number
}

interface ModelResponse extends ModelPricing {
    id: string
    name: string
    base_model_id: string
    system_prompt: string
    imageUrl: string
}

interface Model extends ModelResponse {
    testStatus?: 'success' | 'error' | 'testing'
    syncStatus?: 'syncing' | 'success' | 'error'
}

interface ModelPricingResult {
    id: string
    success: boolean
    data?: Partial<ModelPricing>
    error?: string
}

interface ModelPricingApiResponse {
    error?: string
    results?: ModelPricingResult[]
}

interface ModelSyncResult extends Partial<ModelPricing> {
    id: string
    success: boolean
}

interface ModelSyncApiResponse {
    error?: string
    syncedModels?: ModelSyncResult[]
}

const EFFECTIVE_PRICE_FIELDS: Record<
    TokenGuidePriceField,
    'effective_input_price' | 'effective_output_price'
> = {
    input_price: 'effective_input_price',
    output_price: 'effective_output_price',
}

function finiteNumber(value: unknown, fallback: number): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeModelPricing(pricing: Partial<ModelPricing>): ModelPricing {
    const inputPrice = finiteNumber(pricing.input_price, 60)
    const outputPrice = finiteNumber(pricing.output_price, 60)
    const perMsgPrice = finiteNumber(pricing.per_msg_price, -1)
    const priceMultiplier = finiteNumber(pricing.price_multiplier, 1)
    const billingMode =
        pricing.billing_mode === 'token' || pricing.billing_mode === 'request'
            ? pricing.billing_mode
            : perMsgPrice >= 0
              ? 'request'
              : 'token'

    return {
        input_price: inputPrice,
        output_price: outputPrice,
        per_msg_price: perMsgPrice,
        price_multiplier: priceMultiplier,
        billing_mode: billingMode,
        effective_input_price: finiteNumber(
            pricing.effective_input_price,
            Number(applyPriceMultiplier(inputPrice, priceMultiplier))
        ),
        effective_output_price: finiteNumber(
            pricing.effective_output_price,
            Number(applyPriceMultiplier(outputPrice, priceMultiplier))
        ),
        effective_per_msg_price: perMsgPrice,
    }
}

function mergeModelPricing(
    model: Model,
    pricing: Partial<ModelPricing>
): Model {
    const mergedPricing = { ...model, ...pricing }

    return {
        ...model,
        ...normalizeModelPricing({
            input_price: mergedPricing.input_price,
            output_price: mergedPricing.output_price,
            per_msg_price: mergedPricing.per_msg_price,
            price_multiplier: mergedPricing.price_multiplier,
            billing_mode: mergedPricing.billing_mode,
            effective_input_price: pricing.effective_input_price,
            effective_output_price: pricing.effective_output_price,
            effective_per_msg_price: pricing.effective_per_msg_price,
        }),
    }
}

const TestStatusIndicator = ({ status }: { status: Model['testStatus'] }) => {
    if (!status) return null

    const variants = {
        testing: {
            container: 'bg-blue-100',
            icon: 'w-3 h-3 rounded-full border-2 border-blue-500 border-t-transparent animate-spin',
        },
        success: {
            container: 'bg-green-100',
            icon: 'text-[10px] text-green-500',
        },
        error: {
            container: 'bg-red-100',
            icon: 'text-[10px] text-red-500',
        },
    }

    const variant = variants[status]

    return (
        <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className={`w-4 h-4 rounded-full ${variant.container} flex items-center justify-center`}
        >
            {status === 'testing' ? (
                <div className={variant.icon} />
            ) : status === 'success' ? (
                <CheckOutlined className={variant.icon} />
            ) : (
                <CloseOutlined className={variant.icon} />
            )}
        </motion.div>
    )
}

const TestProgressPanel = ({
    isVisible,
    models,
    isComplete,
    t,
}: {
    isVisible: boolean
    models: Model[]
    isComplete: boolean
    t: (key: string) => string
}) => {
    const [isExpanded, setIsExpanded] = useState(true)
    const successCount = models.filter((m) => m.testStatus === 'success').length
    const errorCount = models.filter((m) => m.testStatus === 'error').length
    const testingCount = models.filter((m) => m.testStatus === 'testing').length
    const totalCount = models.length
    const progress = Math.round(
        ((successCount + errorCount) / totalCount) * 100
    )

    useEffect(() => {
        if (testingCount > 0) {
            setIsExpanded(true)
        }
    }, [testingCount])

    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    className="rounded-xl bg-card border shadow-sm overflow-hidden"
                >
                    <div className="p-6 space-y-6">
                        <div
                            className="flex items-center justify-between cursor-pointer"
                            onClick={() => setIsExpanded(!isExpanded)}
                        >
                            <div className="flex items-center gap-3">
                                <h3 className="text-lg font-semibold">
                                    {isComplete
                                        ? t('models.testComplete')
                                        : t('models.testingModels')}
                                </h3>
                                <TestStatusIndicator
                                    status={
                                        testingCount > 0
                                            ? 'testing'
                                            : isComplete
                                              ? 'success'
                                              : 'error'
                                    }
                                />
                            </div>
                            <motion.div
                                animate={{ rotate: isExpanded ? 180 : 0 }}
                                transition={{ duration: 0.2 }}
                            >
                                <UpOutlined className="text-lg text-muted-foreground" />
                            </motion.div>
                        </div>

                        <AnimatePresence initial={false}>
                            {isExpanded && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.2 }}
                                    className="space-y-6 overflow-hidden"
                                >
                                    <div className="space-y-4">
                                        <Progress
                                            percent={progress}
                                            strokeColor={{
                                                '0%': '#4F46E5',
                                                '100%': '#10B981',
                                            }}
                                            trailColor="#E5E7EB"
                                            className="!m-0"
                                        />

                                        <div className="grid grid-cols-3 gap-4">
                                            <div className="space-y-1">
                                                <div className="text-2xl font-semibold text-green-500">
                                                    {successCount}
                                                </div>
                                                <div className="text-sm text-muted-foreground">
                                                    {t('models.testSuccess')}
                                                </div>
                                            </div>
                                            <div className="space-y-1">
                                                <div className="text-2xl font-semibold text-red-500">
                                                    {errorCount}
                                                </div>
                                                <div className="text-sm text-muted-foreground">
                                                    {t('models.testFailed')}
                                                </div>
                                            </div>
                                            <div className="space-y-1">
                                                <div className="text-2xl font-semibold text-blue-500">
                                                    {testingCount}
                                                </div>
                                                <div className="text-sm text-muted-foreground">
                                                    {t('models.testing')}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <motion.div
                                        className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3"
                                        initial="hidden"
                                        animate="visible"
                                        variants={{
                                            visible: {
                                                transition: {
                                                    staggerChildren: 0.05,
                                                },
                                            },
                                        }}
                                    >
                                        {models.map((model) => (
                                            <motion.div
                                                key={model.id}
                                                variants={{
                                                    hidden: {
                                                        opacity: 0,
                                                        y: 20,
                                                    },
                                                    visible: {
                                                        opacity: 1,
                                                        y: 0,
                                                    },
                                                }}
                                                className="flex items-center gap-2 p-2 rounded-lg bg-muted/50"
                                            >
                                                <Image
                                                    src={model.imageUrl}
                                                    alt={model.name}
                                                    width={24}
                                                    height={24}
                                                    unoptimized
                                                    className="rounded-full"
                                                />
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-sm font-medium truncate">
                                                        {model.name}
                                                    </div>
                                                </div>
                                                <TestStatusIndicator
                                                    status={model.testStatus}
                                                />
                                            </motion.div>
                                        ))}
                                    </motion.div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}

const LoadingState = ({ t }: { t: (key: string) => string }) => (
    <div className="flex flex-col items-center justify-center py-12 px-4">
        <div className="h-12 w-12 rounded-full border-4 border-primary/10 border-t-primary animate-spin mb-4" />
        <h3 className="text-lg font-medium text-foreground/70">
            {t('models.loading')}
        </h3>
    </div>
)

export default function ModelsPage() {
    const { t } = useTranslation('common')
    const [models, setModels] = useState<Model[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [editingCell, setEditingCell] = useState<{
        id: string
        field: PriceField
    } | null>(null)
    const [testing, setTesting] = useState(false)
    const [apiKey, setApiKey] = useState<string | null>(null)
    const [isTestComplete, setIsTestComplete] = useState(false)
    const [syncing, setSyncing] = useState(false)
    const [draftBillingModes, setDraftBillingModes] = useState<
        Record<string, BillingMode>
    >({})
    const [updatingModelIds, setUpdatingModelIds] = useState<Set<string>>(
        new Set()
    )

    const getDisplayedBillingMode = (model: Model): BillingMode =>
        draftBillingModes[model.id] ?? model.billing_mode

    const clearDraftBillingMode = (modelId: string) => {
        setDraftBillingModes((current) => {
            if (!(modelId in current)) {
                return current
            }

            const next = { ...current }
            delete next[modelId]
            return next
        })
    }

    const setModelUpdating = (modelId: string, isUpdating: boolean) => {
        setUpdatingModelIds((current) => {
            const next = new Set(current)
            if (isUpdating) {
                next.add(modelId)
            } else {
                next.delete(modelId)
            }
            return next
        })
    }

    useEffect(() => {
        const fetchModels = async () => {
            try {
                const token = localStorage.getItem('access_token')
                const response = await fetch('/api/v1/models', {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                })
                if (!response.ok) {
                    throw new Error(t('error.model.failToFetchModels'))
                }
                const data = (await response.json()) as ModelResponse[]
                setModels(
                    data.map((model: ModelResponse) => ({
                        ...model,
                        ...normalizeModelPricing(model),
                    }))
                )
            } catch (err) {
                setError(
                    err instanceof Error
                        ? err.message
                        : t('error.model.unknownError')
                )
            } finally {
                setLoading(false)
            }
        }

        fetchModels()
    }, [t])

    useEffect(() => {
        const fetchApiKey = async () => {
            try {
                const token = localStorage.getItem('access_token')
                const response = await fetch('/api/v1/config/key', {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                })
                if (!response.ok) {
                    throw new Error(
                        `${t('error.model.failToFetchApiKey')}: ${response.status}`
                    )
                }
                const data = await response.json()
                if (!data.apiKey) {
                    throw new Error(t('error.model.ApiKeyNotConfigured'))
                }
                setApiKey(data.apiKey)
            } catch (error) {
                console.error(t('error.model.failToFetchApiKey'), error)
                message.error(
                    error instanceof Error
                        ? error.message
                        : t('error.model.failToFetchApiKey')
                )
            }
        }

        fetchApiKey()
    }, [t])

    const saveModelPricing = async (
        id: string,
        changes: Partial<Pick<ModelPricing, PriceField | 'billing_mode'>>
    ): Promise<void> => {
        const model = models.find((item) => item.id === id)
        if (!model) return

        const nextPricing = {
            input_price: finiteNumber(changes.input_price, model.input_price),
            output_price: finiteNumber(
                changes.output_price,
                model.output_price
            ),
            per_msg_price: finiteNumber(
                changes.per_msg_price,
                model.per_msg_price
            ),
            price_multiplier: finiteNumber(
                changes.price_multiplier,
                model.price_multiplier
            ),
            billing_mode: changes.billing_mode ?? model.billing_mode,
        }

        if (
            nextPricing.input_price < 0 ||
            nextPricing.output_price < 0 ||
            nextPricing.price_multiplier < 0 ||
            (nextPricing.billing_mode === 'request' &&
                nextPricing.per_msg_price < 0)
        ) {
            throw new Error(t('error.model.nonePositiveNumber'))
        }

        setModelUpdating(id, true)

        try {
            const token = localStorage.getItem('access_token')
            const response = await fetch('/api/v1/models/price', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    updates: [
                        {
                            id,
                            ...nextPricing,
                        },
                    ],
                }),
            })

            const data = (await response.json()) as ModelPricingApiResponse
            if (!response.ok)
                throw new Error(data.error || t('error.model.priceUpdateFail'))

            const result = data.results?.[0]
            const resultData = result?.data

            if (result?.success && resultData) {
                setModels((prevModels) =>
                    prevModels.map((model) =>
                        model.id === id
                            ? mergeModelPricing(model, resultData)
                            : model
                    )
                )
                clearDraftBillingMode(id)
                toast.success(t('error.model.priceUpdateSuccess'))
            } else {
                throw new Error(
                    result?.error || t('error.model.priceUpdateFail')
                )
            }
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : t('error.model.priceUpdateFail')
            )
            throw err
        } finally {
            setModelUpdating(id, false)
        }
    }

    const handlePriceUpdate = async (
        id: string,
        field: PriceField,
        value: number
    ): Promise<void> => {
        const model = models.find((item) => item.id === id)
        if (!model) return

        const billingMode = getDisplayedBillingMode(model)
        await saveModelPricing(id, {
            [field]: value,
            billing_mode: billingMode,
        })
    }

    const handleBillingModeChange = async (
        model: Model,
        billingMode: BillingMode
    ) => {
        if (billingMode === getDisplayedBillingMode(model)) {
            return
        }

        if (billingMode === 'request' && model.per_msg_price < 0) {
            setDraftBillingModes((current) => ({
                ...current,
                [model.id]: 'request',
            }))
            setEditingCell({ id: model.id, field: 'per_msg_price' })
            return
        }

        if (billingMode === model.billing_mode) {
            clearDraftBillingMode(model.id)
            setEditingCell(null)
            return
        }

        try {
            await saveModelPricing(model.id, { billing_mode: billingMode })
        } catch {}
    }

    const handleTestSingleModel = async (model: Model) => {
        try {
            setModels((prev) =>
                prev.map((m) =>
                    m.id === model.id ? { ...m, testStatus: 'testing' } : m
                )
            )

            const result = await testModel(model)

            setModels((prev) =>
                prev.map((m) =>
                    m.id === model.id
                        ? {
                              ...m,
                              testStatus: result.success ? 'success' : 'error',
                          }
                        : m
                )
            )
        } catch {
            setModels((prev) =>
                prev.map((m) =>
                    m.id === model.id ? { ...m, testStatus: 'error' } : m
                )
            )
        }
    }

    const handleSyncAllDerivedModels = async () => {
        try {
            setSyncing(true)

            const token = localStorage.getItem('access_token')
            const response = await fetch('/api/v1/models/sync-all-prices', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
            })

            const data = (await response.json()) as ModelSyncApiResponse

            if (!response.ok) {
                throw new Error(data.error || t('models.syncFail'))
            }

            const syncedModels = data.syncedModels ?? []

            if (syncedModels.length > 0) {
                setModels((prev) =>
                    prev.map((model) => {
                        const syncedModel = syncedModels.find(
                            (item) => item.id === model.id && item.success
                        )
                        if (syncedModel) {
                            return mergeModelPricing(model, syncedModel)
                        }
                        return model
                    })
                )

                if (syncedModels.every((item) => item.success)) {
                    toast.success(t('models.syncAllSuccess'))
                } else {
                    toast.warning(t('models.syncAllFail'))
                }
            } else {
                toast.info(t('models.noDerivedModels'))
            }
        } catch (error) {
            console.error('Sync all derived models failed:', error)
            toast.error(
                error instanceof Error ? error.message : t('models.syncFail')
            )
        } finally {
            setSyncing(false)
        }
    }

    const columns: ColumnsType<Model> = [
        {
            title: t('models.table.name'),
            key: 'model',
            width: 200,
            render: (_, record) => (
                <div className="flex items-center gap-3 relative">
                    <div
                        className="relative cursor-pointer"
                        onClick={() => handleTestSingleModel(record)}
                    >
                        {record.imageUrl && (
                            <Image
                                src={record.imageUrl}
                                alt={record.name}
                                width={32}
                                height={32}
                                unoptimized
                                className="rounded-full object-cover"
                            />
                        )}
                        {record.testStatus && (
                            <div className="absolute -top-1 -right-1">
                                {record.testStatus === 'testing' && (
                                    <div className="w-4 h-4 rounded-full bg-blue-100 flex items-center justify-center">
                                        <div className="w-3 h-3 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                                    </div>
                                )}
                                {record.testStatus === 'success' && (
                                    <div className="w-4 h-4 rounded-full bg-green-100 flex items-center justify-center">
                                        <CheckOutlined className="text-[10px] text-green-500" />
                                    </div>
                                )}
                                {record.testStatus === 'error' && (
                                    <div className="w-4 h-4 rounded-full bg-red-100 flex items-center justify-center">
                                        <CloseOutlined className="text-[10px] text-red-500" />
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="font-medium min-w-0 flex-1">
                        <div className="truncate">{record.name}</div>
                        <div className="text-xs text-gray-500 truncate opacity-60">
                            {record.id}
                        </div>
                    </div>
                </div>
            ),
        },
        {
            title: t('models.table.billingMode'),
            key: 'billing_mode',
            width: 190,
            dataIndex: 'billing_mode',
            sorter: (a, b) => a.billing_mode.localeCompare(b.billing_mode),
            sortDirections: ['descend', 'ascend', 'descend'],
            render: (_, record) => renderBillingModeSelector(record),
        },
        {
            title: t('models.table.priceConfiguration'),
            key: 'price_configuration',
            width: 560,
            render: (_, record) => renderPriceConfiguration(record),
        },
    ]

    const handleExportPrices = () => {
        const priceData = models.map((model) => ({
            id: model.id,
            input_price: model.input_price,
            output_price: model.output_price,
            per_msg_price: model.per_msg_price,
            price_multiplier: model.price_multiplier,
            billing_mode: model.billing_mode,
        }))

        const blob = new Blob([JSON.stringify(priceData, null, 2)], {
            type: 'application/json',
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `model_prices_${new Date().toISOString().split('T')[0]}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }

    const handleImportPrices = (file: File) => {
        const reader = new FileReader()
        reader.onload = async (e) => {
            try {
                const importedData: unknown = JSON.parse(
                    e.target?.result as string
                )

                if (!Array.isArray(importedData)) {
                    throw new Error(t('error.model.invalidImportFormat'))
                }

                const validUpdates = importedData.filter(
                    (item): item is Record<string, unknown> =>
                        Boolean(item) &&
                        typeof item === 'object' &&
                        models.some(
                            (model) =>
                                model.id ===
                                (item as Record<string, unknown>).id
                        )
                )

                const response = await fetch('/api/v1/models/price', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${localStorage.getItem('access_token')}`,
                    },
                    body: JSON.stringify({
                        updates: validUpdates,
                    }),
                })

                if (!response.ok) {
                    throw new Error(t('error.model.batchPriceUpdateFail'))
                }

                const data = (await response.json()) as ModelPricingApiResponse
                console.log(t('error.model.serverResponse'), data)

                const results = data.results ?? []

                if (results.length > 0) {
                    setModels((prevModels) =>
                        prevModels.map((model) => {
                            const update = results.find(
                                (result) =>
                                    result.id === model.id &&
                                    result.success &&
                                    result.data
                            )
                            if (update?.data) {
                                return mergeModelPricing(model, update.data)
                            }
                            return model
                        })
                    )
                }

                message.success(
                    `${t('error.model.updateSuccess')} ${
                        results.filter((result) => result.success).length
                    } ${t('error.model.numberOfModelPrice')}`
                )
            } catch (err) {
                console.error(t('error.model.failToImport'), err)
                message.error(
                    err instanceof Error
                        ? err.message
                        : t('error.model.failToImport')
                )
            }
        }
        reader.readAsText(file)
        return false
    }

    const testModel = async (
        model: Model
    ): Promise<{
        id: string
        success: boolean
        error?: string
    }> => {
        if (!apiKey) {
            return {
                id: model.id,
                success: false,
                error: t('error.model.ApiKeyNotFetched'),
            }
        }

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 30000)

        try {
            const token = localStorage.getItem('access_token')
            const response = await fetch('/api/v1/models/test', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    modelId: model.id,
                }),
                signal: controller.signal,
            })

            clearTimeout(timeoutId)
            const data = await response.json()

            if (!response.ok || !data.success) {
                throw new Error(data.error || t('error.model.failToTest'))
            }

            return {
                id: model.id,
                success: true,
            }
        } catch (error) {
            clearTimeout(timeoutId)
            return {
                id: model.id,
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : t('error.model.unknownError'),
            }
        }
    }

    const handleTestModels = async () => {
        if (!apiKey) {
            message.error(t('error.model.failToTestWithoutApiKey'))
            return
        }

        try {
            setModels((prev) =>
                prev.map((m) => ({ ...m, testStatus: 'testing' }))
            )
            setTesting(true)
            setIsTestComplete(false)

            const testPromises = models.map((model) =>
                testModel(model).then((result) => {
                    setModels((prev) =>
                        prev.map((m) =>
                            m.id === model.id
                                ? {
                                      ...m,
                                      testStatus: result.success
                                          ? 'success'
                                          : 'error',
                                  }
                                : m
                        )
                    )
                    return result
                })
            )

            await Promise.all(testPromises)
            setIsTestComplete(true)
        } catch (error) {
            console.error(t('error.model.failToTest'), error)
            message.error(t('error.model.failToTest'))
        } finally {
            setTesting(false)
        }
    }

    const tableClassName = `
    [&_.ant-table]:!border-b-0 
    [&_.ant-table-container]:!rounded-xl 
    [&_.ant-table-container]:!border-hidden
    [&_.ant-table-cell]:!border-border/40
    [&_.ant-table-thead_.ant-table-cell]:!bg-muted/30
    [&_.ant-table-thead_.ant-table-cell]:!text-muted-foreground
    [&_.ant-table-thead_.ant-table-cell]:!font-medium
    [&_.ant-table-thead_.ant-table-cell]:!text-sm
    [&_.ant-table-thead]:!border-b
    [&_.ant-table-thead]:border-border/40
    [&_.ant-table-row]:!transition-colors
    [&_.ant-table-row:hover>*]:!bg-muted/60
    [&_.ant-table-tbody_.ant-table-row]:!cursor-pointer
    [&_.ant-table-tbody_.ant-table-cell]:!py-4
    [&_.ant-table-row:last-child>td]:!border-b-0
    [&_.ant-table-cell:first-child]:!pl-6
    [&_.ant-table-cell:last-child]:!pr-6
  `

    const MobileCard = ({ record }: { record: Model }) => {
        return (
            <div
                data-model-id={record.id}
                className="p-4 sm:p-6 bg-card rounded-xl border border-border/40 
        shadow-sm hover:shadow-md transition-all duration-200 space-y-4"
            >
                <div className="flex items-center gap-3">
                    <div
                        className="relative cursor-pointer group shrink-0"
                        onClick={() => handleTestSingleModel(record)}
                    >
                        <div className="relative">
                            {record.imageUrl && (
                                <Image
                                    src={record.imageUrl}
                                    alt={record.name}
                                    width={40}
                                    height={40}
                                    unoptimized
                                    className="rounded-xl object-cover transition-transform group-hover:scale-105"
                                />
                            )}
                            <div className="absolute inset-0 rounded-xl ring-1 ring-inset ring-black/5"></div>
                        </div>
                        {record.testStatus && (
                            <div className="absolute -top-1 -right-1 z-10">
                                <TestStatusIndicator
                                    status={record.testStatus}
                                />
                            </div>
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-base font-semibold tracking-tight truncate">
                            {record.name}
                        </h3>
                        <p className="text-xs text-muted-foreground/80 truncate font-mono">
                            {record.id}
                        </p>
                    </div>
                </div>

                {renderBillingModeSelector(record, true)}
                {renderPriceConfiguration(record, true)}
            </div>
        )
    }

    const renderBillingModeSelector = (
        record: Model,
        fullWidth: boolean = false
    ) => (
        <Segmented
            block={fullWidth}
            value={getDisplayedBillingMode(record)}
            options={[
                {
                    label: t('models.table.billingModes.token'),
                    value: 'token',
                },
                {
                    label: t('models.table.billingModes.request'),
                    value: 'request',
                },
            ]}
            disabled={updatingModelIds.has(record.id)}
            onChange={(value) =>
                void handleBillingModeChange(record, value as BillingMode)
            }
            data-billing-mode={record.id}
        />
    )

    const renderPriceConfiguration = (
        record: Model,
        mobile: boolean = false
    ) => {
        const billingMode = getDisplayedBillingMode(record)

        if (billingMode === 'request') {
            return (
                <div className={mobile ? 'max-w-full' : 'max-w-[220px]'}>
                    <span className="mb-1 block text-xs text-muted-foreground/80">
                        {t('models.table.perRequestPrice')}
                    </span>
                    {renderPriceCell('per_msg_price', record)}
                </div>
            )
        }

        const fields: Array<{
            field: TokenGuidePriceField | 'price_multiplier'
            label: string
        }> = [
            {
                field: 'input_price',
                label: t('models.table.inputPrice'),
            },
            {
                field: 'output_price',
                label: t('models.table.outputPrice'),
            },
            {
                field: 'price_multiplier',
                label: t('models.table.priceMultiplier'),
            },
        ]

        return (
            <div
                className={
                    mobile
                        ? 'grid grid-cols-2 gap-3 [&>*:last-child]:col-span-2'
                        : 'grid grid-cols-[minmax(130px,1fr)_minmax(130px,1fr)_130px] gap-4'
                }
            >
                {fields.map(({ field, label }) => (
                    <div key={field} className="min-w-0">
                        <span className="mb-1 block text-xs text-muted-foreground/80">
                            {label}
                        </span>
                        {renderPriceCell(field, record)}
                    </div>
                ))}
            </div>
        )
    }

    const renderPriceCell = (field: PriceField, record: Model) => {
        const isEditing =
            editingCell?.id === record.id && editingCell?.field === field
        const currentValue = Number(record[field])
        const isTokenGuidePrice =
            field === 'input_price' || field === 'output_price'
        const hasMultiplier =
            Math.abs(Number(record.price_multiplier) - 1) > 0.0000005
        const effectivePrice = isTokenGuidePrice
            ? Number(record[EFFECTIVE_PRICE_FIELDS[field]])
            : null

        return (
            <div className="min-w-0 space-y-0.5" data-price-field={field}>
                <EditableCell
                    value={currentValue}
                    isEditing={isEditing}
                    onEdit={() => setEditingCell({ id: record.id, field })}
                    onSubmit={async (value) => {
                        try {
                            await handlePriceUpdate(record.id, field, value)
                            setEditingCell(null)
                        } catch {}
                    }}
                    t={t}
                    disabled={updatingModelIds.has(record.id)}
                    onCancel={() => {
                        setEditingCell(null)
                        if (
                            field === 'per_msg_price' &&
                            draftBillingModes[record.id] === 'request' &&
                            record.billing_mode !== 'request'
                        ) {
                            clearDraftBillingMode(record.id)
                        }
                    }}
                    placeholder={
                        field === 'price_multiplier'
                            ? t('models.table.enterMultiplier')
                            : t('models.table.enterPrice')
                    }
                    validateValue={(value) => ({
                        isValid: isFinite(value) && value >= 0,
                        errorMessage: t('error.model.nonePositiveNumber'),
                    })}
                    isPerMsgPrice={field === 'per_msg_price'}
                    suffix={field === 'price_multiplier' ? 'x' : undefined}
                    strikeThrough={isTokenGuidePrice && hasMultiplier}
                />
                {isTokenGuidePrice && hasMultiplier && (
                    <div
                        className="px-2 text-[11px] leading-4 text-muted-foreground/70 whitespace-nowrap"
                        data-effective-price={field}
                    >
                        {formatMoney(effectivePrice)}
                    </div>
                )}
            </div>
        )
    }

    if (error) {
        return (
            <div className="p-4 text-red-500">
                {t('common.error')}: {error}
            </div>
        )
    }

    return (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pt-24 space-y-8">
            <Toaster
                richColors
                position="top-center"
                theme="light"
                expand
                duration={1500}
            />

            <div className="space-y-4">
                <h1 className="text-3xl font-bold tracking-tight">
                    {t('models.title')}
                </h1>
                <p className="text-muted-foreground">
                    {t('models.description')}
                </p>
            </div>

            <div className="flex flex-wrap gap-4">
                <Button
                    variant="default"
                    size="default"
                    onClick={handleTestModels}
                    className="relative flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white shadow-sm hover:shadow-md transition-all duration-200"
                    disabled={testing && !isTestComplete}
                >
                    <motion.div
                        animate={testing ? { rotate: 360 } : { rotate: 0 }}
                        transition={{
                            duration: 2,
                            repeat: Infinity,
                            ease: 'linear',
                        }}
                    >
                        <ExperimentOutlined className="h-4 w-4" />
                    </motion.div>
                    {testing ? t('models.testing') : t('models.testAll')}
                    <Tooltip title={t('models.testTooltip')}>
                        <InfoCircleOutlined className="h-3.5 w-3.5 text-white/80 hover:text-white" />
                    </Tooltip>
                </Button>

                <Button
                    variant="default"
                    size="default"
                    onClick={handleSyncAllDerivedModels}
                    className="relative flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white shadow-sm hover:shadow-md transition-all duration-200"
                    disabled={syncing}
                >
                    <motion.div
                        animate={syncing ? { rotate: 360 } : { rotate: 0 }}
                        transition={{
                            duration: 2,
                            repeat: Infinity,
                            ease: 'linear',
                        }}
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                            />
                        </svg>
                    </motion.div>
                    {syncing
                        ? t('models.syncing')
                        : t('models.syncAllDerivedModels')}
                    <Tooltip title={t('models.syncTooltip')}>
                        <InfoCircleOutlined className="h-3.5 w-3.5 text-white/80 hover:text-white" />
                    </Tooltip>
                </Button>

                <Button
                    variant="outline"
                    size="default"
                    onClick={handleExportPrices}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white hover:bg-gray-50 text-zinc-800 border border-zinc-200 shadow-sm hover:shadow-md transition-all duration-200"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                        />
                    </svg>
                    {t('models.exportConfig')}
                </Button>

                <Button
                    variant="outline"
                    size="default"
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white hover:bg-gray-50 text-zinc-800 border border-zinc-200 shadow-sm hover:shadow-md transition-all duration-200"
                    onClick={() =>
                        document.getElementById('import-input')?.click()
                    }
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                        />
                    </svg>
                    {t('models.importConfig')}
                </Button>
                <input
                    id="import-input"
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) {
                            handleImportPrices(file)
                        }
                        e.target.value = ''
                    }}
                />
            </div>

            <TestProgressPanel
                isVisible={testing || isTestComplete}
                models={models}
                isComplete={isTestComplete}
                t={t}
            />

            <div className="hidden sm:block">
                <div className="rounded-xl border border-border/40 bg-card shadow-sm overflow-hidden">
                    {loading ? (
                        <LoadingState t={t} />
                    ) : (
                        <Table
                            columns={columns}
                            dataSource={models}
                            rowKey="id"
                            loading={false}
                            pagination={false}
                            size="middle"
                            className={tableClassName}
                            scroll={{ x: 950 }}
                            rowClassName={() => 'group'}
                        />
                    )}
                </div>
            </div>

            <div className="sm:hidden">
                {loading ? (
                    <LoadingState t={t} />
                ) : (
                    <div className="grid gap-4">
                        {models.map((model) => (
                            <MobileCard key={model.id} record={model} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
