import { Droplets, Loader2 } from 'lucide-react'

const BACKDROP = 'linear-gradient(120deg, #0f172a, #b45309, #0f172a, #1e293b)'

export function LoadingSplash({ name }: { name?: string }): React.JSX.Element {
  const first = name ? name.split(' ')[0] : ''
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden">
      <div
        className="absolute inset-0 animate-gradient-shift bg-[length:200%_200%]"
        style={{ backgroundImage: BACKDROP }}
      />
      <div className="relative flex flex-col items-center">
        <div className="flex h-16 w-16 animate-float items-center justify-center rounded-2xl bg-amber-500 text-white shadow-lg">
          <Droplets className="h-8 w-8" />
        </div>
        <div className="mt-6 flex items-center gap-2 text-white/90">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Setting up your workspace{first ? `, ${first}` : ''}…</span>
        </div>
      </div>
    </div>
  )
}
