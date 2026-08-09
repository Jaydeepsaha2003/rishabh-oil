// Shared option lists used across master forms.

// Business/entity types (India), A→Z with "Other" last. value === label so
// existing free-text values that match still display correctly.
export const COMPANY_TYPES: { value: string; label: string }[] = [
  { value: 'Co-operative Society', label: 'Co-operative Society' },
  { value: 'Government / PSU', label: 'Government / PSU' },
  { value: 'HUF', label: 'HUF' },
  { value: 'Individual', label: 'Individual' },
  { value: 'LLP', label: 'LLP' },
  { value: 'One Person Company', label: 'One Person Company (OPC)' },
  { value: 'Partnership Firm', label: 'Partnership Firm' },
  { value: 'Private Limited', label: 'Private Limited' },
  { value: 'Proprietorship', label: 'Proprietorship' },
  { value: 'Public Limited', label: 'Public Limited' },
  { value: 'Society', label: 'Society' },
  { value: 'Trust', label: 'Trust' },
  { value: 'Other', label: 'Other' }
]

// Whether a party's business is Trading (buys/sells the same goods) or
// Manufacturing (processes goods). Existing suppliers/transporters default to
// Manufacturing (the historical assumption); new ones can pick either.
export const BUSINESS_TYPES: { value: string; label: string }[] = [
  { value: 'Manufacturing', label: 'Manufacturing' },
  { value: 'Trading', label: 'Trading' }
]
