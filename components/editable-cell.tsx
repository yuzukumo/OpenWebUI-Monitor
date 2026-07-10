'use client'

import { useState, useEffect } from 'react'
import { Input } from 'antd'
import { Button } from '@/components/ui/button'
import { CheckOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { Tooltip } from 'antd'
import { toast } from 'sonner'
import { formatMoney } from '@/lib/utils/money'

interface EditableCellProps {
    value: number
    isEditing: boolean
    onEdit: () => void
    onSubmit: (value: number) => Promise<void>
    onCancel: () => void
    t: (key: string, options?: { max?: number }) => string
    disabled?: boolean
    tooltipText?: string
    placeholder?: string
    validateValue?: (value: number) => {
        isValid: boolean
        errorMessage?: string
        maxValue?: number
    }
    isPerMsgPrice?: boolean
    suffix?: string
    displayValue?: number
    formatValue?: (value: number) => string
}

export function EditableCell({
    value,
    isEditing,
    onEdit,
    onSubmit,
    onCancel,
    t,
    disabled = false,
    tooltipText,
    placeholder,
    validateValue = () => ({ isValid: true }),
    isPerMsgPrice = false,
    suffix,
    displayValue,
    formatValue = formatMoney,
}: EditableCellProps) {
    const numericValue = typeof value === 'number' ? value : Number(value)
    const renderedValue = displayValue ?? numericValue
    const originalValue = numericValue >= 0 ? formatValue(numericValue) : ''
    const [inputValue, setInputValue] = useState(originalValue)
    const [isSaving, setIsSaving] = useState(false)

    useEffect(() => {
        if (isEditing) {
            setInputValue(originalValue)
        }
    }, [isEditing, originalValue])

    useEffect(() => {
        if (isEditing) {
            const handleClickOutside = (e: MouseEvent) => {
                const target = e.target as HTMLElement
                if (!target.closest('.editable-cell-input')) {
                    onCancel()
                }
            }

            document.addEventListener('mousedown', handleClickOutside)
            return () => {
                document.removeEventListener('mousedown', handleClickOutside)
            }
        }
    }, [isEditing, onCancel])

    const handleSubmit = async () => {
        try {
            setIsSaving(true)
            const numValue = Number(inputValue)
            const validation = validateValue(numValue)

            if (!validation.isValid) {
                toast.error(validation.errorMessage || t('error.invalidInput'))
                return
            }

            if (
                validation.maxValue !== undefined &&
                numValue > validation.maxValue
            ) {
                toast.error(
                    t('error.exceedsMaxValue', { max: validation.maxValue })
                )
                return
            }

            await onSubmit(numValue)
        } catch {
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <div className={`relative ${disabled ? 'opacity-50' : ''}`}>
            {isEditing ? (
                <div className="relative editable-cell-input flex items-center gap-1.5">
                    <Input
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        className="
              !w-[calc(100%-32px)]
              !border
              !border-slate-200
              focus:!border-slate-300
              !bg-white
              !shadow-sm
              hover:!shadow
              focus:!shadow-md
              !px-2
              !py-1
              !h-7
              flex-1
              !rounded-lg
              !text-slate-600
              !text-sm
              !font-medium
              placeholder:!text-slate-400/70
              transition-all
              duration-200
              focus:!ring-2
              focus:!ring-slate-200/50
              focus:!ring-offset-0
            "
                        placeholder={placeholder || t('common.enterValue')}
                        suffix={
                            suffix ? (
                                <span className="text-xs text-muted-foreground">
                                    {suffix}
                                </span>
                            ) : undefined
                        }
                        onPressEnter={handleSubmit}
                        autoFocus
                        disabled={isSaving}
                    />
                    <Button
                        size="sm"
                        variant="ghost"
                        className={`
              h-7 w-7
              flex-shrink-0
              bg-gradient-to-r from-slate-500/80 to-slate-600/80
              hover:from-slate-600 hover:to-slate-700
              text-white/90
              shadow-sm
              rounded-lg
              transition-all
              duration-200
              hover:scale-105
              active:scale-95
              p-0
              flex
              items-center
              justify-center
              ${isSaving ? 'cursor-not-allowed opacity-70' : ''}
            `}
                        onClick={(e) => {
                            e.stopPropagation()
                            handleSubmit()
                        }}
                        disabled={isSaving}
                    >
                        {isSaving ? (
                            <div className="w-3 h-3 rounded-full border-2 border-white/90 border-t-transparent animate-spin" />
                        ) : (
                            <CheckOutlined className="text-xs" />
                        )}
                    </Button>
                </div>
            ) : (
                <div
                    onClick={disabled ? undefined : onEdit}
                    className={`
            group
            px-2
            py-1
            rounded-lg
            transition-colors
            duration-200
            ${
                disabled
                    ? 'cursor-not-allowed line-through'
                    : 'cursor-pointer hover:bg-primary/5'
            }
          `}
                >
                    <span
                        className={`
              font-medium
              text-sm
              transition-colors
              duration-200
              ${
                  disabled
                      ? 'text-muted-foreground/60'
                      : 'text-primary/80 group-hover:text-primary'
              }
            `}
                    >
                        {isPerMsgPrice && numericValue < 0 ? (
                            <span className="text-muted-foreground/60">
                                {t('common.notSet')}
                            </span>
                        ) : (
                            <>
                                {formatValue(renderedValue)}
                                {suffix && (
                                    <span className="ml-0.5 text-muted-foreground">
                                        {suffix}
                                    </span>
                                )}
                                {tooltipText && (
                                    <Tooltip title={tooltipText}>
                                        <InfoCircleOutlined className="ml-1 text-muted-foreground/60" />
                                    </Tooltip>
                                )}
                            </>
                        )}
                    </span>
                </div>
            )}
        </div>
    )
}
