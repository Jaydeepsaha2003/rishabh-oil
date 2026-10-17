import { useState } from 'react'
import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
  className,
  prepare,
  ask
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
  // Extra sheets that need fetching first — read at the moment of the click,
  // so the page does not have to load them for a download nobody asked for.
  prepare?: (choice?: string) => Promise<ExcelSheet[]>
  // A QUESTION BEFORE THE DOWNLOAD. When given, the click asks it first and
  // hands the answer to prepare — e.g. readings row-wise or column-wise.
  ask?: { title: string; note?: string; options: { value: string; label: string; hint?: string }[] }
}): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  async function onClick(choice?: string): Promise<void> {
    try {
      const more = prepare ? await prepare(choice) : []
      await exportRowsToExcel({
        filename,
        sheetName,
        title,
        subtitle,
        columns,
        rows,
        extraSheets: [...(extraSheets || []), ...more],
        isGroup,
        outlineDetail,
        freezeCols,
        totalLabel
      })
      toast.success(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to Excel`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return (
    <>
    <Button
      size="icon"
      onClick={() => (ask ? setAsking(true) : void onClick())}
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
    {ask && (
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent readOnly className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-bold">{ask.title}</DialogTitle>
          </DialogHeader>
          {ask.note && <p className="-mt-1 text-[12.5px] text-muted-foreground">{ask.note}</p>}
          <div className="grid gap-2">
            {ask.options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  setAsking(false)
                  void onClick(o.value)
                }}
                className="rounded-[4px] border border-[#C3D2C6] bg-white px-3.5 py-3 text-left hover:border-[#0B3D2E] hover:bg-[#F4FBF6]"
              >
                <div className="text-[13px] font-extrabold text-[#0A1F17]">{o.label}</div>
                {o.hint && <div className="mt-0.5 text-[11.5px] font-medium leading-[1.45] text-[#5A6B62]">{o.hint}</div>}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    )}
    </>
  )
}
