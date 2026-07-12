'use client'

import { useState, useEffect } from 'react'
import { Input, message, Modal, Pagination, Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useTranslation } from 'react-i18next'
import { RotateCcw, Search, X } from 'lucide-react'
import { EditableCell } from '@/components/editable-cell'
import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import { toast, Toaster } from 'sonner'
import { formatMoney, MAX_BALANCE } from '@/lib/utils/money'

interface User {
    id: string
    email: string
    name: string
    role: string
    balance: number
    used_balance: number
}

type UsersSortInfo = {
    field: string | null
    order: 'ascend' | 'descend' | null
}

interface TFunction {
    (key: string): string
    (key: string, options: Record<string, string>): string
}

const TABLE_STYLES = `
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
  [&_.ant-table-tbody_.ant-table-cell]:!py-2
  [&_.ant-table-row:last-child>td]:!border-b-0
  [&_.ant-table-cell:first-child]:!pl-4
  [&_.ant-table-cell:last-child]:!pr-4
  [&_.ant-pagination]:!px-6
  [&_.ant-pagination]:!py-4
  [&_.ant-pagination]:!border-t
  [&_.ant-pagination]:border-border/40
  [&_.ant-pagination-item]:!rounded-lg
  [&_.ant-pagination-item]:!border-border/40
  [&_.ant-pagination-item-active]:!bg-primary/10
  [&_.ant-pagination-item-active]:!border-primary/30
  [&_.ant-pagination-item-active>a]:!text-primary
  [&_.ant-pagination-prev_.ant-pagination-item-link]:!rounded-lg
  [&_.ant-pagination-next_.ant-pagination-item-link]:!rounded-lg
  [&_.ant-pagination-prev_.ant-pagination-item-link]:!border-border/40
  [&_.ant-pagination-next_.ant-pagination-item-link]:!border-border/40
`

const formatBalance = (balance: number | string) => {
    return formatMoney(balance)
}

const sortUsersLocally = (users: User[], sortInfo: UsersSortInfo) => {
    if (!sortInfo.field || !sortInfo.order) {
        return users
    }

    const direction = sortInfo.order === 'ascend' ? 1 : -1

    return [...users].sort((left, right) => {
        switch (sortInfo.field) {
            case 'balance':
                return (
                    (Number(left.balance) - Number(right.balance)) * direction
                )
            case 'used_balance':
                return (
                    (Number(left.used_balance) - Number(right.used_balance)) *
                    direction
                )
            case 'name':
                return left.name.localeCompare(right.name) * direction
            case 'email':
                return left.email.localeCompare(right.email) * direction
            case 'role':
                return left.role.localeCompare(right.role) * direction
            default:
                return 0
        }
    })
}

const UserDetailsModal = ({
    user,
    onClose,
    t,
}: {
    user: User | null
    onClose: () => void
    t: TFunction
}) => {
    if (!user) return null

    return createPortal(
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center"
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}
            onClick={onClose}
        >
            <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ type: 'spring', duration: 0.3 }}
                className="w-full max-w-lg mx-auto px-4"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="bg-card rounded-2xl border border-border/50 shadow-xl overflow-hidden">
                    <div className="relative px-6 pt-6">
                        <motion.button
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="absolute right-4 top-4 p-2 rounded-full hover:bg-muted/80 transition-colors"
                            onClick={onClose}
                        >
                            <X className="w-4 h-4 text-muted-foreground" />
                        </motion.button>
                        <div className="flex items-center gap-4 mb-6">
                            <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center text-primary font-medium text-2xl">
                                {user.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                                <h3 className="text-lg font-semibold mb-1">
                                    {user.name}
                                </h3>
                                <span className="px-2.5 py-1 text-xs rounded-full bg-primary/10 text-primary font-medium">
                                    {user.role}
                                </span>
                            </div>
                        </div>
                    </div>

                    <div className="px-6 pb-6">
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1 }}
                            className="space-y-6"
                        >
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <div className="text-sm text-muted-foreground">
                                        {t('users.email')}
                                    </div>
                                    <div className="p-3 bg-muted/50 rounded-lg text-sm break-all">
                                        {user.email}
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <div className="text-sm text-muted-foreground">
                                        {t('users.id')}
                                    </div>
                                    <div className="p-3 bg-muted/50 rounded-lg text-sm font-mono break-all">
                                        {user.id}
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <div className="text-sm text-muted-foreground">
                                        {t('users.usedBalance')}
                                    </div>
                                    <div className="p-3 bg-muted/50 rounded-lg text-sm">
                                        {formatBalance(user.used_balance)}
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <div className="text-sm text-muted-foreground">
                                        {t('users.remainingBalance')}
                                    </div>
                                    <div className="p-3 bg-muted/50 rounded-lg text-sm">
                                        {formatBalance(user.balance)}
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    </div>
                </div>
            </motion.div>
        </motion.div>,
        document.getElementById('modal-root') || document.body
    )
}

