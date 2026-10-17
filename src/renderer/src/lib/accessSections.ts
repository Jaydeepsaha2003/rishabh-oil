// THE PARTS OF A PAGE THAT CAN BE GRANTED ON THEIR OWN.
// -----------------------------------------------------------------------------
// Shared by the screens (the User Access grid, the Accounting page) and the
// server's write gate — kept free of imports so the main process can read it
// too, and so there is exactly one list for all of them to agree on.
//
// ACCOUNTING, section by section. Every voucher type and every screen on the
// Accounting page is a row of its own on User Access. The Accounting page
// looks each of its screens and voucher types up HERE by a typed map (see
// SCREEN_SECTION / VCH_SECTION in Accounts.tsx), so a screen added later will
// not compile until it is given a key in this list — and once it is, it has
// its own row on the grid automatically. That is how a future menu cannot be
// left out of the controls.
//
// A section with no setting of its own follows the Accounting row. So every
// user granted Accounting before this list existed keeps exactly what they
// had; tightening one person is unticking the section on their row.
export const ACCOUNTS_SECTIONS = [
  { key: 'accountsPayment', label: 'Accounting · Payment voucher' },
  { key: 'accountsReceipt', label: 'Accounting · Receipt voucher' },
  { key: 'accountsContra', label: 'Accounting · Contra voucher' },
  { key: 'accountsJournal', label: 'Accounting · Journal voucher' },
  { key: 'accountsSalesVch', label: 'Accounting · Sales voucher' },
  { key: 'accountsPurchaseVch', label: 'Accounting · Purchase voucher' },
  { key: 'accountsDebitNote', label: 'Accounting · Debit Note' },
  { key: 'accountsCreditNote', label: 'Accounting · Credit Note' },
  { key: 'accountsDaybook', label: 'Accounting · Day Book' },
  { key: 'accountsLedgers', label: 'Accounting · Ledgers' },
  { key: 'accountsTrial', label: 'Accounting · Trial Balance' },
  { key: 'accountsPurchReg', label: 'Accounting · Purchase Register' },
  { key: 'accountsSalesReg', label: 'Accounting · Sales Register' },
  { key: 'accountsNotesReg', label: 'Accounting · Dr / Cr Notes register' },
  { key: 'accountsFrInward', label: 'Accounting · Fr. Inward Working' },
  { key: 'accountsFrOutward', label: 'Accounting · Fr. Outward Working' },
  { key: 'accountsOpenings', label: 'Accounting · Opening Balances' },
  { key: 'accountsMasters', label: 'Accounting · Masters (ledgers & groups)' },
  { key: 'accountsTallyImport', label: 'Accounting · Tally file updation' },
  { key: 'accountsCashflow', label: 'Accounting · Cashflow Register' },
  { key: 'accountsPayReg', label: 'Accounting · Payment / Receipt Register' }
] as const

export type AccountsSectionKey = (typeof ACCOUNTS_SECTIONS)[number]['key']

// Which section each voucher type is. The voucher type is also how the server
// decides which grant a posted voucher answers to.
export const VOUCHER_SECTION: Record<string, AccountsSectionKey> = {
  CONTRA: 'accountsContra',
  PAYMENT: 'accountsPayment',
  RECEIPT: 'accountsReceipt',
  JOURNAL: 'accountsJournal',
  SALE: 'accountsSalesVch',
  PURCHASE: 'accountsPurchaseVch',
  'DEBIT NOTE': 'accountsDebitNote',
  'CREDIT NOTE': 'accountsCreditNote'
}

// A section falls back to the page it belongs to when it has no grant of its
// own. Treasury's three were the first; Accounting's follow the same rule.
export const SECTION_PARENT: Record<string, string> = {
  treasuryLc: 'treasury',
  treasuryBd: 'treasury',
  treasuryTracker: 'treasury',
  ...Object.fromEntries(ACCOUNTS_SECTIONS.map((s) => [s.key, 'accounts']))
}

export const isSectionKey = (key: string): boolean => key in SECTION_PARENT
