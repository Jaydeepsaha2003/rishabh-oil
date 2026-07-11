// Shared option lists used across master forms.

// Business/entity types (India). value === label so existing free-text values
// that match still display correctly.
export const COMPANY_TYPES: { value: string; label: string }[] = [
  { value: 'Proprietorship', label: 'Proprietorship' },
  { value: 'Partnership Firm', label: 'Partnership Firm' },
  { value: 'Private Limited', label: 'Private Limited' },
  { value: 'Public Limited', label: 'Public Limited' },
  { value: 'LLP', label: 'LLP' },
  { value: 'One Person Company', label: 'One Person Company (OPC)' },
  { value: 'HUF', label: 'HUF' },
  { value: 'Individual', label: 'Individual' },
  { value: 'Trust', label: 'Trust' },
  { value: 'Society', label: 'Society' },
  { value: 'Co-operative Society', label: 'Co-operative Society' },
  { value: 'Government / PSU', label: 'Government / PSU' },
  { value: 'Other', label: 'Other' }
]
