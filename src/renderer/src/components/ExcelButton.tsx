import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { exportRowsToExcel, type ExcelColumn, type ExcelSheet } from '@/lib/excel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A consistent "Excel" download button used across list/register pages.
export function ExcelButton({
  filename,
  sheetName,
  title,
  subtitle,
  columns,
  rows,
  extraSheets,
  isGroup,
  outlineDetail,
  freezeCols,
  totalLabel,
  label = 'Excel',
  disabled,
  className
}: {
  filename: string
  sheetName?: string
  title?: string
  subtitle?: string
  columns: ExcelColumn[]
  rows: Row[]
  extraSheets?: ExcelSheet[]
  isGroup?: (row: Row) => boolean
  outlineDetail?: boolean
  freezeCols?: number
  totalLabel?: string
  label?: string
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  async function onClick(): Promise<void> {
    try {
      await exportRowsToExcel({ filename, sheetName, title, subtitle, columns, rows, extraSheets, isGroup, outlineDetail, freezeCols, totalLabel })
      toast.success(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to Excel`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return (
    <Button
      size="icon"
      onClick={onClick}
      disabled={disabled || rows.length === 0}
      // Icon-only, in dark green — the download intent reads from the glyph, and
      // the label survives as the tooltip so a page that names its export
      // something specific ("Excel", "LC register"…) still says so on hover.
      className={cn('h-9 w-9 bg-emerald-700 text-white shadow-sm hover:bg-emerald-800', className)}
      title={label === 'Excel' ? 'Download as Excel' : `Download ${label} as Excel`}
      aria-label={label === 'Excel' ? 'Download as Excel' : `Download ${label} as Excel`}
    >
      <Download className="h-4 w-4" />
    </Button>
  )
}