const LoadingState = ({ t }: { t: TFunction }) => (
    <div className="flex flex-col items-center justify-center py-12 px-4">
        <div className="h-12 w-12 rounded-full border-4 border-primary/10 border-t-primary animate-spin mb-4" />
        <h3 className="text-lg font-medium text-foreground/70">
            {t('users.loading')}
        </h3>
    </div>
)

const UserSearchBar = ({
    value,
    placeholder,
    searchLabel,
    clearLabel,
    onChange,
    onSearch,
    onClear,
}: {
    value: string
    placeholder: string
    searchLabel: string
    clearLabel: string
    onChange: (value: string) => void
    onSearch: () => void
    onClear: () => void
}) => {
    const [isFocused, setIsFocused] = useState(false)

    return (
        <motion.form
            data-testid="user-search"
            initial={false}
            animate={{
                boxShadow: isFocused
                    ? '0 4px 24px rgba(0, 0, 0, 0.08)'
                    : '0 2px 8px rgba(0, 0, 0, 0.04)',
            }}
            className="flex min-h-12 w-full items-center gap-2 overflow-hidden rounded-xl border border-border/40 bg-card px-3"
            onSubmit={(event) => {
                event.preventDefault()
                onSearch()
            }}
        >
            <Search className="h-4 w-4 shrink-0 text-muted-foreground/60" />
            <Input
                type="search"
                autoComplete="off"
                spellCheck="false"
                aria-label={placeholder}
                placeholder={placeholder}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                className="h-11 min-w-0 flex-1 border-0 bg-transparent px-0 text-base leading-normal ring-0 placeholder:text-muted-foreground/50 focus:ring-0 [&::-webkit-search-cancel-button]:hidden"
            />
            {value && (
                <button
                    type="button"
                    aria-label={clearLabel}
                    onClick={onClear}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <X className="h-4 w-4" />
                </button>
            )}
            <button
                type="submit"
                className="h-8 shrink-0 whitespace-nowrap rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
                {searchLabel}
            </button>
        </motion.form>
    )
}

const EmptyState = ({
    title,
    description,
}: {
    title: string
    description: string
}) => (
    <div className="flex flex-col items-center justify-center px-4 py-12">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted/40">
            <Search className="h-6 w-6 text-muted-foreground/50" />
        </div>
        <h3 className="mb-2 text-lg font-medium text-foreground">{title}</h3>
        <p className="max-w-[300px] text-center text-sm text-muted-foreground">
            {description}
        </p>
    </div>
)

