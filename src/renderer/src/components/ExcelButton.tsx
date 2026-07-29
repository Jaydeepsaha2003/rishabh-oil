import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { exportRowsToExcel, type ExcelColumn, type ExcelSheet } from '@/lib/excel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A consistent "Excel" download button used across list/register pages.
export function ExcelButton({
  filename,
  sheetName,
  title,
  columns,
  rows,
  extraSheets,
  isGroup,
  outlineDetail,
  label = 'Excel',
  disabled,
  className
}: {
  filename: string
  sheetName?: string
  title?: string
  columns: ExcelColumn[]
  rows: Row[]
  extraSheets?: ExcelSheet[]
  isGroup?: (row: Row) => boolean
  outlineDetail?: boolean
  label?: string
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  async function onClick(): Promise<void> {
    try {
      await exportRowsToExcel({ filename, sheetName, title, columns, rows, extraSheets, isGroup, outlineDetail })
      toast.success(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to Excel`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={disabled || rows.length === 0}
      className={className}
      title="Download as Excel"
    >
      <Download className="h-4 w-4" /> {label}
    </Button>
  )
}
