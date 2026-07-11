import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const ADD = '__add__'

interface Props {
  value: string
  onChange: (value: string) => void
  className?: string
}

// UOM picker backed by the `uoms` master. Lists only saved UOMs; the user can
// add a new one inline, which is persisted and then becomes selectable.
export function UomSelect({ value, onChange, className }: Props): React.JSX.Element {
  const [uoms, setUoms] = useState<Row[]>([])
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const list = await window.api.data.list('uoms')
    setUoms(list.filter((u) => u.active))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function addUom(): Promise<void> {
    const name = draft.trim().toUpperCase()
    if (!name) return
    if (uoms.some((u) => String(u.name).toUpperCase() === name)) {
      onChange(name)
      setAdding(false)
      setDraft('')
      return
    }
    setSaving(true)
    try {
      await window.api.data.create('uoms', { name, active: 1 })
      await load()
      onChange(name)
      setAdding(false)
      setDraft('')
      toast.success(`UOM "${name}" added`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (adding) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={draft}
          placeholder="e.g. BAG"
          className={className}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addUom()
            }
            if (e.key === 'Escape') setAdding(false)
          }}
        />
        <Button type="button" size="icon" className="h-9 w-9 shrink-0" onClick={addUom} disabled={saving}>
          <Check className="h-4 w-4" />
        </Button>
        <Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" onClick={() => setAdding(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  return (
    <Select
      value={value || ''}
      onValueChange={(v) => (v === ADD ? (setDraft(''), setAdding(true)) : onChange(v))}
    >
      <SelectTrigger className={className}>
        <SelectValue placeholder="Select UOM" />
      </SelectTrigger>
      <SelectContent>
        {uoms.map((u) => (
          <SelectItem key={u.id} value={String(u.name)}>
            {u.name}
          </SelectItem>
        ))}
        <SelectItem value={ADD} className="text-primary">
          <span className="inline-flex items-center gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add new UOM…
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  )
}