export default function UsersPage() {
    const { t } = useTranslation('common')
    const [modal, modalContextHolder] = Modal.useModal()
    const [users, setUsers] = useState<User[]>([])
    const [loading, setLoading] = useState(false)
    const [total, setTotal] = useState(0)
    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(50)
    const [editingKey, setEditingKey] = useState<string>('')
    const [resettingUserId, setResettingUserId] = useState<string | null>(null)
    const [selectedUser, setSelectedUser] = useState<User | null>(null)
    const [sortInfo, setSortInfo] = useState<UsersSortInfo>({
        field: null,
        order: null,
    })
    const [searchInput, setSearchInput] = useState('')
    const [searchText, setSearchText] = useState('')

    const fetchUsers = async (page: number) => {
        setLoading(true)
        try {
            let url = `/api/v1/users?page=${page}&pageSize=${pageSize}`
            if (sortInfo.field && sortInfo.order) {
                url += `&sortField=${sortInfo.field}&sortOrder=${sortInfo.order}`
            }
            if (searchText) {
                url += `&search=${encodeURIComponent(searchText)}`
            }

            const token = localStorage.getItem('access_token')
            const res = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)

            setUsers(
                data.users.map((user: User) => ({
                    ...user,
                    balance: Number(user.balance),
                    used_balance: Number(user.used_balance),
                }))
            )
            setTotal(data.total)
        } catch (err) {
            console.error(err)
            message.error(t('users.message.fetchError'))
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchUsers(currentPage)
    }, [currentPage, pageSize, sortInfo, searchText])

    const handleSearch = () => {
        setCurrentPage(1)
        setEditingKey('')
        setSearchText(searchInput.trim())
    }

    const handleClearSearch = () => {
        setSearchInput('')
        setSearchText('')
        setCurrentPage(1)
        setEditingKey('')
    }

    const handlePaginationChange = (page: number, nextPageSize: number) => {
        setCurrentPage(nextPageSize === pageSize ? page : 1)
        setPageSize(nextPageSize)
        setEditingKey('')
    }

    const handleUpdateBalance = async (userId: string, newBalance: number) => {
        try {
            console.log(`Updating balance for user ${userId} to ${newBalance}`)

            const token = localStorage.getItem('access_token')
            if (!token) {
                throw new Error(t('auth.unauthorized'))
            }

            const res = await fetch(`/api/v1/users/${userId}/balance`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ balance: newBalance }),
            })

            const data = await res.json()
            console.log('Update balance response:', data)

            if (!res.ok) {
                throw new Error(
                    data.error || t('users.message.updateBalance.error')
                )
            }

            const updatedBalance = Number(data.balance)
            const updatedUsedBalance = Number(data.used_balance)

            setUsers((currentUsers) =>
                sortUsersLocally(
                    currentUsers.map((user) =>
                        user.id === userId
                            ? {
                                  ...user,
                                  balance: updatedBalance,
                                  used_balance: updatedUsedBalance,
                              }
                            : user
                    ),
                    sortInfo
                )
            )
            setSelectedUser((prevUser) =>
                prevUser?.id === userId
                    ? {
                          ...prevUser,
                          balance: updatedBalance,
                          used_balance: updatedUsedBalance,
                      }
                    : prevUser
            )

            toast.success(t('users.message.updateBalance.success'))
            setEditingKey('')
        } catch (err) {
            console.error('Failed to update balance:', err)
            toast.error(
                err instanceof Error
                    ? err.message
                    : t('users.message.updateBalance.error')
            )
        }
    }

    const handleResetUsedBalance = async (userId: string) => {
        try {
            setResettingUserId(userId)

            const token = localStorage.getItem('access_token')
            if (!token) {
                throw new Error(t('auth.unauthorized'))
            }

            const res = await fetch(
                `/api/v1/users/${userId}/used-balance/reset`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                }
            )

            const data = await res.json()

            if (!res.ok || !data.success) {
                throw new Error(
                    data.error || t('users.message.resetUsedBalance.error')
                )
            }

            const updatedBalance = Number(data.user.balance)
            const updatedUsedBalance = Number(data.user.used_balance)

            setUsers((currentUsers) =>
                sortUsersLocally(
                    currentUsers.map((user) =>
                        user.id === userId
                            ? {
                                  ...user,
                                  balance: updatedBalance,
                                  used_balance: updatedUsedBalance,
                              }
                            : user
                    ),
                    sortInfo
                )
            )
            setSelectedUser((prevUser) =>
                prevUser?.id === userId
                    ? {
                          ...prevUser,
                          balance: updatedBalance,
                          used_balance: updatedUsedBalance,
                      }
                    : prevUser
            )

            toast.success(t('users.message.resetUsedBalance.success'))
        } catch (err) {
            console.error('Failed to reset used balance:', err)
            toast.error(
                err instanceof Error
                    ? err.message
                    : t('users.message.resetUsedBalance.error')
            )
        } finally {
            setResettingUserId(null)
        }
    }

    const confirmResetUsedBalance = (user: User) => {
        modal.confirm({
            title: t('users.resetConfirm.title'),
            content: t('users.resetConfirm.description', { name: user.name }),
            okText: t('common.confirm'),
            cancelText: t('common.cancel'),
            centered: true,
            okButtonProps: { danger: true },
            onOk: () => handleResetUsedBalance(user.id),
        })
    }

    const UserCard = ({ record }: { record: User }) => {
        return (
            <div className="rounded-xl border border-border/40 bg-card p-4 shadow-sm transition-all duration-200 hover:shadow-md">
                <div className="flex items-start gap-4">
                    <div
                        className="flex-1 min-w-0 flex items-start gap-4 cursor-pointer"
                        onClick={() => setSelectedUser(record)}
                    >
                        <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary font-medium text-lg shrink-0">
                            {record.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0 space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="text-base font-semibold tracking-tight max-w-[160px] truncate">
                                    {record.name}
                                </h3>
                                <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary font-medium">
                                    {record.role}
                                </span>
                            </div>
                            <p className="text-sm text-muted-foreground max-w-[240px] truncate">
                                {record.email}
                            </p>
                        </div>
                    </div>
                </div>

                <div className="mt-4">
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">
                                {t('users.usedBalance')}
                            </span>
                            <span className="text-sm font-medium">
                                {formatBalance(record.used_balance)}
                            </span>
                        </div>
                        <div className="space-y-1.5">
                            <span className="text-sm text-muted-foreground">
                                {t('users.remainingBalance')}
                            </span>
                            <div className="flex items-center gap-3">
                                <div className="flex-1 max-w-[200px]">
                                    <EditableCell
                                        value={record.balance}
                                        isEditing={record.id === editingKey}
                                        onEdit={() => setEditingKey(record.id)}
                                        onSubmit={(value) =>
                                            handleUpdateBalance(
                                                record.id,
                                                value
                                            )
                                        }
                                        onCancel={() => setEditingKey('')}
                                        t={t}
                                        validateValue={(value) => ({
                                            isValid: isFinite(value),
                                            errorMessage: t(
                                                'error.invalidNumber'
                                            ),
                                            maxValue: MAX_BALANCE,
                                        })}
                                    />
                                </div>
                                <button
                                    type="button"
                                    data-testid={`reset-used-balance-${record.id}`}
                                    disabled={
                                        resettingUserId === record.id ||
                                        Number(record.used_balance) <= 0
                                    }
                                    onClick={() =>
                                        confirmResetUsedBalance(record)
                                    }
                                    className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-border/50 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <RotateCcw className="h-3.5 w-3.5 shrink-0" />
                                    {t('users.resetUsedBalance')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    const getColumns = (): ColumnsType<User> => {
        const baseColumns: ColumnsType<User> = [
            {
                title: t('users.userInfo'),
                key: 'userInfo',
                width: '42%',
                render: (_, record) => (
                    <div
                        className="flex items-center gap-3 cursor-pointer"
                        onClick={() => setSelectedUser(record)}
                    >
                        <div className="h-9 w-9 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center text-primary font-medium">
                            {record.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="mb-0.5 flex items-center gap-2">
                                <span className="font-medium max-w-[200px] truncate">
                                    {record.name}
                                </span>
                                <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary font-medium">
                                    {record.role}
                                </span>
                            </div>
                            <div className="text-sm text-muted-foreground max-w-[280px] truncate">
                                {record.email}
                            </div>
                        </div>
                    </div>
                ),
            },
            {
                title: t('users.usedBalance'),
                dataIndex: 'used_balance',
                key: 'used_balance',
                width: '18%',
                align: 'left',
                sorter: {
                    compare: (a, b) =>
                        Number(a.used_balance) - Number(b.used_balance),
                    multiple: 2,
                },
                render: (usedBalance: number | string) =>
                    formatBalance(usedBalance),
            },
            {
                title: t('users.remainingBalance'),
                dataIndex: 'balance',
                key: 'balance',
                width: '22%',
                align: 'left',
                sorter: {
                    compare: (a, b) => Number(a.balance) - Number(b.balance),
                    multiple: 1,
                },
                render: (balance: number, record) => {
                    const isEditing = record.id === editingKey

                    return (
                        <div className="flex items-center gap-4">
                            <div className="flex-1">
                                <EditableCell
                                    value={balance}
                                    isEditing={isEditing}
                                    onEdit={() => setEditingKey(record.id)}
                                    onSubmit={(value) =>
                                        handleUpdateBalance(record.id, value)
                                    }
                                    onCancel={() => setEditingKey('')}
                                    t={t}
                                    validateValue={(value) => ({
                                        isValid: isFinite(value),
                                        errorMessage: t('error.invalidNumber'),
                                        maxValue: MAX_BALANCE,
                                    })}
                                />
                            </div>
                        </div>
                    )
                },
            },
            {
                title: t('users.actions'),
                key: 'actions',
                width: 150,
                render: (_, record) => (
                    <button
                        type="button"
                        data-testid={`reset-used-balance-${record.id}`}
                        disabled={
                            resettingUserId === record.id ||
                            Number(record.used_balance) <= 0
                        }
                        onClick={(event) => {
                            event.stopPropagation()
                            confirmResetUsedBalance(record)
                        }}
                        className="inline-flex min-w-max items-center gap-2 whitespace-nowrap rounded-lg border border-border/50 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <RotateCcw className="h-3.5 w-3.5 shrink-0" />
                        {t('users.resetUsedBalance')}
                    </button>
                ),
            },
        ]

        return baseColumns
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
            {modalContextHolder}
            <div className="space-y-4">
                <h1 className="text-3xl font-bold tracking-tight">
                    {t('users.title')}
                </h1>
                <p className="text-muted-foreground">
                    {t('users.description')}
                </p>
            </div>

            <UserSearchBar
                value={searchInput}
                placeholder={t('users.searchPlaceholder')}
                searchLabel={t('users.search')}
                clearLabel={t('common.close')}
                onChange={setSearchInput}
                onSearch={handleSearch}
                onClear={handleClearSearch}
            />

            <div className="hidden sm:block">
                <div className="rounded-xl border border-border/40 bg-card shadow-sm overflow-hidden">
                    {loading ? (
                        <LoadingState t={t} />
                    ) : users.length > 0 ? (
                        <Table
                            columns={getColumns()}
                            dataSource={users.map((user) => ({
                                key: user.id,
                                ...user,
                                balance: Number(user.balance),
                                used_balance: Number(user.used_balance),
                            }))}
                            rowKey="id"
                            loading={false}
                            className={TABLE_STYLES}
                            pagination={{
                                total,
                                pageSize,
                                current: currentPage,
                                showSizeChanger: true,
                                pageSizeOptions: ['10', '50', '100'],
                                onChange: handlePaginationChange,
                                showTotal: (total) => (
                                    <span className="text-sm text-muted-foreground">
                                        {t('users.total')} {total}{' '}
                                        {t('users.totalRecords')}
                                    </span>
                                ),
                            }}
                            scroll={{ x: 900 }}
                            onChange={(pagination, filters, sorter) => {
                                if (Array.isArray(sorter)) return
                                setCurrentPage(1)
                                setSortInfo({
                                    field: sorter.columnKey as string,
                                    order: sorter.order || null,
                                })
                            }}
                        />
                    ) : (
                        <EmptyState
                            title={t('users.noResults.title')}
                            description={
                                searchText
                                    ? t('users.noResults.withFilter', {
                                          filter: searchText,
                                      })
                                    : t('users.noResults.default')
                            }
                        />
                    )}
                </div>
            </div>

            <div className="sm:hidden">
                <div className="grid gap-4">
                    {loading ? (
                        <LoadingState t={t} />
                    ) : users.length > 0 ? (
                        users.map((user) => (
                            <UserCard key={user.id} record={user} />
                        ))
                    ) : (
                        <EmptyState
                            title={t('users.noResults.title')}
                            description={
                                searchText
                                    ? t('users.noResults.withFilter', {
                                          filter: searchText,
                                      })
                                    : t('users.noResults.default')
                            }
                        />
                    )}
                </div>
                {!loading && total > 0 && (
                    <Pagination
                        current={currentPage}
                        pageSize={pageSize}
                        total={total}
                        showSizeChanger
                        responsive
                        size="small"
                        pageSizeOptions={['10', '50', '100']}
                        onChange={handlePaginationChange}
                        className="mt-4 flex flex-wrap justify-center gap-y-2"
                    />
                )}
            </div>

            <AnimatePresence>
                {selectedUser && (
                    <UserDetailsModal
                        user={selectedUser}
                        onClose={() => setSelectedUser(null)}
                        t={t}
                    />
                )}
            </AnimatePresence>
        </div>
    )
}
