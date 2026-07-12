'use client'

import { useState } from 'react'
import { Pagination, Select, Table } from 'antd'
import type { TablePaginationConfig } from 'antd'
import type { FilterValue } from 'antd/es/table/interface'
import type { SorterResult } from 'antd/es/table/interface'
import dayjs from '@/lib/dayjs'
import { useTranslation } from 'react-i18next'
import { formatMoney } from '@/lib/utils/money'
interface UsageRecord {
    id: number
    nickname: string
    use_time: string
    model_name: string
    input_tokens: number
    output_tokens: number
    cost: number
    balance_after: number
}

interface TableParams {
    pagination: TablePaginationConfig
    sortField?: string
    sortOrder?: string
    filters?: Record<string, FilterValue | null>
}

interface Props {
    loading: boolean
    records: UsageRecord[]
    tableParams: TableParams
    models: { model_name: string }[]
    users: { nickname: string }[]
    onTableChange: (
        pagination: TablePaginationConfig,
        filters: Record<string, FilterValue | null>,
        sorter: SorterResult<UsageRecord> | SorterResult<UsageRecord>[]
    ) => void
}

const MobileCard = ({
    record,
    t,
}: {
    record: UsageRecord
    t: (key: string) => string
}) => {
    return (
        <div className="p-4 bg-white rounded-xl border border-gray-100/80 shadow-sm transition-all duration-200 hover:shadow-md hover:border-gray-200/80">
            <div className="flex justify-between items-start mb-4">
                <div className="space-y-1">
                    <div className="font-medium text-gray-900">
                        {record.nickname}
                    </div>
                    <div className="text-xs text-gray-500 flex items-center gap-1.5">
                        <div className="w-1 h-1 rounded-full bg-gray-300" />
                        {dayjs(record.use_time).format('YYYY-MM-DD HH:mm:ss')}
                    </div>
                </div>
                <div className="text-right">
                    <div className="font-medium text-primary">
                        ¥{formatMoney(record.cost)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                        {t('panel.usageDetails.table.balance')}: ¥
                        {formatMoney(record.balance_after)}
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-4 bg-gray-50/70 rounded-lg p-3">
                <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-500 mb-1.5">
                        {t('panel.usageDetails.table.model')}
                    </div>
                    <div className="text-sm text-gray-700 font-medium truncate">
                        {record.model_name}
                    </div>
                </div>
                <div className="shrink-0">
                    <div className="text-xs text-gray-500 mb-1.5">Tokens</div>
                    <div className="text-sm text-gray-700 font-medium tabular-nums">
                        {(
                            record.input_tokens + record.output_tokens
                        ).toLocaleString()}
                    </div>
                </div>
            </div>
        </div>
    )
}

export default function UsageRecordsTable({
    loading,
    records,
    tableParams,
    models,
    users,
    onTableChange,
}: Props) {
    const { t } = useTranslation('common')

    const [filters, setFilters] = useState<Record<string, FilterValue | null>>(
        tableParams.filters || {}
    )

    const handleFilterChange = (field: string, value: string[] | null) => {
        const newFilters = {
            ...filters,
            [field]: value,
        }
        setFilters(newFilters)
        onTableChange({ ...tableParams.pagination, current: 1 }, newFilters, {})
    }

    const columns = [
        {
            title: t('panel.usageDetails.table.user'),
            dataIndex: 'nickname',
            key: 'nickname',
            width: 120,
            filters: users.map((user) => ({
                text: user.nickname,
                value: user.nickname,
            })),
            filterMode: 'menu' as const,
            filtered: filters.nickname ? filters.nickname.length > 0 : false,
            filteredValue: filters.nickname || null,
        },
        {
            title: t('panel.usageDetails.table.time'),
            dataIndex: 'use_time',
            key: 'use_time',
            width: 180,
            sorter: true,
            render: (time: string) => dayjs(time).format('YYYY-MM-DD HH:mm:ss'),
        },
        {
            title: t('panel.usageDetails.table.model'),
            dataIndex: 'model_name',
            key: 'model_name',
            width: 150,
            filters: models.map((model) => ({
                text: model.model_name,
                value: model.model_name,
            })),
            filterMode: 'menu' as const,
            filtered: filters.model_name
                ? filters.model_name.length > 0
                : false,
            filteredValue: filters.model_name || null,
        },
        {
            title: t('panel.usageDetails.table.tokens'),
            key: 'tokens',
            width: 120,
            sorter: true,
            render: (_: unknown, record: UsageRecord) =>
                (record.input_tokens + record.output_tokens).toLocaleString(),
        },
        {
            title: t('panel.usageDetails.table.cost'),
            dataIndex: 'cost',
            key: 'cost',
            width: 100,
            sorter: true,
            render: (_: unknown, record: UsageRecord) =>
                `${t('common.currency')}${formatMoney(record.cost)}`,
        },
        {
            title: t('panel.usageDetails.table.balance'),
            dataIndex: 'balance_after',
            key: 'balance_after',
            width: 100,
            sorter: true,
            render: (_: unknown, record: UsageRecord) =>
                `${t('common.currency')}${formatMoney(record.balance_after)}`,
        },
    ]

    return (
        <div className="space-y-4">
            <div className="sm:hidden space-y-3">
                <Select
                    mode="multiple"
                    placeholder={t('panel.usageDetails.table.user')}
                    className="w-full"
                    value={filters.nickname as string[]}
                    onChange={(value) => handleFilterChange('nickname', value)}
                    options={users.map((user) => ({
                        label: user.nickname,
                        value: user.nickname,
                    }))}
                    maxTagCount="responsive"
                />
                <Select
                    mode="multiple"
                    placeholder={t('panel.usageDetails.table.model')}
                    className="w-full"
                    value={filters.model_name as string[]}
                    onChange={(value) =>
                        handleFilterChange('model_name', value)
                    }
                    options={models.map((model) => ({
                        label: model.model_name,
                        value: model.model_name,
                    }))}
                    maxTagCount="responsive"
                />
            </div>

            <div className="hidden sm:block">
                <Table
                    columns={columns}
                    dataSource={records}
                    loading={loading}
                    onChange={onTableChange}
                    pagination={{
                        ...tableParams.pagination,
                        showSizeChanger: true,
                        pageSizeOptions: ['10', '50', '100'],
                        showTotal: (total) => (
                            <span className="inline-flex h-8 items-center whitespace-nowrap">
                                {t('common.total')} {total}
                            </span>
                        ),
                        itemRender: (page, type, originalElement) => {
                            if (type === 'prev') {
                                return (
                                    <span className="inline-flex h-8 items-center whitespace-nowrap px-2 hover:text-primary">
                                        {t('common.prev')}
                                    </span>
                                )
                            }
                            if (type === 'next') {
                                return (
                                    <span className="inline-flex h-8 items-center whitespace-nowrap px-2 hover:text-primary">
                                        {t('common.next')}
                                    </span>
                                )
                            }
                            return originalElement
                        },
                    }}
                    rowKey="id"
                    scroll={{ x: 800 }}
                    className="overflow-hidden rounded-md border bg-background [&_.ant-table-thead]:bg-muted [&_.ant-table-thead>tr>th]:bg-transparent [&_.ant-table-thead>tr>th]:text-muted-foreground [&_.ant-table-tbody>tr>td]:border-muted [&_.ant-table-tbody>tr:last-child>td]:!border-b-0 [&_.ant-table-tbody>tr:hover>td]:bg-muted/50 [&_.ant-pagination]:!m-0 [&_.ant-pagination]:flex [&_.ant-pagination]:items-center [&_.ant-pagination]:px-4 [&_.ant-pagination]:py-3 [&_.ant-pagination-item]:border-muted [&_.ant-pagination-item]:bg-transparent [&_.ant-pagination-item]:hover:border-primary [&_.ant-pagination-item]:hover:text-primary [&_.ant-pagination-item-active]:border-primary [&_.ant-pagination-item-active]:bg-transparent [&_.ant-pagination-item-active]:text-primary [&_.ant-pagination-prev]:hover:text-primary [&_.ant-pagination-next]:hover:text-primary [&_.ant-pagination-options]:!ml-auto [&_.ant-pagination-options]:inline-flex [&_.ant-pagination-options]:h-8 [&_.ant-pagination-options]:items-center [&_.ant-pagination-total-text]:inline-flex [&_.ant-pagination-total-text]:h-8 [&_.ant-pagination-total-text]:items-center [&_.ant-select]:border-muted [&_.ant-select]:hover:border-primary [&_.ant-select-focused]:border-primary"
                />
            </div>

            <div className="sm:hidden space-y-4">
                {loading ? (
                    <div className="flex justify-center py-8">
                        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary animate-spin rounded-full" />
                    </div>
                ) : (
                    <>
                        <div className="space-y-3">
                            {records.map((record) => (
                                <MobileCard
                                    key={record.id}
                                    record={record}
                                    t={t}
                                />
                            ))}
                        </div>
                        <Pagination
                            {...tableParams.pagination}
                            showSizeChanger
                            responsive
                            size="small"
                            pageSizeOptions={['10', '50', '100']}
                            onChange={(page, pageSize) =>
                                onTableChange(
                                    {
                                        ...tableParams.pagination,
                                        current: page,
                                        pageSize,
                                    },
                                    filters,
                                    {}
                                )
                            }
                            className="flex flex-wrap justify-center gap-y-2 [&_.ant-pagination-options]:!ml-0"
                        />
                    </>
                )}
            </div>
        </div>
    )
}
