# Business rules captured in the foundation

- Every commercial percentage, threshold, margin and fee is stored as versioned configuration; none belongs in application constants.
- A `PricingSnapshot` records inputs, output, rule version, exchange rate and final amount for a financial operation.
- Stock and supplier orders remain distinct: inventory costs and minimum sale price do not use the supplier RMB formula.
- Supplier orders retain the exact CNY price, RMB/BRL exchange rate and observation time through their pricing snapshot.
- Inventory state, payment state, order state and trade state are independent state machines. Client-side confirmation is never authoritative.
- KYC files are represented by private storage keys, never document blobs in database records.
- Administrative overrides, financial actions and state changes require an audit record in the API layer.
