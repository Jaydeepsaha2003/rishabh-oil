import { useRef, useState } from 'react'
import { Camera, ImageUp, Trash2, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

// A photo field that behaves like one.
//
// It replaces a bare <input type="file">, which gave a grey "Choose File"
// button and the words "No file chosen" — no idea what was allowed, no idea
// how big was too big, and once a file WAS chosen, nothing but its name to say
// whether the right thing had been picked. For a weighment slip, where the
// point is that somebody can read the figure on it later, that is the wrong
// control.
//
// Deliberately a <div>, not a <label>. The tanker drawer styles every control
// inside it, and one of those rules is [&_label]:!uppercase — which caught the
// whole drop zone and set it shouting. A div with a click handler does the
// same job and is not something a form's label rule can reach.

const MAX_BYTES = 2 * 1024 * 1024

export const PHOTO_MAX_BYTES = MAX_BYTES

export function prettyBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(b >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  if (b >= 1024) return `${Math.round(b / 1024)} KB`
  return `${b} B`
}

/**
 * Checks a picked file before anything is done with it.
 * Returns a sentence to show the user, or null when it is fine.
 */
export function checkPhoto(file: File): string | null {
  if (!file.type.startsWith('image/')) {
    return `That is a ${file.type || 'file'}, not a picture. Photograph the slip, or scan it as a JPG or PNG.`
  }
  if (file.size > MAX_BYTES) {
    return `That photo is ${prettyBytes(file.size)} — the limit is 2 MB. Most phones can send a smaller copy.`
  }
  return null
}

export function PhotoUpload({
  label,
  value,
  onPick,
  onClear,
  disabled,
  busy
}: {
  label: string
  /** The stored data URL, if one has been kept. */
  value?: string
  onPick: (file: File) => void
  onClear: () => void
  disabled?: boolean
  busy?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function take(file: File | undefined): void {
    if (!file) return
    const problem = checkPhoto(file)
    setErr(problem)
    if (problem) return
    onPick(file)
  }

  const picker = (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      disabled={disabled}
      className="hidden"
      onChange={(e) => { take(e.target.files?.[0]); e.target.value = '' }}
    />
  )

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[10.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">{label}</span>

      {value ? (
        // Attached: a thumbnail small enough to sit on one row, but still large
        // enough to tell at a glance that the slip — and not the floor — was
        // photographed. Click it to replace.
        <div className="flex h-[46px] items-center gap-2.5 rounded-[4px] border border-[#BFE3CB] bg-[#F7FBF4] px-2">
          <img
            src={value}
            alt={label}
            title="Click to replace"
            onClick={() => !disabled && ref.current?.click()}
            className="h-[34px] w-[34px] shrink-0 cursor-pointer rounded-[3px] border border-[#BFE3CB] object-cover"
          />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold normal-case text-[#0B6B45]">
            Slip attached
          </span>
          <button
            type="button"
            title="Remove this photo"
            disabled={disabled}
            onClick={() => { setErr(null); onClear() }}
            className="shrink-0 rounded-[3px] p-1.5 text-[#8C2F26] hover:bg-[#FDF3F2]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          onClick={() => !disabled && ref.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              if (!disabled) ref.current?.click()
            }
          }}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]) }}
          className={cn(
            'flex h-[46px] cursor-pointer items-center justify-center gap-2 rounded-[4px] border border-dashed px-3 transition-colors',
            over ? 'border-[#0B6B45] bg-[#EFF5EC]' : 'border-[#C3D2C6] bg-[#FBFDFA] hover:bg-[#F7FAF6]',
            disabled && 'pointer-events-none opacity-60'
          )}
        >
          {busy ? (
            <span className="text-[12.5px] font-bold normal-case text-[#5A6B62]">Working on it…</span>
          ) : (
            <>
              {over ? (
                <ImageUp className="h-4 w-4 shrink-0 text-[#0B6B45]" />
              ) : (
                <Camera className="h-4 w-4 shrink-0 text-[#5A6B62]" />
              )}
              <span className="truncate text-[12.5px] font-bold normal-case text-[#0A1F17]">
                {over ? 'Drop it here' : 'Drag or upload'}
              </span>
              {/* The cap is on the control, not in a sentence under it — the
                  one thing worth knowing before you pick, in the space of two
                  words. */}
              {!over && (
                <span className="shrink-0 rounded-[2px] border border-[#DCE7DB] bg-[#EAF0E9] px-[5px] py-[1px] text-[10.5px] font-bold normal-case text-[#5A6B62]">
                  2 MB
                </span>
              )}
            </>
          )}
        </div>
      )}
      {picker}
      {err && (
        <span className="flex items-start gap-1.5 rounded-[3px] border border-[#F0AFAA] bg-[#FDF3F2] px-2 py-1.5">
          <TriangleAlert className="mt-[1px] h-3.5 w-3.5 shrink-0 text-[#B3261E]" />
          <span className="text-[11.5px] font-semibold normal-case leading-[1.45] text-[#8C2F26]">{err}</span>
        </span>
      )}
    </div>
  )
}
